import { expect, it } from "vitest";
import { createWorkflowRuntime, createWorkflowAuthorizer } from "../src/workflows/runtime.js";
import type { Database, WorkflowStore } from "@humanos/database";
import { createDefaultCatalog } from "@humanos/workflows";
import { hashCanonical } from "@humanos/schemas";
import { ConnectorRegistry } from "../src/workflows/connectors.js";
import type { StepExecutionContext } from "../src/workflows/types.js";

it("routes saved-workflow assembly through the configured private Flue bridge", () => {
  const runtime = createWorkflowRuntime({} as Database, { OPENCODE_API_KEY: "test-only", FLUE_URL: "http://localhost:3002", FLUE_INTERNAL_SECRET: "test-bridge" });
  expect(runtime.flue).toEqual({ url: "http://localhost:3002", secret: "test-bridge" });
  const standalone = createWorkflowRuntime({} as Database, { OPENCODE_API_KEY: "test-only" });
  expect(standalone.flue).toBeUndefined();
});

it("rechecks session revocation, run cancellation and lease ownership at dispatch", async () => {
  const graph = { nodes: [] };
  const run = { id: "run", workflowId: "workflow", workflowVersionId: "version", status: "RUNNING", revision: 1, leaseOwner: "worker", leaseExpiresAt: new Date(Date.now() + 60000).toISOString(), executionSessionId: "session" };
  let session: unknown = { accountId: "account", rootId: null, expiresAt: new Date(Date.now() + 60000).toISOString() };
  const store = { get: async (table: string) => table === "workflow_runs" ? run : table === "workflows" ? { accountId: "account", rootId: null, status: "ACTIVE", missionId: null } : { activatedAt: new Date().toISOString(), graphHash: hashCanonical(graph), requiredCapabilities: [] } } as unknown as WorkflowStore;
  const db = { get: async (table: string) => table === "sessions" ? session : { id: "account" } } as unknown as Database;
  const context = { actor: { accountId: "account", rootId: null }, run: { ...run }, version: { graph }, node: { type: "content.generate" }, input: {}, signal: new AbortController().signal } as unknown as StepExecutionContext;
  const authorize = createWorkflowAuthorizer(db, store, createDefaultCatalog(), new ConnectorRegistry());
  expect(await authorize(context)).toBe(true);
  run.status = "CANCELLED";
  expect(await authorize(context)).toBe(false);
  run.status = "RUNNING";
  run.leaseOwner = "other-worker";
  expect(await authorize(context)).toBe(false);
  run.leaseOwner = "worker";
  session = null;
  expect(await authorize(context)).toBe(false);
  session = { accountId: "account", rootId: null, expiresAt: new Date(0).toISOString() };
  expect(await authorize(context)).toBe(false);
});
