import { beforeAll, afterAll, describe, expect, it } from "vitest";
import { Database, WorkflowStore } from "@humanos/database";
import { createDefaultCatalog } from "@humanos/workflows";
import { createWorkflowService } from "../src/workflows/service.js";
import { createWorkflowScheduler, createPinnedSchedule, revisePinnedSchedule } from "../src/workflows/scheduler.js";
import { createScheduledRunSnapshot } from "../src/workflows/run-snapshot.js";
import type { WorkflowRun, WorkflowSchedule } from "@humanos/schemas";

const schema = `test_workflow_scheduler_${Date.now()}`;
const db = new Database(process.env.TEST_DATABASE_URL ?? "postgresql://saikarthik@127.0.0.1:55432/humanos", { schema });
const store = new WorkflowStore(db), registry = createDefaultCatalog();
const actor = { accountId: "11155111:0x1111111111111111111111111111111111111111", rootId: null };
const service = createWorkflowService({ newWorkflowAuthority: "account", /* Legacy account-workflow fixture. */ db, store, registry,
  selector: { async select(input) { return { selectedCandidateId: input.candidates.find(c => c.type === (input.history?.length ? "complete" : "content.generate"))!.id,
    parameters: {}, confidence: 1, alignment: 1, risk: 0, injection: 0, needsReview: false, reasonCodes: [] }; } },
  assemblyInput: async (goal) => ({ allowedCapabilities: [], inputs: { "content.generate": { value: { brief: { instruction: goal, context: {}, outputSchema: "text", maxCharacters: 100 } } } } }),
});
beforeAll(async () => {
  await db.migrate();
  await db.insert("accounts", { id: actor.accountId, address: "0x1111111111111111111111111111111111111111", chainId: 11155111, createdAt: new Date().toISOString() });
});
afterAll(async () => { await db.query(`DROP SCHEMA "${schema}" CASCADE`); await db.close(); });
async function activated() {
  const draft = await service.createDraft(actor, null, "Write a greeting");
  const assembled = await service.assemble(actor, draft.workflow.id);
  const version = assembled.versions.at(-1)!;
  await service.activate(actor, draft.workflow.id, version.id, version.graphHash);
  const detail = await service.detail(actor, draft.workflow.id);
  return { workflow: detail.workflow, version: detail.versions.at(-1)! };
}
async function scheduled(kind: "once" | "recurring" = "recurring") {
  const { workflow, version } = await activated();
  const definition = kind === "once" ? { kind: "once" as const, fireAt: "2026-10-01T00:00:00.000Z", timezone: "UTC" }
    : { kind: "recurring" as const, expression: "0 9 * * *", timezone: "UTC" };
  const schedule = createPinnedSchedule(workflow, version, definition, new Date("2026-09-29T00:00:00.000Z"));
  await store.saveSchedule(schedule);
  return schedule;
}

describe("workflow scheduler", () => {
  it("creates a pinned run once across duplicate and restarted ticks", async () => {
    const schedule = await scheduled("once");
    const scheduler = createWorkflowScheduler({ store, registry });
    expect(await scheduler.tick(new Date("2026-10-01T00:01:00.000Z"))).toBe(1);
    expect(await scheduler.tick(new Date("2026-10-01T00:01:00.000Z"))).toBe(0);
    expect(await createWorkflowScheduler({ store, registry }).tick(new Date("2026-10-01T00:01:00.000Z"))).toBe(0);
    const runs = (await store.list<WorkflowRun>("workflow_runs")).filter(r => r.workflowId === schedule.workflowId);
    expect(runs).toHaveLength(1);
    expect(runs[0]).toMatchObject({ workflowVersionId: schedule.workflowVersionId, triggerKind: "once", status: "QUEUED" });
    expect((await store.get<WorkflowSchedule>("workflow_schedules", schedule.id))?.status).toBe("COMPLETED");
  });
  it("records missed ticks and skips overlap without duplicate runs", async () => {
    const schedule = await scheduled();
    const scheduler = createWorkflowScheduler({ store, registry });
    expect(await scheduler.tick(new Date("2026-10-01T09:01:00.000Z"))).toBe(1);
    expect(await scheduler.tick(new Date("2026-10-01T09:01:00.000Z"))).toBe(0);
    expect(await scheduler.tick(new Date("2026-10-02T09:01:00.000Z"))).toBe(0);
    expect((await store.list<WorkflowRun>("workflow_runs")).filter(r => r.workflowId === schedule.workflowId)).toHaveLength(1);
    expect((await store.get<WorkflowSchedule>("workflow_schedules", schedule.id))?.nextFireAt).toBe("2026-10-03T09:00:00.000Z");
  });
  it("advances an occurrence left due by a crash between insert and schedule update", async () => {
    const schedule = await scheduled("once");
    const workflow = (await store.get("workflows", schedule.workflowId)) as Awaited<ReturnType<typeof activated>>["workflow"];
    const version = (await store.get("workflow_versions", schedule.workflowVersionId)) as Awaited<ReturnType<typeof activated>>["version"];
    const snapshot = createScheduledRunSnapshot(workflow, version, schedule, schedule.nextFireAt!, "2026-10-01T00:00:00.000Z");
    expect(await store.createOccurrence(schedule.id, schedule.nextFireAt!, snapshot.run, snapshot.steps)).toBe(true);
    expect(await createWorkflowScheduler({ store, registry }).tick(new Date("2026-10-01T00:01:00.000Z"))).toBe(0);
    expect((await store.get<WorkflowSchedule>("workflow_schedules", schedule.id))?.status).toBe("COMPLETED");
    expect((await store.list<WorkflowRun>("workflow_runs")).filter(r => r.workflowId === schedule.workflowId)).toHaveLength(1);
  });
  it("does not execute cancelled schedules", async () => {
    const schedule = await scheduled();
    await store.compareAndSwapSchedule(schedule, revisePinnedSchedule(schedule, { status: "CANCELLED" }, new Date("2026-09-30T00:00:00.000Z")));
    expect(await createWorkflowScheduler({ store, registry }).tick(new Date("2026-10-01T09:01:00.000Z"))).toBe(0);
    expect((await store.list<WorkflowRun>("workflow_runs")).filter(r => r.workflowId === schedule.workflowId)).toHaveLength(0);
  });
  it("updates a pinned schedule with CAS and rejects stale edits even at the same timestamp", async () => {
    const schedule = await scheduled();
    const at = new Date(schedule.updatedAt);
    const revised = revisePinnedSchedule(schedule, { definition: { kind: "recurring", expression: "30 10 * * *", timezone: "UTC" } }, at);
    await store.compareAndSwapSchedule(schedule, revised);
    expect((await store.get<WorkflowSchedule>("workflow_schedules", schedule.id))?.nextFireAt).toBe("2026-09-29T10:30:00.000Z");
    await expect(store.compareAndSwapSchedule(schedule, revisePinnedSchedule(schedule, { status: "CANCELLED" }, at))).rejects.toThrow("SCHEDULE_CONFLICT");
    expect((await store.get<WorkflowSchedule>("workflow_schedules", schedule.id))?.status).toBe("ACTIVE");
  });
  it("recovers only due waits and retries, not human pauses", async () => {
    const { workflow } = await activated();
    const detail = await service.runNow(actor, workflow.id, {});
    const due = { ...detail.run, status: "WAITING" as const, nextResumeAt: "2026-09-30T00:00:00.000Z", revision: 1 };
    await store.compareAndSwapRun(detail.run.id, 0, due, { id: "wait-event", runId: detail.run.id, stepRunId: null, sequence: 1, type: "run.waiting", data: {}, createdAt: "2026-09-29T00:00:00.000Z" });
    const recovered = await createWorkflowScheduler({ store, registry }).recover(new Date("2026-10-01T00:00:00.000Z"));
    expect(recovered.retries).toBe(1);
    expect((await store.get<WorkflowRun>("workflow_runs", detail.run.id))?.status).toBe("QUEUED");
  });
  it("leaves human and unknown pauses untouched during recovery", async () => {
    const { workflow } = await activated();
    const detail = await service.runNow(actor, workflow.id, {});
    await store.compareAndSwapRun(detail.run.id, 0, { ...detail.run, status: "INPUT_REQUIRED", revision: 1, nextResumeAt: "2026-09-30T00:00:00.000Z" },
      { id: "human-pause-event", runId: detail.run.id, stepRunId: null, sequence: 1, type: "run.input_required", data: {}, createdAt: "2026-09-29T00:00:00.000Z" });
    const result = await createWorkflowScheduler({ store, registry }).recover(new Date("2026-10-01T00:00:00.000Z"));
    expect(result.retries).toBe(0);
    expect((await store.get<WorkflowRun>("workflow_runs", detail.run.id))?.status).toBe("INPUT_REQUIRED");
  });
});
