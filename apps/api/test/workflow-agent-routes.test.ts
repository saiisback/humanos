import { expect, it } from "vitest";
import { createWorkflowAgentRoutes } from "../src/workflows/agent-routes.js";
import { createWorkflowRoutes } from "../src/workflows/routes.js";
it("explains an unprepared workflow without telling the user to retry registration", async () => {
  const app = createWorkflowAgentRoutes({ review: async () => { throw new Error("WORKFLOW_NOT_PREPARED"); } } as never,
    async () => ({ accountId: "owner", rootId: "root" }));
  const response = await app.request("/workflows/w/agent/review", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ versionId: "v" }) });
  expect(response.status).toBe(409);
  expect(await response.json()).toMatchObject({ error: { code: "WORKFLOW_NOT_PREPARED", message: expect.stringContaining("executable workflow") } });
});
it("mounts agent management in the workflow API", async () => {
  const app = createWorkflowRoutes(
    {
      agents: { list: async () => ({ bindings: [], available: true }) },
    } as never,
    async () => ({ accountId: "owner", rootId: "root" }),
  );
  const response = await app.request("/workflow-agents");
  expect(response.status).toBe(200);
  expect(await response.json()).toMatchObject({
    bindings: [],
    available: true,
  });
});
it("validates management input and never forwards client-selected scope or addresses", async () => {
  let called = false;
  const app = createWorkflowAgentRoutes(
    {
      review: async () => {
        called = true;
        return {};
      },
    } as never,
    async () => ({ accountId: "owner", rootId: "root" }),
  );
  const response = await app.request("/workflows/w/agent/review", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ versionId: "v", capabilities: ["value.transfer"] }),
  });
  expect(response.status).toBe(400);
  expect(called).toBe(false);
});
it("returns unavailable rather than leaking backend errors", async () => {
  const app = createWorkflowAgentRoutes(
    {
      review: async () => {
        throw new Error("ENS_UNAVAILABLE");
      },
    } as never,
    async () => ({ accountId: "owner", rootId: "root" }),
  );
  const response = await app.request("/workflows/w/agent/review", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ versionId: "v" }),
  });
  expect(response.status).toBe(503);
  expect(await response.json()).toMatchObject({
    error: { code: "ENS_UNAVAILABLE" },
  });
});
