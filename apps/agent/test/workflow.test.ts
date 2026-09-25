import { it, expect, vi } from "vitest";
import { assembleSavedWorkflow } from "../src/workflow.js";
const config = { apiUrl: "http://127.0.0.1:3001", webOrigin: "http://localhost:5173", internalSecret: "internal-secret" };
it("forwards only an authenticated deterministic assembly command to the authority API", async () => {
  const fetcher = vi.fn(async () => new Response(JSON.stringify({ workflow: { id: "workflow-1" }, versions: [] }), { headers: { "Content-Type": "application/json" } }));
  const result = await assembleSavedWorkflow("workflow-1", "humanos_session=opaque", config, fetcher);
  expect(result).toMatchObject({ workflow: { id: "workflow-1" } });
  const call = fetcher.mock.calls[0] as unknown as [URL, RequestInit];
  expect(call[0].pathname).toBe("/api/internal/workflows/workflow-1/assemble");
  expect(JSON.parse(String(call[1].body))).toEqual({});
  expect(JSON.stringify(result)).not.toContain("internal-secret");
});
it("passes planner stops through by code only, so the saved request stays actionable", async () => {
  for (const code of ["REVIEW_REQUIRED", "NO_CANDIDATES"]) {
    const fetcher = vi.fn(async () => new Response(JSON.stringify({ error: { code, message: "ignored" } }), { status: 409 }));
    await expect(assembleSavedWorkflow("workflow-1", "humanos_session=opaque", config, fetcher)).rejects.toThrow(code);
  }
  const unknown = vi.fn(async () => new Response(JSON.stringify({ error: { code: "SOMETHING_ELSE" } }), { status: 500 }));
  await expect(assembleSavedWorkflow("workflow-1", "humanos_session=opaque", config, unknown)).rejects.toThrow("WORKFLOW_ASSEMBLY_UNAVAILABLE");
});
it("rejects path injection, missing session, or missing service credentials before transport", async () => {
  const fetcher = vi.fn();
  await expect(assembleSavedWorkflow("../approve", "cookie", config, fetcher)).rejects.toThrow();
  await expect(assembleSavedWorkflow("workflow-1", "", config, fetcher)).rejects.toThrow();
  await expect(assembleSavedWorkflow("workflow-1", "cookie", { ...config, internalSecret: "" }, fetcher)).rejects.toThrow();
  expect(fetcher).not.toHaveBeenCalled();
});
