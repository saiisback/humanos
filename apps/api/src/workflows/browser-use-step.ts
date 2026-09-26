import { randomUUID } from "node:crypto";
import * as v from "valibot";
import { hashCanonical, WorkflowReceiptSchema, type BrowserCandidate, type BrowserWorkerResult, type Hex, type JsonValue } from "@humanos/schemas";
import type { WorkflowStore } from "@humanos/database";
import type { BrowserUseClient, BrowserUseRequest } from "./browser-use-client.js";
import { createPermitLedger, guardAction, type BrowserUsePolicy, type BrowserUsePolicyRegistry, type BrowserUseScope } from "./browser-use-policy.js";
import type { PreparedAction, createWorkflowConfirmations } from "./confirmations.js";
import { WorkflowExecutionError, WorkflowPause } from "./runner.js";
import type { StepExecutionContext, StepExecutionResult, WorkflowExecutor } from "./types.js";

/** `browser.submit` destinations for this executor name an inspected site policy; never URLs. */
export const browserUseDestination = /^browser-use:([a-z][a-z0-9-]{0,63})$/;
/** Selection hint carried in the payload; never sent to the site. */
const PREFERRED_TIME = "preferred_time";
export const PREPARATION_MAX_ACTIONS = 40;
export const PREPARATION_MAX_MS = 10 * 60 * 1000;
const PERMIT_TTL_MS = 2 * 60 * 1000;

export interface BrowserActionChoice { candidateId: string; confidence: number; alignment: number; risk: number; injection: number; needsReview: boolean }
/** Structured evaluator over finite, sanitized candidates (Jev). It cannot name anything else. */
export interface BrowserActionSelector {
  select(input: { goal: string; facts: { label: string; text: string }[]; candidates: { id: string; label: string }[] }): Promise<BrowserActionChoice>;
}

export interface BrowserUseStepDependencies {
  /** Null when the Browser Use driver is not enabled on this server. */
  client: ((scope: { accountId: string; runId: string }) => BrowserUseClient) | null;
  policies: BrowserUsePolicyRegistry;
  authorize(context: StepExecutionContext): Promise<boolean>;
  confirmations: Pick<ReturnType<typeof createWorkflowConfirmations>, "dispatchConfirmed">;
  store: Pick<WorkflowStore, "saveValue">;
  selector?: BrowserActionSelector;
  clock?: () => Date;
  maxActions?: number;
  maxDurationMs?: number;
}

interface Prepared {
  destination: string;
  fields: Record<string, string>;
  material: string[];
  value: { amount: string; currency: string } | null;
  materialHash: Hex;
  sessionId: string;
  observationRevision: number;
}

const HANDOFF_MESSAGES: Record<string, string> = {
  LOGIN_REQUIRED: "Sign in to the site in the HumanOS browser window, then resume.",
  CAPTCHA: "Complete the site's CAPTCHA in the HumanOS browser window, then resume.",
  PROFILE_BUSY: "Another booking is using this account's HumanOS browser. Resume when it finishes.",
};

export function createBrowserUseStep(deps: BrowserUseStepDependencies) {
  const clock = deps.clock ?? (() => new Date());
  const permits = createPermitLedger();

  function target(context: StepExecutionContext): { policy: BrowserUsePolicy; fields: Record<string, string>; preferredTime: string | null } {
    if (!context.version.browserFallbackAllowed)
      throw new WorkflowPause("CONNECTION_REQUIRED", "Browser use is off for this workflow. No page was opened.");
    const id = browserUseDestination.exec(String(context.input.destination))?.[1];
    const policy = id ? deps.policies.get(id) : null;
    if (!policy) throw new WorkflowPause("CONNECTION_REQUIRED", "No inspected site policy is installed for this booking site. No page was opened.");
    if (!deps.client) throw new WorkflowPause("CONNECTION_REQUIRED", "The local Browser Use worker is not enabled on this HumanOS server. No page was opened.");
    const payload = context.input.payload;
    if (!payload || typeof payload !== "object" || Array.isArray(payload) || Object.values(payload).some(item => typeof item !== "string"))
      throw new WorkflowExecutionError("VALIDATION");
    const { [PREFERRED_TIME]: preferred, ...fields } = payload as Record<string, string>;
    const check = policy.validateFields(fields);
    if (!check.ok) {
      const label = (name: string) => policy.fields.find(f => f.name === name)?.label.toLowerCase() ?? name;
      if (check.invalid?.length) throw new WorkflowPause("INPUT_REQUIRED", `These booking details are not accepted by ${policy.label}: ${check.invalid.map(label).join(", ")}.`);
      throw new WorkflowPause("INPUT_REQUIRED", `Provide the ${check.missing!.map(label).join(", ")} for this booking.`);
    }
    return { policy, fields, preferredTime: preferred?.trim() || null };
  }

  async function authorized(context: StepExecutionContext): Promise<void> {
    if (context.signal.aborted || !(await deps.authorize(context))) throw new WorkflowExecutionError("AUTHORIZATION");
  }

  function pauseFor(result: BrowserWorkerResult): never {
    if (result.status === "handoff") {
      if (result.payload.reason === "UNAVAILABLE_SLOT") throw new WorkflowPause("INPUT_REQUIRED", "That time is no longer available. Choose another time.");
      throw new WorkflowPause("CONNECTION_REQUIRED", HANDOFF_MESSAGES[result.payload.reason] ?? `The booking needs you in the HumanOS browser: ${result.payload.message}`);
    }
    if (result.status === "unavailable") throw new WorkflowPause("CONNECTION_REQUIRED", `The HumanOS browser is not ready: ${result.payload.message}`);
    if (result.status === "failed" && result.payload.code === "POLICY") throw new WorkflowPause("INPUT_REQUIRED", result.payload.message);
    throw new WorkflowExecutionError("TRANSIENT");
  }

  async function choose(context: StepExecutionContext, candidates: readonly BrowserCandidate[], facts: { label: string; text: string }[], preferredTime: string | null): Promise<BrowserCandidate> {
    const exact = preferredTime ? candidates.filter(c => c.label.trim() === preferredTime) : [];
    if (exact.length === 1) return exact[0]!;
    if (!candidates.length) throw new WorkflowPause("INPUT_REQUIRED", "No bookable times are shown for this request. Choose another date or time.");
    if (!deps.selector) throw new WorkflowPause("INPUT_REQUIRED", `Choose one of the available times: ${candidates.map(c => c.label).join(", ")}.`);
    const goal = `Reserve the time closest to ${preferredTime ?? "the requested time"}.`;
    const choice = await deps.selector.select({ goal, facts, candidates: candidates.map(c => ({ id: c.id, label: c.label })) });
    const picked = candidates.find(c => c.id === choice.candidateId);
    // Existing workflow decision thresholds: uncertain or suspicious choices go to the user.
    if (!picked || choice.needsReview || choice.confidence < 0.7 || choice.alignment < 0.7 || choice.risk > 0.3 || choice.injection > 0.2)
      throw new WorkflowPause("INPUT_REQUIRED", `Choose one of the available times: ${candidates.map(c => c.label).join(", ")}.`);
    return picked;
  }

  /** Opens a fresh session and prepares the booking. Preparation never writes to the site. */
  async function prepareSession(context: StepExecutionContext): Promise<{ client: BrowserUseClient; prepared: Prepared; policy: BrowserUsePolicy }> {
    const { policy, fields, preferredTime } = target(context);
    await authorized(context);
    const client = deps.client!({ accountId: context.actor.accountId, runId: context.run.id });
    const scope: BrowserUseScope = { accountId: context.actor.accountId, runId: context.run.id, sessionId: client.sessionId, policyId: policy.id,
      revision: 0, actionsUsed: 0, maxActions: deps.maxActions ?? PREPARATION_MAX_ACTIONS, deadline: new Date(clock().getTime() + (deps.maxDurationMs ?? PREPARATION_MAX_MS)) };
    const send = async (request: BrowserUseRequest): Promise<BrowserWorkerResult> => {
      // Live account/lease/ENS authority before every browser action.
      await authorized(context);
      if (++scope.actionsUsed > scope.maxActions || clock() >= scope.deadline)
        throw new WorkflowPause("CONNECTION_REQUIRED", "Preparing this booking took too many steps. Review the HumanOS browser window.");
      const result = await client.request(request, context.signal);
      scope.revision = result.observationRevision;
      return result;
    };
    try {
      const ready = await send({ command: "start", payload: { policyId: policy.id } });
      if (ready.status !== "ready") pauseFor(ready);
      if (ready.payload.policyId !== policy.id || ready.payload.origin !== policy.origin) throw new WorkflowExecutionError("VALIDATION");
      for (;;) {
        const observed = await send({ command: "observe", payload: {} });
        if (observed.status !== "observed") pauseFor(observed);
        if (observed.payload.loginRequired) throw new WorkflowPause("CONNECTION_REQUIRED", HANDOFF_MESSAGES.LOGIN_REQUIRED!);
        const candidate = await choose(context, observed.payload.candidates, observed.payload.facts, preferredTime);
        const decision = guardAction(scope, { revision: observed.observationRevision, sessionId: observed.sessionId, origin: observed.payload.origin,
          loginRequired: observed.payload.loginRequired, candidates: observed.payload.candidates }, candidate, undefined, clock());
        if (decision.kind === "handoff") {
          if (decision.reason === "STALE_OBSERVATION") continue;
          throw new WorkflowPause("CONNECTION_REQUIRED", decision.message);
        }
        const acted = await send({ command: "act", payload: { candidateId: decision.candidateId } });
        if (acted.status === "handoff" && ["STALE_OBSERVATION", "PAGE_CHANGED"].includes(acted.payload.reason)) continue;
        if (acted.status !== "acted") pauseFor(acted);
        const prepared = await send({ command: "prepare", payload: { fields } });
        if (prepared.status === "handoff" && ["STALE_OBSERVATION", "PAGE_CHANGED"].includes(prepared.payload.reason)) continue;
        if (prepared.status !== "prepared") pauseFor(prepared);
        const evidence: Prepared = { ...prepared.payload, materialHash: prepared.payload.materialHash as Hex, sessionId: client.sessionId, observationRevision: prepared.observationRevision };
        await deps.store.saveValue(randomUUID(), context.run.id, {
          kind: "browser-use.checkpoint", key: hashCanonical([context.run.id, context.step.id, client.sessionId, prepared.actionId]),
          stepId: context.step.id, sessionId: client.sessionId, observationRevision: prepared.observationRevision,
          materialHash: evidence.materialHash, actions: scope.actionsUsed,
        });
        return { client, prepared: evidence, policy };
      }
    } catch (error) {
      await client.close();
      if (error instanceof WorkflowPause || error instanceof WorkflowExecutionError) throw error;
      throw new WorkflowExecutionError("TRANSIENT");
    }
  }

  // Session id and revision are deliberately excluded: approval binds the material, not a tab.
  const toPrepared = (policy: BrowserUsePolicy, prepared: Prepared): PreparedAction => ({
    destination: prepared.destination,
    payload: { fields: prepared.fields, material: prepared.material, value: prepared.value, materialHash: prepared.materialHash },
    binding: { executor: "browser-use", policyId: policy.id, site: policy.label, origin: policy.origin },
  });

  return {
    async prepare(context: StepExecutionContext): Promise<PreparedAction> {
      const { client, prepared, policy } = await prepareSession(context);
      await client.close();
      return toPrepared(policy, prepared);
    },
    executor: {
      async execute(context: StepExecutionContext): Promise<StepExecutionResult> {
        const { client, prepared, policy } = await prepareSession(context);
        let claimed = false;
        try {
          // Claims the single dispatch for exactly the material on this page, or pauses for review.
          await deps.confirmations.dispatchConfirmed(context, async () => ({ output: {} }), undefined, toPrepared(policy, prepared));
          claimed = true;
          await authorized(context);
          const permit = permits.issue({ runId: context.run.id, stepKey: `${context.step.id}:${context.idempotencyKey}`, sessionId: client.sessionId,
            actionId: client.nextActionId, observationRevision: client.revision, payloadHash: prepared.materialHash, now: clock(), ttlMs: PERMIT_TTL_MS });
          let outcome: BrowserWorkerResult | null = null;
          try { outcome = await client.request({ command: "submit", payload: { permit } }, context.signal); } catch { outcome = null; }
          if (outcome?.status !== "submitted") {
            // From here the site may have accepted the booking: read-only inspection, never a retry.
            try {
              const inspected = await client.request({ command: "inspect_receipt", payload: {} }, AbortSignal.timeout(15000));
              if (inspected.status === "submitted") outcome = inspected;
            } catch { /* worker gone; reconciliation below */ }
          }
          if (outcome?.status !== "submitted") throw new WorkflowExecutionError("UNKNOWN_OUTCOME");
          const output = { receiptId: outcome.payload.providerReference };
          return {
            output,
            receipt: v.parse(WorkflowReceiptSchema, {
              id: hashCanonical([context.run.id, context.step.id, context.idempotencyKey]),
              runId: context.run.id, stepRunId: context.step.id, executor: "browser",
              destination: prepared.destination, summary: policy.label,
              requestHash: hashCanonical(context.input), outputHash: hashCanonical(output),
              executedAt: clock().toISOString(), idempotencyKey: context.idempotencyKey,
              providerReference: outcome.payload.providerReference, finalUrl: outcome.payload.finalUrl,
              successEvidence: outcome.payload.successEvidence,
              metadata: { executor: "browser-use", policyId: policy.id, materialHash: prepared.materialHash, sessionId: client.sessionId } satisfies Record<string, JsonValue>,
            }),
          };
        } catch (error) {
          if (error instanceof WorkflowPause) throw error;
          if (claimed) throw error instanceof WorkflowExecutionError && error.errorClass !== "AUTHORIZATION" ? error : new WorkflowExecutionError(error instanceof WorkflowExecutionError ? "AUTHORIZATION" : "UNKNOWN_OUTCOME");
          if (error instanceof WorkflowExecutionError) throw error;
          throw new WorkflowExecutionError("TRANSIENT");
        } finally {
          await client.close();
        }
      },
    } satisfies WorkflowExecutor,
  };
}
