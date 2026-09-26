import { expect, it, vi } from "vitest";
import { updateRestaurantDetails, type BrowserWorkerResult } from "@humanos/schemas";
import { workflowInputs } from "../src/workflows/bindings.js";
import { createBrowserUsePolicyRegistry } from "../src/workflows/browser-use-policy.js";
import { createBrowserUseStep } from "../src/workflows/browser-use-step.js";
import type { StepExecutionContext } from "../src/workflows/types.js";
import type { BrowserUseClient } from "../src/workflows/browser-use-client.js";

const goal = updateRestaurantDetails("Prepare a table reservation. Do not book until final review.", {
  siteId: "tablecheck-brooklyn-parlor", venueId: "brooklynparlor-shinjuku", date: "2099-09-28", time: "19:00", timezone: "Asia/Tokyo",
  adults: "2", children: "0", guestFirstName: "Ada", guestLastName: "Lovelace", phone: "+819999999999", email: "ada@example.com",
  allergies: "none", offerId: "66c4d4411c588898fe3bb84b", intent: "book",
});
const policies = createBrowserUsePolicyRegistry();
const routing = { browserUsePolicies: policies, browserUseEnabled: true };

it.each(["book", "prepare"])("routes %s to read-only preparation without guest disclosure or write permissions", intent => {
  const input = workflowInputs(updateRestaurantDetails(goal, { intent }), routing);
  expect(input.completionSequence).toEqual(["browser.availability"]);
  expect(input.allowedCapabilities).toEqual(["web.search"]);
  expect(input.inputs["browser.availability"]).toEqual({ value: { destination: "browser-use:tablecheck-brooklyn-parlor", payload: {
    date: "2099-09-28", time: "19:00", timezone: "Asia/Tokyo", adults: "2", children: "0", offer_id: "66c4d4411c588898fe3bb84b",
  } } });
  expect(JSON.stringify(input.inputs)).not.toContain("ada@example.com");
  expect(policies.get("tablecheck-brooklyn-parlor")?.supportsSubmission).toBe(false);
});

function setup(mode: "account" | "ens", maliciousPrepared = false) {
  const commands: string[] = [];
  const client: BrowserUseClient = { sessionId: "bus-1", revision: 0, nextActionId: 1, alive: true, close: async () => { commands.push("close"); },
    async request(request) {
      commands.push(request.command);
      const envelope = { protocolVersion: 1, accountId: "a", runId: "r", sessionId: "bus-1", actionId: commands.length, observationRevision: 0 };
      return (request.command === "start"
        ? { ...envelope, status: "ready", payload: { runtime: { name: "browser-use", version: "0.13.10" }, policyId: "tablecheck-brooklyn-parlor", origin: "https://www.tablecheck.com", profile: "dedicated" } }
        : maliciousPrepared ? { ...envelope, status: "prepared", payload: {} }
        : { ...envelope, status: "handoff", payload: { reason: "UNSUPPORTED_EFFECT", message: "Requested slot available when checked. Not booked." } }) as unknown as BrowserWorkerResult;
    } };
  const authorize = vi.fn(async () => true);
  const dispatchConfirmed = vi.fn();
  const step = createBrowserUseStep({ client: () => client, policies, authorize, confirmations: { dispatchConfirmed },
    store: { getValue: async () => null, saveValue: async () => "checkpoint" } as never });
  const context = { actor: { accountId: "a", rootId: "root" }, run: { id: "r", authorityMode: mode, agentBindingId: mode === "ens" ? "binding" : null },
    version: { browserFallbackAllowed: true }, step: { id: "s" }, node: { id: "n" },
    input: { destination: "browser-use:tablecheck-brooklyn-parlor", payload: { date: "2099-09-28", time: "19:00", timezone: "Asia/Tokyo", adults: "2", children: "0", offer_id: "66c4d4411c588898fe3bb84b" } },
    signal: new AbortController().signal } as unknown as StepExecutionContext;
  return { step, context, commands, authorize, dispatchConfirmed };
}

it("does not open a browser through an account-only reservation run", async () => {
  const h = setup("account");
  await expect(h.step.prepare(h.context)).rejects.toMatchObject({ errorClass: "AUTHORIZATION" });
  expect(h.commands).toEqual([]);
});

it("checks ENS authorization before each preparation operation and never creates a submission preview", async () => {
  const h = setup("ens");
  const result = await h.step.availability.execute(h.context);
  expect(result.output).toEqual({ text: "Requested slot available when checked. Not booked.", booked: false });
  expect(h.commands).toEqual(["start", "prepare", "close"]);
  expect(h.authorize).toHaveBeenCalledTimes(3);
  expect(h.dispatchConfirmed).not.toHaveBeenCalled();
});

it("requires the same live authority for the read-only executor", async () => {
  const h = setup("account");
  await expect(h.step.availability.execute(h.context)).rejects.toMatchObject({ errorClass: "AUTHORIZATION" });
  expect(h.commands).toEqual([]);
});

it("refuses unexpected prepared output from a preparation-only worker", async () => {
  const h = setup("ens", true);
  await expect(h.step.executor.execute(h.context)).rejects.toMatchObject({ errorClass: "VALIDATION" });
  expect(h.commands).not.toContain("submit");
  expect(h.dispatchConfirmed).not.toHaveBeenCalled();
});
