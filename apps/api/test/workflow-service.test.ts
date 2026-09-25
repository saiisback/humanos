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
