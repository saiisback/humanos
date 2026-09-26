import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { Database, WorkflowStore } from "@humanos/database";
import { createDefaultCatalog } from "@humanos/workflows";
import { classifyWorkflowGoal, workflowInputs } from "../src/workflows/bindings.js";
import { createWorkflowService } from "../src/workflows/service.js";

describe("hotel clarification routing", () => {
  it("asks for missing hotel details without creating restaurant or external action steps", () => {
    const goal = "Book a hotel in Tokyo";
    const intent = classifyWorkflowGoal(goal);
    expect(intent.kind).toBe("clarify");
    expect(intent.prompt).toMatch(/check.?in/i);
    expect(intent.prompt).not.toMatch(/table booking|party size|cuisine/i);
    const input = workflowInputs(goal);
    expect(input.completionSequence).toEqual(["human.input"]);
    expect(input.allowedCapabilities).toEqual([]);
    expect(input.inputs["browser.submit"]).toBeUndefined();
  });

  it("keeps a complete hotel request unsupported instead of converting it to a restaurant booking", () => {
    const intent = classifyWorkflowGoal(`Book a hotel
City: Tokyo
Check-in: 2030-10-02
Check-out: 2030-10-03
Guests: 2
Rooms: 1
Budget: JPY 20000 per night
Guest name: Ada Lovelace
Email: ada@example.com`);
    expect(intent.kind).toBe("clarify");
    expect(intent.prompt).toMatch(/hotel/i);
    expect(intent.prompt).toMatch(/not.*(?:supported|installed|connected)|no.*hotel|unsupported/i);
    expect(intent.blocks).toEqual(["human.input"]);
    expect(intent.destination).toBeUndefined();
  });

  it("preserves hotel research and draft-only requests", () => {
    expect(classifyWorkflowGoal("Research hotels in Tokyo").kind).toBe("research");
    expect(classifyWorkflowGoal("Draft a hotel reservation inquiry. Draft only.").kind).toBe("draft");
    expect(workflowInputs("Do not book a hotel. Research hotels in Tokyo").allowedCapabilities).toEqual(["web.search"]);
  });
});

describe("saved hotel dates", () => {
  const schema = `test_hotel_intake_${Date.now()}`;
  const db = new Database(process.env.TEST_DATABASE_URL ?? "postgresql://saikarthik@127.0.0.1:55432/humanos", { schema });
  const store = new WorkflowStore(db);
  const actor = { accountId: "11155111:0x1111111111111111111111111111111111111111", rootId: null };
  const service = createWorkflowService({ db, store, registry: createDefaultCatalog(),
    selector: { select: async () => { throw new Error("No model call needed for saving"); } },
    assemblyInput: async goal => workflowInputs(goal),
  });
  beforeAll(async () => {
    await db.migrate();
    await db.insert("accounts", { id: actor.accountId, address: "0x1111111111111111111111111111111111111111", chainId: 11155111, createdAt: new Date().toISOString() });
  });
  afterEach(() => vi.useRealTimers());
  afterAll(async () => { await db.query(`DROP SCHEMA "${schema}" CASCADE`); await db.close(); });

  it("pins today and tomorrow at save time in Tokyo and retains them across later refinement", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2030-09-26T16:00:00.000Z"));
    const original = "Book a hotel in Tokyo from today to tomorrow";
    const draft = await service.createDraft(actor, null, original);
    const saved = draft.versions.at(-1)!.goal;
    expect(saved).toContain(original);
    expect(saved).toContain("2030-09-27");
    expect(saved).toContain("2030-09-28");
    vi.setSystemTime(new Date("2030-09-27T16:00:00.000Z"));
    const refined = await service.refine(actor, draft.workflow.id, saved);
    expect(refined.versions).toHaveLength(2);
    expect(refined.versions[0]!.goal).toBe(saved);
    expect(refined.versions.at(-1)!.goal).toBe(saved);
    expect(refined.versions.at(-1)!.graph.nodes).toEqual([]);
    expect(refined.versions.at(-1)!.requiredCapabilities).toEqual([]);
    await expect(service.refine({ accountId: "other", rootId: null }, draft.workflow.id, saved)).rejects.toThrow("NOT_FOUND");
  });

  it("canonicalizes newly supplied relative dates on refinement and leaves ordinary goals unchanged", async () => {
    const goal = "Draft a greeting for tomorrow";
    const draft = await service.createDraft(actor, null, goal);
    expect(draft.versions.at(-1)!.goal).toBe(goal);
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2030-09-26T16:00:00.000Z"));
    const refined = await service.refine(actor, draft.workflow.id, "Book a hotel in Tokyo from today to tomorrow");
    expect(refined.versions.at(-1)!.goal).toContain("2030-09-27");
    expect(refined.versions.at(-1)!.goal).toContain("2030-09-28");
  });
});
