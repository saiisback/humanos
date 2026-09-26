import { randomUUID } from "node:crypto";
import * as v from "valibot";
import { hashCanonical, WorkflowReceiptSchema, type BrowserCandidate, type BrowserWorkerResult, type Hex, type JsonValue, type RunConfirmation } from "@humanos/schemas";
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
  store: Pick<WorkflowStore, "saveValue" | "list" | "get" | "getValue">;
  selector?: BrowserActionSelector;
  clock?: () => Date;
  maxActions?: number;
  maxDurationMs?: number;
  /** True only when the worker's browser window is visible to the user on this computer. */
  visibleWindow?: boolean;
  /** How long a login/CAPTCHA handoff window is kept for its run (bounded). */
  handoffHoldMs?: number;
  /** How long a reviewed session is kept awaiting the user's confirmation (bounded). */
  reviewHoldMs?: number;
  /** Interval for closing sessions whose run was cancelled or ended. */
  sweepMs?: number;
}
export const HANDOFF_HOLD_MS = 10 * 60 * 1000;
export const REVIEW_HOLD_MS = 6 * 60 * 1000;
const LIVE_RUN_STATES = new Set(["QUEUED", "RUNNING", "WAITING", "RETRY_SCHEDULED", "INPUT_REQUIRED", "CONNECTION_REQUIRED", "CONFIRMATION_REQUIRED"]);
const LOST_REVIEW_NOTE = "The browser session from your earlier review was closed (it expired, the run was cancelled, or the server restarted). This is a new review in a new browser session.";
// Pause reasons are limited to 256 characters: note + handoff message must fit.
const LOST_WINDOW_NOTE = "The earlier HumanOS browser window was closed (expired, cancelled or restart); a new one is open. ";

/**
 * One live worker session per account + run + step, held in this process only. It is never
 * shared across runs or accounts, is closed on expiry or when its run leaves a live state, and
 * cannot survive a restart: a missing session is reported as lost and needs a new review.
 */
interface HeldSession {
  key: string;
  context: StepExecutionContext;
  runId: string;
  policyId: string;
  client: BrowserUseClient;
  scope: BrowserUseScope;
  prepared: Prepared | null;
  note: string | null;
  timer: ReturnType<typeof setTimeout> | null;
}

interface Prepared {
  destination: string;
  fields: Record<string, string>;
  material: string[];
  value: { amount: string; currency: string } | null;
  materialHash: Hex;
  sessionId: string;
  observationRevision: number;
  metrics: PreparationMetrics;
}
/** Measured per preparation session; never estimated. */
interface PreparationMetrics { actions: number; jevCalls: number; preparationMs: number }

const HANDOFF_MESSAGES: Record<string, string> = {
  LOGIN_REQUIRED: "Sign in to the site in the HumanOS browser window on this computer, then resume. It stays open for this run only, up to 10 minutes.",
  CAPTCHA: "Complete the site's check in the HumanOS browser window on this computer, then resume. It stays open for this run only, up to 10 minutes.",
  PROFILE_BUSY: "Another booking is using this account's HumanOS browser. Resume when it finishes.",
};
const HIDDEN_WINDOW_MESSAGE = "The site needs you to sign in, but this server runs HumanOS with no visible browser window. Ask the operator to set HUMANOS_BROWSER_HEADLESS=false, then resume. Nothing was booked.";

export function createBrowserUseStep(deps: BrowserUseStepDependencies) {
  const clock = deps.clock ?? (() => new Date());
  const permits = createPermitLedger();
  const held = new Map<string, HeldSession>();
  let sweeper: ReturnType<typeof setInterval> | null = null;
  const keyFor = (context: StepExecutionContext) => `${context.actor.accountId}\u0000${context.run.id}\u0000${context.step.id}`;

  async function release(key: string): Promise<void> {
    const session = held.get(key);
    if (!session) return;
    held.delete(key);
    if (session.timer) clearTimeout(session.timer);
    if (!held.size && sweeper) { clearInterval(sweeper); sweeper = null; }
    await session.client.close().catch(() => {});
  }
  function hold(session: HeldSession, ms: number): void {
    if (session.timer) clearTimeout(session.timer);
    session.timer = setTimeout(() => { void release(session.key); }, ms);
    session.timer.unref?.();
    held.set(session.key, session);
    if (!sweeper) {
      sweeper = setInterval(() => { void sweep(); }, deps.sweepMs ?? 30_000);
      sweeper.unref?.();
    }
  }
  /** Closes held sessions whose run was cancelled, finished or is gone. */
  async function sweep(): Promise<void> {
    for (const session of [...held.values()]) {
      const run = await deps.store.get<{ status: string }>("workflow_runs", session.runId).catch(() => null);
      const authorized = run && LIVE_RUN_STATES.has(run.status) && !session.context.signal.aborted &&
        await deps.authorize(session.context).catch(() => false);
      if (!authorized) await release(session.key);
    }
  }
  /** Durable marker: a later fresh session for this step means the earlier one was lost. */
  async function markOpened(context: StepExecutionContext): Promise<boolean> {
    const id = `browser-use-opened:${context.run.id}:${context.step.id}`;
    if (await deps.store.getValue(id, context.run.id)) return true;
    await deps.store.saveValue(id, context.run.id, { kind: "browser-use.session-opened", stepId: context.step.id }).catch(() => {});
    return false;
  }

  function target(context: StepExecutionContext): { policy: BrowserUsePolicy; fields: Record<string, string>; preferredTime: string | null } {
    if (!context.version.browserFallbackAllowed)
      throw new WorkflowPause("CONNECTION_REQUIRED", "Browser use is off for this workflow. No page was opened.");
    const id = browserUseDestination.exec(String(context.input.destination))?.[1];
    const policy = id ? deps.policies.get(id) : null;
    if (!policy) throw new WorkflowPause("CONNECTION_REQUIRED", "No inspected site policy is installed for this booking site. No page was opened.");
    if (policy.requiresEns && (context.run.authorityMode !== "ens" || !context.run.agentBindingId))
      throw new WorkflowExecutionError("AUTHORIZATION");
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

  async function choose(context: StepExecutionContext, candidates: readonly BrowserCandidate[], facts: { label: string; text: string }[], preferredTime: string | null, metrics: PreparationMetrics): Promise<BrowserCandidate> {
    const exact = preferredTime ? candidates.filter(c => c.label.trim() === preferredTime) : [];
    if (exact.length === 1) return exact[0]!;
    if (!candidates.length) throw new WorkflowPause("INPUT_REQUIRED", "No bookable times are shown for this request. Choose another date or time.");
    if (!deps.selector) throw new WorkflowPause("INPUT_REQUIRED", `Choose one of the available times: ${candidates.map(c => c.label).join(", ")}.`);
    const goal = `Reserve the time closest to ${preferredTime ?? "the requested time"}.`;
    metrics.jevCalls++;
    const choice = await deps.selector.select({ goal, facts, candidates: candidates.map(c => ({ id: c.id, label: c.label })) });
    const picked = candidates.find(c => c.id === choice.candidateId);
    // Existing workflow decision thresholds: uncertain or suspicious choices go to the user.
    if (!picked || choice.needsReview || choice.confidence < 0.7 || choice.alignment < 0.7 || choice.risk > 0.3 || choice.injection > 0.2)
      throw new WorkflowPause("INPUT_REQUIRED", `Choose one of the available times: ${candidates.map(c => c.label).join(", ")}.`);
    return picked;
  }

  /**
   * Prepares the booking in this run's held session, or a new one. Preparation never writes
   * to the site. `execute` re-verifies a reviewed session in place instead of replaying clicks.
   */
  async function prepareSession(context: StepExecutionContext, mode: "preview" | "execute"): Promise<{ session: HeldSession; prepared: Prepared; policy: BrowserUsePolicy }> {
    const { policy, fields, preferredTime } = target(context);
    await authorized(context);
    const key = keyFor(context);
    let session = held.get(key);
    let lost = false;
    if (session && (!session.client.alive || session.policyId !== policy.id)) { await release(key); session = undefined; lost = true; }
    const startedAt = clock().getTime();
    const metrics: PreparationMetrics = { actions: 0, jevCalls: 0, preparationMs: 0 };
    const fresh = !session;
    if (!session) {
      lost = (await markOpened(context)) || lost;
      const client = deps.client!({ accountId: context.actor.accountId, runId: context.run.id });
      session = { key, context, runId: context.run.id, policyId: policy.id, client, prepared: null, note: lost ? LOST_REVIEW_NOTE : null, timer: null,
        scope: { accountId: context.actor.accountId, runId: context.run.id, sessionId: client.sessionId, policyId: policy.id,
          revision: 0, actionsUsed: 0, maxActions: deps.maxActions ?? PREPARATION_MAX_ACTIONS, deadline: new Date(0) } };
    }
    const current = session;
    current.context = context;
    const { client, scope } = current;
    // A resumed handoff gets a fresh time window; the action budget stays cumulative.
    scope.deadline = new Date(clock().getTime() + (deps.maxDurationMs ?? PREPARATION_MAX_MS));
    const send = async (request: BrowserUseRequest): Promise<BrowserWorkerResult> => {
      // Live account/lease/ENS authority before every browser action.
      await authorized(context);
      if (++scope.actionsUsed > scope.maxActions || clock() >= scope.deadline)
        throw new WorkflowPause("CONNECTION_REQUIRED", "Preparing this booking took too many steps. Review the HumanOS browser window.");
      const result = await client.request(request, context.signal);
      scope.revision = result.observationRevision;
      return result;
    };
    const evidenceFrom = (prepared: Extract<BrowserWorkerResult, { status: "prepared" }>): Prepared => {
      metrics.actions = scope.actionsUsed;
      metrics.preparationMs = Math.max(0, clock().getTime() - startedAt);
      return { ...prepared.payload, materialHash: prepared.payload.materialHash as Hex, sessionId: client.sessionId, observationRevision: prepared.observationRevision, metrics };
    };
    let handingOff = false;
    const handoff = (message: string): never => {
      if (!deps.visibleWindow) throw new WorkflowPause("CONNECTION_REQUIRED", HIDDEN_WINDOW_MESSAGE);
      handingOff = true;
      hold(current, deps.handoffHoldMs ?? HANDOFF_HOLD_MS);
      throw new WorkflowPause("CONNECTION_REQUIRED", `${lost ? LOST_WINDOW_NOTE : ""}${message}`);
    };
    try {
      if (current.prepared) {
        if (mode === "preview") { hold(current, deps.reviewHoldMs ?? REVIEW_HOLD_MS); return { session: current, prepared: current.prepared, policy }; }
        // Execute: re-read the same page in the same session. Equal material keeps the reviewed
        // binding; anything else becomes the new evidence and needs a new review.
        const again = await send({ command: "prepare", payload: { fields } });
        if (again.status === "prepared") {
          if (again.payload.materialHash !== current.prepared.materialHash) current.prepared = evidenceFrom(again);
          hold(current, deps.reviewHoldMs ?? REVIEW_HOLD_MS);
          return { session: current, prepared: current.prepared, policy };
        }
        if (!(again.status === "handoff" && ["STALE_OBSERVATION", "PAGE_CHANGED"].includes(again.payload.reason))) pauseFor(again);
        current.prepared = null; // page moved: observe again below, then a new review
      }
      if (fresh) {
        const ready = await send({ command: "start", payload: { policyId: policy.id } });
        if (ready.status !== "ready") pauseFor(ready);
        if (ready.payload.policyId !== policy.id || ready.payload.origin !== policy.origin) throw new WorkflowExecutionError("VALIDATION");
      }
      if (policy.supportsSubmission === false) {
        const result = await send({ command: "prepare", payload: { fields } });
        if (result.status === "handoff" && result.payload.reason === "UNSUPPORTED_EFFECT") {
          // A bounded provider availability report is a pause, never a confirmation or receipt.
          throw new WorkflowPause("CONNECTION_REQUIRED", result.payload.message);
        }
        if (result.status === "prepared" || result.status === "submitted") throw new WorkflowExecutionError("VALIDATION");
        pauseFor(result);
      }
      for (;;) {
        const observed = await send({ command: "observe", payload: {} });
        if (observed.status === "handoff" && (observed.payload.reason === "LOGIN_REQUIRED" || observed.payload.reason === "CAPTCHA")) handoff(HANDOFF_MESSAGES[observed.payload.reason]!);
        if (observed.status !== "observed") pauseFor(observed);
        if (observed.payload.loginRequired) handoff(HANDOFF_MESSAGES.LOGIN_REQUIRED!);
        const candidate = await choose(context, observed.payload.candidates, observed.payload.facts, preferredTime, metrics);
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
        const evidence = evidenceFrom(prepared);
        await deps.store.saveValue(randomUUID(), context.run.id, {
          kind: "browser-use.checkpoint", key: hashCanonical([context.run.id, context.step.id, client.sessionId, prepared.actionId]),
          stepId: context.step.id, sessionId: client.sessionId, observationRevision: prepared.observationRevision,
          // Measured counts only: token usage is not exposed by the model transport, so none is recorded.
          materialHash: evidence.materialHash, actions: metrics.actions, jevCalls: metrics.jevCalls, preparationMs: metrics.preparationMs,
        });
        current.prepared = evidence;
        hold(current, deps.reviewHoldMs ?? REVIEW_HOLD_MS);
        return { session: current, prepared: evidence, policy };
      }
    } catch (error) {
      // A held handoff window stays open; every other stop closes the browser.
      if (!handingOff) {
        if (held.get(key) === current) await release(key); else await client.close();
      }
      if (error instanceof WorkflowPause || error instanceof WorkflowExecutionError) throw error;
      throw new WorkflowExecutionError("TRANSIENT");
    }
  }

  // Approval binds the material *and* the reviewed browser session and revision: a lost or
  // restarted session can never inherit it and always needs a new review.
  const toPrepared = (policy: BrowserUsePolicy, prepared: Prepared, note: string | null): PreparedAction => ({
    destination: prepared.destination,
    payload: { fields: prepared.fields, material: prepared.material, value: prepared.value, materialHash: prepared.materialHash },
    binding: { executor: "browser-use", policyId: policy.id, site: policy.label, origin: policy.origin,
      sessionId: prepared.sessionId, reviewedRevision: prepared.observationRevision, ...(note ? { sessionNote: note } : {}) },
  });

  return {
    sweep,
    /** Closes every held browser session (shutdown and tests). */
    async releaseAll(): Promise<void> { await Promise.all([...held.keys()].map(release)); },
    async prepare(context: StepExecutionContext): Promise<PreparedAction> {
      const { session, prepared, policy } = await prepareSession(context, "preview");
      return toPrepared(policy, prepared, session.note);
    },
    availability: {
      async execute(context: StepExecutionContext): Promise<StepExecutionResult> {
        const { policy, fields } = target(context);
        if (policy.supportsSubmission !== false || !policy.requiresEns) throw new WorkflowExecutionError("VALIDATION");
        await authorized(context);
        const client = deps.client!({ accountId: context.actor.accountId, runId: context.run.id });
        try {
          await authorized(context);
          const ready = await client.request({ command: "start", payload: { policyId: policy.id } }, context.signal);
          if (ready.status !== "ready") pauseFor(ready);
          if (ready.payload.policyId !== policy.id || ready.payload.origin !== policy.origin) throw new WorkflowExecutionError("VALIDATION");
          await authorized(context);
          const result = await client.request({ command: "prepare", payload: { fields } }, context.signal);
          if (result.status === "prepared" || result.status === "submitted") throw new WorkflowExecutionError("VALIDATION");
          if (result.status !== "handoff" || result.payload.reason !== "UNSUPPORTED_EFFECT") pauseFor(result);
          return { output: { text: result.payload.message, booked: false } };
        } finally { await client.close(); }
      },
    },
    executor: {
      async execute(context: StepExecutionContext): Promise<StepExecutionResult> {
        const { session, prepared, policy } = await prepareSession(context, "execute");
        const client = session.client;
        let claimed = false;
        let keep = false;
        try {
          // Claims the single dispatch for exactly the material and session on this page, or pauses for review.
          const live = toPrepared(policy, prepared, session.note);
          await deps.confirmations.dispatchConfirmed(context, async () => ({ output: {} }), undefined, live);
          claimed = true;
          // A slow final authority check must not extend the user's approval window.
          const payloadHash = hashCanonical({ accountId: context.actor.accountId, versionId: context.version.id,
            runId: context.run.id, nodeId: context.node.id, input: context.input, prepared: live });
          const approval = (await deps.store.list<RunConfirmation>("workflow_confirmations"))
            .find(c => c.runId === context.run.id && c.stepRunId === context.step.id && c.actorAccountId === context.actor.accountId &&
              c.status === "CONSUMED" && c.payloadHash === payloadHash && Date.parse(c.expiresAt) > clock().getTime());
          await authorized(context);
          const now = clock();
          const ttlMs = approval ? Math.min(PERMIT_TTL_MS, Date.parse(approval.expiresAt) - now.getTime()) : 0;
          // The durable claim cannot safely be reused, even when its approval expires before sending.
          if (ttlMs <= 0) throw new WorkflowExecutionError("UNKNOWN_OUTCOME");
          const permit = permits.issue({ runId: context.run.id, stepKey: `${context.step.id}:${context.idempotencyKey}`, sessionId: client.sessionId,
            actionId: client.nextActionId, observationRevision: client.revision, payloadHash: prepared.materialHash, now, ttlMs });
          let outcome: BrowserWorkerResult | null = null;
          const submitStartedAt = clock().getTime();
          try { outcome = await client.request({ command: "submit", payload: { permit } }, context.signal); } catch { outcome = null; }
          if (outcome?.status !== "submitted") {
            // From here the site may have accepted the booking: read-only inspection, never a retry.
            try {
              await authorized(context);
              const inspected = await client.request({ command: "inspect_receipt", payload: {} }, AbortSignal.any([context.signal, AbortSignal.timeout(15000)]));
              if (inspected.status === "submitted") outcome = inspected;
            } catch { /* Lost authority or worker: the possible submission still needs reconciliation. */ }
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
              metadata: { executor: "browser-use", policyId: policy.id, materialHash: prepared.materialHash, sessionId: client.sessionId,
                preparationActions: prepared.metrics.actions, jevCalls: prepared.metrics.jevCalls, preparationMs: prepared.metrics.preparationMs,
                submitMs: Math.max(0, clock().getTime() - submitStartedAt) } satisfies Record<string, JsonValue>,
            }),
          };
        } catch (error) {
          // Unclaimed pause (material changed → new review): keep this session for that review.
          if (error instanceof WorkflowPause) { keep = !claimed && held.get(session.key) === session; throw error; }
          if (claimed) throw error instanceof WorkflowExecutionError && error.errorClass !== "AUTHORIZATION" ? error : new WorkflowExecutionError(error instanceof WorkflowExecutionError ? "AUTHORIZATION" : "UNKNOWN_OUTCOME");
          if (error instanceof WorkflowExecutionError) throw error;
          throw new WorkflowExecutionError("TRANSIENT");
        } finally {
          if (!keep) { if (held.get(session.key) === session) await release(session.key); else await client.close(); }
        }
      },
    } satisfies WorkflowExecutor,
  };
}
