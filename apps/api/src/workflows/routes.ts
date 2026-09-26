import { Hono, type Context } from "hono";
import * as v from "valibot";
import {
  CreateWorkflowRequestSchema, ActivateWorkflowRequestSchema, RunWorkflowRequestSchema,
  ConfirmWorkflowStepRequestSchema, AssembleWorkflowRequestSchema, RefineWorkflowRequestSchema,
  CreateWorkflowScheduleRequestSchema, UpdateWorkflowScheduleRequestSchema,
} from "@humanos/schemas";
import type { WorkflowRun, WorkflowSchedule, WorkflowConnectionsResponse } from "@humanos/schemas";
import { createPinnedSchedule, revisePinnedSchedule } from "./scheduler.js";
import type { WorkflowStore } from "@humanos/database";
import type { createWorkflowService } from "./service.js";
import type { createWorkflowConfirmations } from "./confirmations.js";
import type { createWorkflowAgentService } from "./agents.js";
import { createWorkflowAgentRoutes } from "./agent-routes.js";
import type { WorkflowActor } from "./types.js";
export interface WorkflowApi {
  service: ReturnType<typeof createWorkflowService>;
  store: WorkflowStore;
  agents?: ReturnType<typeof createWorkflowAgentService>;
  confirmations?: ReturnType<typeof createWorkflowConfirmations>;
  connections?(actor: WorkflowActor): Promise<WorkflowConnectionsResponse>;
  flue?: { url: string; secret: string };
}
const planMessages: Record<string, string> = {
  REVIEW_REQUIRED: "Jev could not confirm a safe plan for this request, so nothing ran. Your request is saved; edit it with the output, recipient, or constraints you want and prepare it again.",
  NO_CANDIDATES: "No audited step fits this request yet, so nothing ran. Your request is saved; rephrase it as a draft, sourced research, or an email to one recipient.",
  ENS_AGENT_REQUIRED: "This workflow now needs an active ENS agent for its current version. Enable or replace the agent; nothing ran.",
};
export function createWorkflowRoutes(deps: WorkflowApi, authenticate: (c: Context) => Promise<WorkflowActor>) {
  const app = new Hono<{ Variables: { actor: WorkflowActor } }>();
  app.use("*", async (c, next) => { c.set("actor", await authenticate(c)); await next(); });
  if (deps.agents) app.route("/", createWorkflowAgentRoutes(deps.agents, async c => c.get("actor") as WorkflowActor));
  const known = new Set(["GRAPH_CHANGED", "IMMUTABLE_VERSION", "WORKFLOW_NOT_ACTIVE", "WORKFLOW_ARCHIVED", "IDEMPOTENCY_CONFLICT", "RESUME_NOT_ALLOWED", "INVALID_RUN_TRANSITION", "CONFIRMATION_UNAVAILABLE", "CONFIRMATION_MISMATCH", "REVIEW_REQUIRED", "NO_CANDIDATES", "EMPTY_WORKFLOW", "ENS_AGENT_REQUIRED"]);
  app.onError((error, c) => {
    if (error.message === "NOT_FOUND") return c.json({ error: { code: "NOT_FOUND", message: "Workflow not found." } }, 404);
    if (known.has(error.message)) return c.json({ error: { code: error.message, message: planMessages[error.message] ?? "The workflow could not advance. Refresh its current state before retrying." } }, 409);
    if (error.message === "INVALID_IDEMPOTENCY_KEY") return c.json({ error: { code: error.message, message: "A unique request key is required." } }, 400);
    throw error;
  });
  app.get("/workflows", c => deps.service.list(c.get("actor")).then(value => c.json(value)));
  app.get("/workflow-connections", async c => deps.connections
    ? c.json(await deps.connections(c.get("actor")))
    : c.json({ error: { code: "UNAVAILABLE", message: "Connection status is unavailable; no service is assumed connected." } }, 503));
  app.post("/workflows", async c => {
    const { goal } = v.parse(CreateWorkflowRequestSchema, await c.req.json());
    return c.json(await deps.service.createDraft(c.get("actor"), null, goal), 201);
  });
  app.get("/workflows/:id", async c => c.json(await deps.service.detail(c.get("actor"), c.req.param("id"))));
  app.post("/workflows/:id/assemble", async c => {
    v.parse(AssembleWorkflowRequestSchema, await c.req.json());
    await deps.service.detail(c.get("actor"), c.req.param("id"));
    if (deps.flue) {
      const response = await fetch(new URL(`/internal/workflows/${encodeURIComponent(c.req.param("id"))}/assemble`, deps.flue.url), { method: "POST", headers: { authorization: `Bearer ${deps.flue.secret}`, cookie: c.req.header("cookie") ?? "", "Content-Type": "application/json" }, body: "{}", redirect: "error", signal: AbortSignal.timeout(60000) });
      if (!response.ok) {
        const error = await response.json().catch(() => null) as { error?: { code?: string } } | null;
        if (error?.error?.code === "REVIEW_REQUIRED" || error?.error?.code === "NO_CANDIDATES") throw new Error(error.error.code);
        return c.json({ error: { code: "WORKFLOW_ASSEMBLY_UNAVAILABLE", message: "The planning service is unavailable. Your request is saved and no actions have run." } }, 503);
      }
      // Read the persisted result ourselves; service responses never supply authority.
      return c.json(await deps.service.detail(c.get("actor"), c.req.param("id")));
    }
    return c.json(await deps.service.assemble(c.get("actor"), c.req.param("id")));
  });
  app.post("/workflows/:id/refine", async c => {
    const { goal } = v.parse(RefineWorkflowRequestSchema, await c.req.json());
    return c.json(await deps.service.refine(c.get("actor"), c.req.param("id"), goal));
  });
  app.post("/internal/workflows/:id/assemble", async c => {
    if (!deps.flue || c.req.header("authorization") !== `Bearer ${deps.flue.secret}`) return c.json({ error: { code: "UNAUTHENTICATED" } }, 401);
    v.parse(AssembleWorkflowRequestSchema, await c.req.json());
    return c.json(await deps.service.assemble(c.get("actor"), c.req.param("id")));
  });
  app.post("/workflows/:id/activate", async c => {
    const body = v.parse(ActivateWorkflowRequestSchema, await c.req.json());
    return c.json(await deps.service.activate(c.get("actor"), c.req.param("id"), body.versionId, body.expectedGraphHash));
  });
  app.post("/workflows/:id/runs", async c => {
    const { input } = v.parse(RunWorkflowRequestSchema, await c.req.json());
    const key = c.req.header("idempotency-key");
    if (!key) throw new Error("INVALID_IDEMPOTENCY_KEY");
    return c.json(await deps.service.runNow(c.get("actor"), c.req.param("id"), input, key), 201);
  });
  app.get("/workflows/:id/runs", async c => {
    await deps.service.detail(c.get("actor"), c.req.param("id"));
    return c.json({ runs: (await deps.store.list<WorkflowRun>("workflow_runs")).filter(r => r.workflowId === c.req.param("id")).sort((a, b) => b.createdAt.localeCompare(a.createdAt)) });
  });
  app.get("/workflow-runs/:id", async c => c.json(await deps.service.runDetail(c.get("actor"), c.req.param("id"))));
  app.get("/workflow-runs/:id/outputs", async c => {
    const detail = await deps.service.runDetail(c.get("actor"), c.req.param("id"));
    const outputs = await Promise.all(detail.steps.filter(s => s.outputRef && s.status === "COMPLETED").map(async s => ({ stepRunId: s.id, blockType: s.blockType, output: await deps.store.getValue(s.outputRef!, detail.run.id) })));
    return c.json({ outputs });
  });
  app.post("/workflow-runs/:id/cancel", async c => { v.parse(AssembleWorkflowRequestSchema, await c.req.json()); return c.json(await deps.service.cancel(c.get("actor"), c.req.param("id"))); });
  app.post("/workflow-runs/:id/resume", async c => { v.parse(AssembleWorkflowRequestSchema, await c.req.json()); return c.json(await deps.service.resume(c.get("actor"), c.req.param("id"))); });
  app.get("/workflow-confirmations/:id", async c => {
    if (!deps.confirmations) return c.json({ error: { code: "UNAVAILABLE", message: "Confirmation service unavailable." } }, 503);
    return c.json(await deps.confirmations.preview(c.get("actor"), c.req.param("id")));
  });
  app.post("/workflow-runs/:id/confirm", async c => {
    if (!deps.confirmations) return c.json({ error: { code: "UNAVAILABLE", message: "Confirmation service unavailable." } }, 503);
    const body = v.parse(ConfirmWorkflowStepRequestSchema, await c.req.json());
    await deps.service.runDetail(c.get("actor"), c.req.param("id"));
    await deps.confirmations.confirm(c.get("actor"), c.req.param("id"), body.confirmationId, body.expectedPayloadHash);
    return c.json(await deps.service.runDetail(c.get("actor"), c.req.param("id")));
  });
  app.post("/workflows/:id/schedules", async c => {
    const detail = await deps.service.detail(c.get("actor"), c.req.param("id"));
    const body = v.parse(CreateWorkflowScheduleRequestSchema, await c.req.json());
    const version = detail.versions.find(v => v.id === body.versionId);
    if (!version) throw new Error("NOT_FOUND");
    const pin = await deps.service.authorityPin(detail.workflow.id, version.id);
    const schedule = { ...createPinnedSchedule(detail.workflow, version, body.definition, new Date()), executionSessionId: c.get("actor").sessionId, ...pin };
    await deps.store.saveSchedule(schedule);
    return c.json({ schedule }, 201);
  });
  app.post("/workflow-schedules/:id", async c => {
    const current = await deps.store.get<WorkflowSchedule>("workflow_schedules", c.req.param("id"));
    if (!current) throw new Error("NOT_FOUND");
    await deps.service.detail(c.get("actor"), current.workflowId);
    const body = v.parse(UpdateWorkflowScheduleRequestSchema, await c.req.json());
    const next = revisePinnedSchedule(current, { ...(body.definition ? { definition: body.definition } : {}), ...(body.status ? { status: body.status } : {}) }, new Date());
    if (next.status === "ACTIVE" && !await deps.service.scheduleAuthorized(next)) throw new Error("ENS_AGENT_REQUIRED");
    await deps.store.compareAndSwapSchedule(current, next);
    return c.json({ schedule: next });
  });
  return app;
}
