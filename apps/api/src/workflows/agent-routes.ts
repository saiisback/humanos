import { Hono, type Context } from "hono";
import * as v from "valibot";
import {
  ReviewWorkflowAgentRequestSchema,
  EnableWorkflowAgentRequestSchema,
  RevokeWorkflowAgentRequestSchema,
  WorkflowAgentBindingSchema,
  WorkflowAgentReviewSchema,
} from "@humanos/schemas";
import type { createWorkflowAgentService } from "./agents.js";
import type { WorkflowActor } from "./types.js";
export function createWorkflowAgentRoutes(
  service: ReturnType<typeof createWorkflowAgentService>,
  authenticate: (c: Context) => Promise<WorkflowActor>,
) {
  const app = new Hono<{ Variables: { actor: WorkflowActor } }>();
  app.use("*", async (c, next) => {
    c.set("actor", await authenticate(c));
    await next();
  });
  app.onError((error, c) => {
    if (error.message === "WORKFLOW_NOT_PREPARED" || error.message === "ENS_SCOPE_UNAVAILABLE")
      return c.json({ error: { code: error.message, message: "Prepare an executable workflow with supported actions before enabling an ENS agent. A missing booking integration cannot be fixed by granting ENS permissions. No permissions were granted." } }, 409);
    if (v.isValiError(error) || error instanceof SyntaxError)
      return c.json(
        {
          error: {
            code: "INVALID_INPUT",
            message: "Refresh the agent review and try again.",
          },
        },
        400,
      );
    if (error.message === "NOT_FOUND")
      return c.json(
        { error: { code: "NOT_FOUND", message: "Workflow agent not found." } },
        404,
      );
    if (error.message === "ENS_UNAVAILABLE")
      return c.json(
        {
          error: {
            code: "ENS_UNAVAILABLE",
            message: "ENS is unavailable. No permission has been granted.",
          },
        },
        503,
      );
    const known = new Set([
      "HUMAN_ROOT_REQUIRED",
      "GRAPH_CHANGED",
      "REVIEW_MISMATCH",
      "REVIEW_EXPIRED",
      "WORKFLOW_AGENT_CONFLICT",
      "ROOT_NOT_OWNED",
      "ENS_SCOPE_UNAVAILABLE",
      "ENS_WRONG_CHAIN",
      "REVISION_CONFLICT",
    ]);
    if (known.has(error.message))
      return c.json(
        {
          error: {
            code: error.message,
            message:
              error.message === "HUMAN_ROOT_REQUIRED"
                ? "Verify and link your human identity before enabling an agent."
                : "This review cannot be applied. Refresh the workflow and review its current permissions.",
          },
        },
        409,
      );
    return c.json(
      {
        error: {
          code: "ENS_UNAVAILABLE",
          message:
            "ENS could not be reached. Refresh to see the saved registration or revocation status.",
        },
      },
      503,
    );
  });
  app.get("/workflow-agents", async (c) => {
    const result = await service.list(c.get("actor"));
    return c.json({
      ...result,
      bindings: result.bindings.map((b) =>
        v.parse(WorkflowAgentBindingSchema, b),
      ),
    });
  });
  app.get("/workflows/:id/agent", async (c) => {
    const result = await service.detail(c.get("actor"), c.req.param("id"));
    return c.json({
      ...result,
      binding: result.binding
        ? v.parse(WorkflowAgentBindingSchema, result.binding)
        : null,
      bindings: result.bindings.map((b) =>
        v.parse(WorkflowAgentBindingSchema, b),
      ),
    });
  });
  app.post("/workflows/:id/agent/review", async (c) => {
    const body = v.parse(ReviewWorkflowAgentRequestSchema, await c.req.json());
    const { review } = await service.review(
      c.get("actor"),
      c.req.param("id"),
      body.versionId,
    );
    const { bindingId: _, ...publicReview } = review;
    return c.json({ review: v.parse(WorkflowAgentReviewSchema, publicReview) });
  });
  app.post("/workflows/:id/agent/enable", async (c) => {
    const body = v.parse(EnableWorkflowAgentRequestSchema, await c.req.json());
    const { binding } = await service.enable(
      c.get("actor"),
      c.req.param("id"),
      body.reviewId,
      body.expectedReviewHash,
    );
    return c.json({ binding: v.parse(WorkflowAgentBindingSchema, binding) });
  });
  app.post("/workflow-agents/:id/revoke", async (c) => {
    v.parse(RevokeWorkflowAgentRequestSchema, await c.req.json());
    const { binding } = await service.revoke(c.get("actor"), c.req.param("id"));
    return c.json({ binding: v.parse(WorkflowAgentBindingSchema, binding) });
  });
  return app;
}
