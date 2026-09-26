import { afterAll, beforeAll, expect, it } from "vitest";
import { Database } from "../src/index.js";
import { createWorkflowUsageStore } from "../src/workflow-usage.js";
const db = new Database(process.env.TEST_DATABASE_URL ?? "postgresql://saikarthik@127.0.0.1:55432/humanos", { schema: `test_usage_${Date.now()}` });
beforeAll(() => db.migrate());
afterAll(() => db.close());
it("updates an attempt without double counting and isolates account reads", async () => {
  const store = createWorkflowUsageStore(db);
  const context = { accountId: "alice", workflowId: "wf", versionId: "v1", runId: "run", stepId: "step", phase: "execution" as const };
  await store.upsertAttempt(context, { attemptId: "a", status: "started" });
  await store.upsertAttempt(context, { attemptId: "a", status: "completed", inputTokens: 20 });
  await store.upsertAttempt(context, { attemptId: "a", status: "completed", inputTokens: 20 });
  await expect(store.upsertAttempt(context, { attemptId: "a", status: "completed", inputTokens: 99 })).rejects.toThrow("USAGE_ATTEMPT_CONFLICT");
  expect(await store.listForWorkflow("bob", "wf")).toEqual([]);
  const rows = await store.listForWorkflow("alice", "wf");
  expect(rows).toHaveLength(1);
  expect(rows[0]?.event).toEqual({ attemptId: "a", status: "completed", inputTokens: 20 });
  await expect(store.upsertAttempt({ ...context, accountId: "bob" }, { attemptId: "a", status: "completed" })).rejects.toThrow();
});
it("retains unfinished attempts and keeps planning separate from run usage", async () => {
  const store = createWorkflowUsageStore(db);
  await store.upsertAttempt({ accountId: "alice", workflowId: "wf2", versionId: "v2", runId: null, stepId: null, phase: "planning" }, { attemptId: "p", status: "started" });
  const rows = await store.listForWorkflow("alice", "wf2");
  expect(rows[0]?.context.runId).toBeNull();
  expect(rows[0]?.event.status).toBe("started");
});
