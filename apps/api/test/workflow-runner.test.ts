import { beforeAll, afterAll, it, expect, vi } from "vitest";
import { Database, WorkflowStore } from "@humanos/database";
import { createDefaultCatalog } from "@humanos/workflows";
import { createWorkflowService } from "../src/workflows/service.js";
import { createWorkflowRunner, WorkflowExecutionError } from "../src/workflows/runner.js";
import { ConnectorProviderError } from "../src/workflows/connectors.js";
import { hashCanonical, type WorkflowVersion } from "@humanos/schemas";
import { randomUUID } from "node:crypto";
const schema = `test_workflow_runner_${Date.now()}`;
const db = new Database(
  process.env.TEST_DATABASE_URL ??
    "postgresql://saikarthik@127.0.0.1:55432/humanos",
  { schema },
);
const store = new WorkflowStore(db),
  registry = createDefaultCatalog();
const actor = {
  accountId: "11155111:0x1111111111111111111111111111111111111111",
  rootId: null,
};
const service = createWorkflowService({ newWorkflowAuthority: "account", /* Legacy account-workflow fixture. */
  db,
  store,
  registry,
  selector: {
    async select(input) {
      const type = input.history?.length ? "complete" : "content.generate";
      return {
        selectedCandidateId: input.candidates.find((c) => c.type === type)!.id,
        parameters: {},
        confidence: 1,
        alignment: 1,
        risk: 0,
        injection: 0,
        needsReview: false,
        reasonCodes: [],
      };
    },
  },
  assemblyInput: async (goal) => ({
    allowedCapabilities: [],
    inputs: {
      "content.generate": {
        value: {
          brief: {
            instruction: goal,
            context: {},
            outputSchema: "text",
            maxCharacters: 1000,
          },
        },
      },
    },
  }),
});
beforeAll(async () => {
  await db.migrate();
  await db.insert("accounts", {
    id: actor.accountId,
    address: "0x1111111111111111111111111111111111111111",
    chainId: 11155111,
    createdAt: new Date().toISOString(),
  });
});
afterAll(async () => {
  await db.query(`DROP SCHEMA "${schema}" CASCADE`);
  await db.close();
});
async function queued() {
  const draft = await service.createDraft(actor, null, "Write a greeting");
  const assembled = await service.assemble(actor, draft.workflow.id);
  const version = assembled.versions.at(-1)!;
  await service.activate(
    actor,
    draft.workflow.id,
    version.id,
    version.graphHash,
  );
  return service.runNow(actor, draft.workflow.id, {});
}
it("persists a generated result and does not execute it twice", async () => {
  const detail = await queued();
  const generate = vi.fn(async () => ({
    outputSchema: "text" as const,
    text: "Hello",
  }));
  const runner = createWorkflowRunner({
    store,
    registry,
    content: { generate },
    authorize: async () => true,
    workerId: "test-worker",
  });
  expect(await runner.tick()).toBe(true);
  const result = await service.runDetail(actor, detail.run.id);
  expect(result.run.status).toBe("COMPLETED");
  expect(result.steps[0]!.status).toBe("COMPLETED");
  expect(
    await store.getValue(result.steps[0]!.outputRef!, detail.run.id),
  ).toEqual({ outputSchema: "text", text: "Hello" });
  expect(result.attempts[0]!.completedAt).not.toBeNull();
  expect(await runner.tick()).toBe(false);
  expect(generate).toHaveBeenCalledTimes(1);
});
it("checks authority before invoking even a content executor", async () => {
  const detail = await queued();
  const generate = vi.fn();
  const runner = createWorkflowRunner({
    store,
    registry,
    content: { generate },
    authorize: async () => false,
    workerId: "revoked-worker",
  });
  await runner.tick();
  expect((await service.runDetail(actor, detail.run.id)).run.status).toBe(
    "REVOKED",
  );
  expect(generate).not.toHaveBeenCalled();
});
async function queuedEffect(eventTimeoutMs = 1000) {
  const draft = await service.createDraft(actor, null, "Save a calendar event");
  const version: WorkflowVersion = { ...draft.versions[0]!, graph: { nodes: [
    { id: "confirm", type: "human.confirm", blockVersion: "1.0.0", dependsOn: [], input: {}, capability: null, timeoutMs: 1000, maxAttempts: 1 },
    { id: "event", type: "calendar.create", blockVersion: "1.0.0", dependsOn: ["confirm"], input: { title: "Test", startsAt: "2026-10-01T01:00:00.000Z", endsAt: "2026-10-01T02:00:00.000Z" }, capability: "calendar.create", timeoutMs: eventTimeoutMs, maxAttempts: 3 },
  ] } };
  version.graphHash = hashCanonical(version.graph);
  await store.updateVersion(version);
  await service.activate(actor, draft.workflow.id, version.id, version.graphHash);
  return service.runNow(actor, draft.workflow.id, {});
}
it("does not mistake a completed confirmation node for payload-bound user consent", async () => {
  const detail = await queuedEffect();
  const execute = vi.fn(async () => ({ output: { eventId: "provider-1" } }));
  const runner = createWorkflowRunner({ store, registry, content: { generate: vi.fn() }, workerId: "consent-worker", authorize: async () => true,
    executors: { "human.confirm": { execute: async () => ({ output: { confirmed: true } }) }, "calendar.create": { execute } },
  });
  await runner.tick();
  expect((await service.runDetail(actor, detail.run.id)).run.status).toBe("CONFIRMATION_REQUIRED");
  expect(execute).not.toHaveBeenCalled();
});
it("requires a durable receipt for a dispatched write and never blindly replays it", async () => {
  const detail = await queuedEffect();
  const execute = vi.fn(async () => ({ output: { eventId: "provider-1" } }));
  const runner = createWorkflowRunner({ store, registry, content: { generate: vi.fn() }, workerId: "receipt-worker", authorize: async () => true,
    dispatchConfirmed: async (_context, dispatch) => dispatch(),
    executors: { "human.confirm": { execute: async () => ({ output: { confirmed: true } }) }, "calendar.create": { execute } },
  });
  await runner.tick();
  expect((await service.runDetail(actor, detail.run.id)).run.status).toBe("RECONCILIATION_REQUIRED");
  await expect(service.resume(actor, detail.run.id)).rejects.toThrow("RESUME_NOT_ALLOWED");
  await runner.tick();
  expect(execute).toHaveBeenCalledTimes(1);
});
it("reconciles a write whose provider times out rather than retrying", async () => {
  const detail = await queuedEffect();
  const execute = vi.fn(async () => { throw new WorkflowExecutionError("TIMEOUT"); });
  const runner = createWorkflowRunner({ store, registry, content: { generate: vi.fn() }, workerId: "timeout-worker", authorize: async () => true,
    dispatchConfirmed: async (_context, dispatch) => dispatch(),
    executors: { "human.confirm": { execute: async () => ({ output: { confirmed: true } }) }, "calendar.create": { execute } },
  });
  await runner.tick();
  expect((await service.runDetail(actor, detail.run.id)).run.status).toBe("RECONCILIATION_REQUIRED");
  expect(await runner.tick()).toBe(false);
  expect(execute).toHaveBeenCalledTimes(1);
});
it("classifies an explicit provider validation rejection without reconciliation", async () => {
  const detail = await queuedEffect();
  const execute = vi.fn(async () => { throw new ConnectorProviderError("VALIDATION"); });
  const runner = createWorkflowRunner({ store, registry, content: { generate: vi.fn() }, workerId: "validation-worker", authorize: async () => true,
    dispatchConfirmed: async (_context, dispatch) => dispatch(),
    executors: { "human.confirm": { execute: async () => ({ output: { confirmed: true } }) }, "calendar.create": { execute } },
  });
  await runner.tick();
  const result = await service.runDetail(actor, detail.run.id);
  expect(result.run.status).toBe("FAILED");
  expect(result.steps.find((step) => step.blockId === "event")?.errorClass).toBe("VALIDATION");
  expect(execute).toHaveBeenCalledTimes(1);
});
it.each(["before_attempt", "after_intent", "after_effect", "before_receipt"])("recovers a crash %s without replaying an uncertain effect", async (point) => {
  const detail = await queuedEffect();
  const execute = vi.fn(async (context) => {
    const output = { eventId: "provider-crash-test" };
    return { output, receipt: { id: randomUUID(), runId: context.run.id, stepRunId: context.step.id, executor: "connector" as const,
      destination: "test-calendar", summary: "Test fixture event", requestHash: hashCanonical(context.input), outputHash: hashCanonical(output),
      executedAt: new Date().toISOString(), idempotencyKey: context.idempotencyKey, providerReference: output.eventId, finalUrl: null, successEvidence: "test fixture", metadata: {} } };
  });
  const checkpoint = store.checkpoint.bind(store), recordAttempt = store.recordAttempt.bind(store), updateStep = store.updateStep.bind(store);
  vi.spyOn(store, "updateStep").mockImplementation(async (...args) => {
    if (point === "before_attempt" && args[0].blockId === "event") throw new Error("injected process crash");
    return updateStep(...args);
  });
  vi.spyOn(store, "recordAttempt").mockImplementation(async (...args) => {
    await recordAttempt(...args);
    const step = (await store.list<any>("workflow_steps")).find(s => s.id === args[0].stepRunId);
    if (point === "after_intent" && step.blockId === "event") throw new Error("injected process crash");
  });
  vi.spyOn(store, "checkpoint").mockImplementation(async (...args) => {
    if (["after_effect", "before_receipt"].includes(point) && args[2].blockId === "event") throw new Error("injected process crash");
    return checkpoint(...args);
  });
  const deps = { store, registry, content: { generate: vi.fn() }, workerId: "crash-worker", authorize: async () => true,
    dispatchConfirmed: async (_context: any, dispatch: () => Promise<any>) => dispatch(),
    executors: { "human.confirm": { execute: async () => ({ output: { confirmed: true } }) }, "calendar.create": { execute } },
  };
  try { await expect(createWorkflowRunner(deps).tick()).rejects.toThrow("injected process crash"); }
  finally { vi.restoreAllMocks(); }
  const restarted = createWorkflowRunner({ ...deps, workerId: "restarted-worker" });
  await restarted.recover(new Date(Date.now() + 120000));
  expect((await service.runDetail(actor, detail.run.id)).run.status).toBe("RECONCILIATION_REQUIRED");
  expect(await restarted.tick()).toBe(false);
  expect(execute).toHaveBeenCalledTimes(["after_effect", "before_receipt"].includes(point) ? 1 : 0);
});

function deferred() {
  let release!: () => void;
  const promise = new Promise<void>((resolve) => { release = resolve; });
  return { promise, release };
}
it("never dispatches after cancellation during the final authorization await", async () => {
  const detail = await queued();
  const reached = deferred(), resume = deferred();
  let checks = 0;
  const generate = vi.fn(async () => ({ outputSchema: "text" as const, text: "late" }));
  const runner = createWorkflowRunner({ store, registry, content: { generate }, workerId: "cancel-race-worker",
    authorize: async () => { if (++checks === 3) { reached.release(); await resume.promise; } return true; },
  });
  const tick = runner.tick();
  await reached.promise;
  await service.cancel(actor, detail.run.id);
  resume.release();
  await tick.catch(() => false);
  expect(generate).not.toHaveBeenCalled();
  expect((await service.runDetail(actor, detail.run.id)).run.status).toBe("CANCELLED");
});
it("never dispatches after a timeout during final authorization", async () => {
  const detail = await queuedEffect(100);
  const reached = deferred(), resume = deferred();
  let checks = 0;
  const execute = vi.fn(async () => ({ output: { eventId: "late" } }));
  const runner = createWorkflowRunner({ store, registry, content: { generate: vi.fn() }, workerId: "timeout-auth-worker",
    authorize: async () => { if (++checks === 6) { reached.release(); await resume.promise; } return true; },
    dispatchConfirmed: async (_context, dispatch) => dispatch(),
    executors: { "human.confirm": { execute: async () => ({ output: { confirmed: true } }) }, "calendar.create": { execute } },
  });
  const tick = runner.tick();
  await reached.promise;
  await tick;
  resume.release();
  await new Promise((resolve) => setTimeout(resolve, 0));
  expect(execute).not.toHaveBeenCalled();
});
it("never dispatches after a delayed confirmation callback outlives the timeout", async () => {
  const detail = await queuedEffect(100);
  const reached = deferred(), resume = deferred();
  const execute = vi.fn(async () => ({ output: { eventId: "late" } }));
  const runner = createWorkflowRunner({ store, registry, content: { generate: vi.fn() }, workerId: "timeout-confirm-worker", authorize: async () => true,
    dispatchConfirmed: async (_context, dispatch) => { reached.release(); await resume.promise; return dispatch(); },
    executors: { "human.confirm": { execute: async () => ({ output: { confirmed: true } }) }, "calendar.create": { execute } },
  });
  const tick = runner.tick();
  await reached.promise;
  await tick;
  resume.release();
  await new Promise((resolve) => setTimeout(resolve, 0));
  expect(execute).not.toHaveBeenCalled();
});
it("continues to the next step when this worker's checkpoint advances past an in-flight heartbeat", async () => {
  const draft = await service.createDraft(actor, null, "Join two steps");
  const version: WorkflowVersion = { ...draft.versions[0]!, graph: { nodes: [
    { id: "first", type: "control.join", blockVersion: "1.0.0", dependsOn: [], input: {}, capability: null, timeoutMs: 3000, maxAttempts: 1 },
    { id: "second", type: "control.join", blockVersion: "1.0.0", dependsOn: ["first"], input: {}, capability: null, timeoutMs: 3000, maxAttempts: 1 },
  ] } };
  version.graphHash = hashCanonical(version.graph);
  await store.updateVersion(version);
  await service.activate(actor, draft.workflow.id, version.id, version.graphHash);
  const detail = await service.runNow(actor, draft.workflow.id, {});
  const heartbeatStarted = deferred(), releaseHeartbeat = deferred(), heartbeatDone = deferred(), firstRelease = deferred(), firstCheckpoint = deferred();
  const heartbeat = store.heartbeat.bind(store), checkpoint = store.checkpoint.bind(store), list = store.list.bind(store);
  let checkpointDone = false;
  vi.spyOn(store, "heartbeat").mockImplementation(async (...args) => {
    heartbeatStarted.release();
    await releaseHeartbeat.promise;
    try { return await heartbeat(...args); }
    finally { heartbeatDone.release(); }
  });
  vi.spyOn(store, "checkpoint").mockImplementation(async (...args) => {
    await checkpoint(...args);
    if (args[2].blockId === "first") { checkpointDone = true; firstCheckpoint.release(); }
  });
  vi.spyOn(store, "list").mockImplementation(async (table) => {
    if (checkpointDone && table === "workflow_steps") {
      await heartbeatDone.promise;
      await new Promise((resolve) => setTimeout(resolve, 0));
    }
    return list(table);
  });
  const signals: boolean[] = [];
  const runner = createWorkflowRunner({ store, registry, content: { generate: vi.fn() }, workerId: "heartbeat-race-worker",
    leaseMs: 1000, authorize: async () => true,
    executors: { "control.join": { execute: async (context) => {
      if (context.node.id === "first") await firstRelease.promise;
      signals.push(context.signal.aborted);
      return { output: {} };
    } } },
  });
  try {
    const tick = runner.tick();
    await heartbeatStarted.promise;
    firstRelease.release();
    await firstCheckpoint.promise;
    releaseHeartbeat.release();
    await tick;
    expect(signals).toEqual([false, false]);
    expect((await service.runDetail(actor, detail.run.id)).run.status).toBe("COMPLETED");
  } finally {
    releaseHeartbeat.release();
    firstRelease.release();
    vi.restoreAllMocks();
  }
});
