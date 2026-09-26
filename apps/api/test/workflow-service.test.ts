import { beforeAll, afterAll, it, expect } from "vitest";
import { Database, WorkflowStore } from "@humanos/database";
import { createDefaultCatalog } from "@humanos/workflows";
import { hashCanonical } from "@humanos/schemas";
import { createWorkflowService } from "../src/workflows/service.js";
const schema = `test_workflow_service_${Date.now()}`;
const db = new Database(
  process.env.TEST_DATABASE_URL ??
    "postgresql://saikarthik@127.0.0.1:55432/humanos",
  { schema },
);
const store = new WorkflowStore(db);
const actor = {
  accountId: "11155111:0x1111111111111111111111111111111111111111",
  rootId: null,
};
const registry = createDefaultCatalog();
const service = createWorkflowService({
  newWorkflowAuthority: "account", // Exercise legacy account-workflow behavior.
  db,
  store,
  registry,
  selector: {
    async select(input) {
      const target = input.history?.includes("content.generate")
        ? "complete"
        : "content.generate";
      return {
        selectedCandidateId: input.candidates.find((c) => c.type === target)!
          .id,
        parameters: {},
        confidence: 0.99,
        alignment: 0.99,
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
    browserFallbackAllowed: false,
  }),
});
it("requires an onchain agent for new workflows even when the run API is called directly", async () => {
  const fresh = createWorkflowService({ db, store, registry,
    selector: { select: async () => { throw new Error("unused"); } },
    assemblyInput: async () => ({ allowedCapabilities: [], inputs: {} }),
  });
  const draft = await fresh.createDraft(actor, null, "Draft a greeting");
  expect(draft.workflow).toMatchObject({ authorityRequirement: "ens" });
  const assembled = await service.assemble(actor, draft.workflow.id);
  const version = assembled.versions.at(-1)!;
  await service.activate(actor, draft.workflow.id, version.id, version.graphHash);
  await expect(fresh.runNow(actor, draft.workflow.id, {})).rejects.toThrow("ENS_AGENT_REQUIRED");
  expect((await store.list<{ workflowId: string }>("workflow_runs")).filter(r => r.workflowId === draft.workflow.id)).toHaveLength(0);
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
it("requeues an expired-confirmation pause without approving or recreating the run", async () => {
  const draft = await service.createDraft(actor, null, "Draft a greeting");
  const assembled = await service.assemble(actor, draft.workflow.id);
  const version = assembled.versions.at(-1)!;
  await service.activate(actor, draft.workflow.id, version.id, version.graphHash);
  const current = await service.runNow(actor, draft.workflow.id, {}, "expired-confirmation");
  const waiting = { ...current.run, status: "CONFIRMATION_REQUIRED" as const, revision: current.run.revision + 1 };
  await db.query("UPDATE workflow_runs SET status=$2,data=$3::jsonb WHERE id=$1", [current.run.id, waiting.status, JSON.stringify(waiting)]);
  await expect(service.resume({ accountId: "another", rootId: null }, current.run.id)).rejects.toThrow("NOT_FOUND");
  const resumed = await service.resume(actor, current.run.id);
  expect(resumed.run.id).toBe(current.run.id);
  expect(resumed.run.status).toBe("QUEUED");
  expect(resumed.confirmations).toEqual([]);
  expect(resumed.receipts).toEqual([]);
  expect(resumed.steps).toEqual(current.steps);
});
it("records Jev's review stop on a draft version and lets the owner refine the request", async () => {
  const reviewing = createWorkflowService({
    db, store, registry,
    selector: { async select(input) {
      return { selectedCandidateId: input.candidates[0]!.id, parameters: {}, confidence: 0.41, alignment: 0.9, risk: 0.1, injection: 0, needsReview: true, reasonCodes: ["goal_ambiguous"] };
    } },
    describeGoal: goal => ({ intent: /research/i.test(goal) ? "research" : "draft" }),
    assemblyInput: async (goal) => ({ allowedCapabilities: [], inputs: { "content.generate": { value: { brief: { instruction: goal, context: {}, outputSchema: "text", maxCharacters: 1000 } } } } }),
  });
  const draft = await reviewing.createDraft(actor, null, "Research something vague");
  await expect(reviewing.assemble(actor, draft.workflow.id)).rejects.toThrow("REVIEW_REQUIRED");
  const stopped = await reviewing.detail(actor, draft.workflow.id);
  const latest = stopped.versions.at(-1)!;
  expect(latest.graph.nodes).toEqual([]);
  expect(latest.activatedAt).toBeNull();
  expect(latest.normalizedIntent).toMatchObject({ intent: "research", assembly: { outcome: "REVIEW_REQUIRED", failedChecks: ["needs_review", "confidence"], reasonCodes: ["goal_ambiguous"] } });
  expect((await store.list<{ workflowId: string }>("workflow_runs")).filter(r => r.workflowId === draft.workflow.id)).toEqual([]);

  const refined = await reviewing.refine(actor, draft.workflow.id, "Draft a two-sentence welcome note for new members");
  const next = refined.versions.at(-1)!;
  expect(next).toMatchObject({ goal: "Draft a two-sentence welcome note for new members", version: latest.version + 1, activatedAt: null, requiredCapabilities: [], normalizedIntent: {} });
  expect(next.graph.nodes).toEqual([]);
  await expect(reviewing.refine({ accountId: "different", rootId: null }, draft.workflow.id, "steal")).rejects.toThrow("NOT_FOUND");
  await expect(reviewing.refine(actor, draft.workflow.id, "")).rejects.toThrow();
});
it("creates an account-owned workflow without requiring a human-root binding", async () => {
  const detail = await service.createDraft(actor, null, "Write a greeting");
  expect(detail.workflow).toMatchObject({
    accountId: actor.accountId,
    rootId: null,
    status: "DRAFT",
  });
  const assembled = await service.assemble(actor, detail.workflow.id);
  const version = assembled.versions.at(-1)!;
  expect(version.graph.nodes.map((n) => n.type)).toEqual(["content.generate"]);
  await expect(
    service.activate(
      actor,
      detail.workflow.id,
      version.id,
      hashCanonical("wrong"),
    ),
  ).rejects.toThrow("GRAPH_CHANGED");
  await service.activate(
    actor,
    detail.workflow.id,
    version.id,
    version.graphHash,
  );
  const run = await service.runNow(actor, detail.workflow.id, {
    topic: "hello",
  }, "single-run-request");
  expect(run.run).toMatchObject({
    workflowVersionId: version.id,
    inputHash: hashCanonical({ topic: "hello" }),
    status: "QUEUED",
  });
  expect(run.steps).toHaveLength(1);
  expect((await service.runNow(actor, detail.workflow.id, { topic: "hello" }, "single-run-request")).run.id).toBe(run.run.id);
  await expect(service.runNow(actor, detail.workflow.id, { topic: "changed" }, "single-run-request")).rejects.toThrow("IDEMPOTENCY_CONFLICT");
  await expect(
    service.detail(
      { accountId: "different", rootId: null },
      detail.workflow.id,
    ),
  ).rejects.toThrow("NOT_FOUND");
});
