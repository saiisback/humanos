import { describe, expect, it, vi } from "vitest";
import { hashCanonical, type BrowserWorkerResult } from "@humanos/schemas";
import { assembleWorkflow, createDefaultCatalog } from "@humanos/workflows";
import { classifyWorkflowGoal, workflowInputs, type GoalRoutingContext } from "../src/workflows/bindings.js";
import { BrowserUsePolicyRegistry } from "../src/workflows/browser-use-policy.js";
import { createBrowserUseStep } from "../src/workflows/browser-use-step.js";
import type { BrowserUseClient, BrowserUseRequest } from "../src/workflows/browser-use-client.js";
import type { StepExecutionContext } from "../src/workflows/types.js";

// Test-only fixture policy; production registries stay empty.
const policies = new BrowserUsePolicyRegistry({ allowFixtures: true });
policies.register({ id: "fixture-restaurant", label: "Controlled fixture restaurant (test only)", origin: "http://fixture.humanos.test:8123", fixtureOnly: true, fields: [
  { name: "name", label: "Reservation name", maxLength: 80 },
  { name: "party_size", label: "Party size", maxLength: 2, pattern: /^[1-9][0-9]?$/ },
  { name: "email", label: "Contact email", maxLength: 120 },
  { name: "restaurant", label: "Restaurant", maxLength: 200 },
  { name: "date", label: "Date", maxLength: 10 },
  { name: "timezone", label: "Timezone", maxLength: 80 },
] });
const routing: GoalRoutingContext = { browserUsePolicies: policies, browserUseEnabled: true };
const complete = `Book a table please
site: fixture-restaurant
restaurant: Sakura Kitchen
date: 2030-10-02
time: 19:00
timezone: Asia/Tokyo
party size: 2
name: Ada Lovelace
email: ada@example.com`;
const evaluator = { select: async (input: { candidates: { id: string }[] }) => ({ selectedCandidateId: input.candidates[0]!.id, parameters: {}, confidence: 1, alignment: 1, risk: 0, injection: 0, needsReview: false, reasonCodes: [] }) };

describe("booking goal → Browser Use step", () => {
  it("routes an explicit site policy request into a confirm-then-submit graph the Browser Use step accepts", async () => {
    expect(classifyWorkflowGoal(complete, routing)).toMatchObject({ kind: "booking", destination: "browser-use:fixture-restaurant" });
    const inputs = workflowInputs(complete, routing);
    expect(inputs).toMatchObject({ allowedCapabilities: ["application.submit"], browserFallbackAllowed: true });
    const assembled = await assembleWorkflow({ goal: complete, draft: { nodes: [] }, ...inputs }, evaluator, createDefaultCatalog());
    expect(assembled.graph.nodes.map(n => n.type)).toEqual(["human.confirm", "browser.submit"]);
    const node = assembled.graph.nodes[1]!;
    expect(node.input).toEqual({ destination: "browser-use:fixture-restaurant",
      payload: { name: "Ada Lovelace", party_size: "2", email: "ada@example.com", preferred_time: "19:00",
        restaurant: "Sakura Kitchen", date: "2030-10-02", timezone: "Asia/Tokyo" } });

    // Reachability: the assembled node input drives the real step's preparation.
    const commands: string[] = [];
    let action = 1, revision = 0;
    const reply = (status: string, payload: unknown) => ({ protocolVersion: 1, accountId: "a", runId: "r", sessionId: "bus-1", actionId: action++, observationRevision: revision, status, payload }) as unknown as BrowserWorkerResult;
    const client: BrowserUseClient = { sessionId: "bus-1", get revision() { return revision; }, get nextActionId() { return action; }, alive: true, close: async () => {},
      async request(request: BrowserUseRequest) {
        commands.push(request.command);
        if (request.command === "start") return reply("ready", { runtime: { name: "browser-use", version: "0.13.10" }, policyId: "fixture-restaurant", origin: "http://fixture.humanos.test:8123", profile: "dedicated" });
        if (request.command === "observe") { revision++; return reply("observed", { origin: "http://fixture.humanos.test:8123", path: "/book", title: "Book", loginRequired: false, facts: [],
          candidates: [{ id: "select:slot-1900", kind: "select", label: "19:00", targetId: "slot-1900", policyId: "fixture-restaurant", observationRevision: revision }] }); }
        if (request.command === "act") { revision++; return reply("acted", {}); }
        revision++;
        const fields = { ...(request.payload as { fields: Record<string, string> }).fields, slot: "1900" };
        return reply("prepared", { destination: "http://fixture.humanos.test:8123/reserve", fields, material: ["Sakura Kitchen"], value: null, materialHash: hashCanonical(fields) });
      } };
    const step = createBrowserUseStep({ client: () => client, policies, authorize: async () => true,
      confirmations: { dispatchConfirmed: vi.fn() }, store: { saveValue: vi.fn(async () => "x"), list: vi.fn(async () => []), get: vi.fn(async () => null), getValue: vi.fn(async () => null) } as never });
    const prepared = await step.prepare({ actor: { accountId: "a", rootId: null }, run: { id: "r" }, step: { id: "s" },
      version: { browserFallbackAllowed: inputs.browserFallbackAllowed }, node, input: node.input, signal: new AbortController().signal } as unknown as StepExecutionContext);
    expect(commands).toEqual(["start", "observe", "act", "prepare"]);
    expect(prepared.payload).toMatchObject({ fields: { name: "Ada Lovelace", party_size: "2", email: "ada@example.com", slot: "1900" } });
    // preferred_time is a selection hint only; it is never sent to the site.
    expect(prepared.payload.fields).not.toHaveProperty("preferred_time");
  });

  it("asks for exactly the missing or invalid details and plans nothing", () => {
    const intent = classifyWorkflowGoal("Book a table\nsite: fixture-restaurant\ntime: 7pm\nname: Ada", routing);
    expect(intent.kind).toBe("clarify");
    for (const label of ["restaurant", "date (YYYY-MM-DD)", "timezone", "party size", "email"]) expect(intent.prompt).toContain(label);
    expect(intent.prompt).toMatch(/correct time \(HH:MM\)/);
    expect(intent.prompt).toContain("Nothing was booked");
    expect(workflowInputs("Book a table\nsite: fixture-restaurant", routing).allowedCapabilities).toEqual([]);
  });

  it("does not route when the worker is off, the site is not installed, or booking is negated", () => {
    expect(classifyWorkflowGoal(complete, { ...routing, browserUseEnabled: false }).prompt).toMatch(/Browser Use worker is off/);
    const unknown = classifyWorkflowGoal(complete.replace("fixture-restaurant", "other-restaurant"), routing);
    expect(unknown.kind).toBe("clarify");
    expect(unknown.destination).toBeUndefined();
    expect(classifyWorkflowGoal(complete, {}).kind).toBe("clarify");
    expect(classifyWorkflowGoal(`${complete}\nDo not book yet`, routing).kind).not.toBe("booking");
  });
});
