import { randomUUID } from "node:crypto";
import * as v from "valibot";
import type { WorkflowStore, WorkflowLease } from "@humanos/database";
import {
  hashCanonical,
  ContentBriefSchema,
  type Workflow,
  type WorkflowVersion,
  type WorkflowRun,
  type StepRun,
  type StepAttempt,
  type WorkflowEvent,
  type JsonValue,
  type RunStatus,
  type ErrorClass,
  type BlockType,
} from "@humanos/schemas";
import {
  transitionRun,
  transitionStep,
  retryDecision,
  validateWorkflowGraph,
  type BlockRegistry,
  type ContentGenerator,
} from "@humanos/workflows";
import type {
  WorkflowExecutor,
  StepExecutionContext,
  StepExecutionResult,
} from "./types.js";
import { ConnectorProviderError } from "./connectors.js";

export class WorkflowPause extends Error {
  constructor(
    readonly status:
      | "CONNECTION_REQUIRED"
      | "CONFIRMATION_REQUIRED"
      | "INPUT_REQUIRED"
      | "WAITING",
    message: string,
    readonly resumeAt: string | null = null,
  ) {
    super(message);
  }
}
export class WorkflowExecutionError extends Error {
  constructor(readonly errorClass: ErrorClass) {
    super(errorClass);
  }
}
export interface RunnerDependencies {
  withUsage?<T>(context: StepExecutionContext, work: () => Promise<T>): Promise<T>;
  store: WorkflowStore;
  registry: BlockRegistry;
  content: ContentGenerator;
  workerId: string;
  authorize(context: StepExecutionContext): Promise<boolean>;
  /** Server-owned, payload-bound single-use approval boundary; never a client boolean. */
  dispatchConfirmed?(
    context: StepExecutionContext,
    dispatch: () => Promise<StepExecutionResult>,
  ): Promise<StepExecutionResult>;
  executors?: Partial<Record<BlockType, WorkflowExecutor>>;
  leaseMs?: number;
  clock?: () => Date;
}
export function createWorkflowRunner(deps: RunnerDependencies) {
  const { store, registry } = deps,
    clock = deps.clock ?? (() => new Date()),
    leaseMs = deps.leaseMs ?? 60000;
  if (leaseMs < 1000 || leaseMs > 300000) throw new Error("INVALID_LEASE");
  async function event(
    run: WorkflowRun,
    type: string,
    stepId: string | null,
    data: Record<string, JsonValue> = {},
  ): Promise<WorkflowEvent> {
    const existing = (
      await store.list<WorkflowEvent>("workflow_events")
    ).filter((e) => e.runId === run.id);
    return {
      id: randomUUID(),
      runId: run.id,
      stepRunId: stepId,
      sequence: Math.max(0, ...existing.map((e) => e.sequence)) + 1,
      type,
      data,
      createdAt: clock().toISOString(),
    };
  }
  async function resolve(
    value: JsonValue,
    steps: StepRun[],
    runId: string,
  ): Promise<JsonValue> {
    if (Array.isArray(value))
      return Promise.all(value.map((item) => resolve(item, steps, runId)));
    if (value && typeof value === "object") {
      if (Object.hasOwn(value, "$ref")) {
        if (Object.keys(value).length !== 1 || typeof value.$ref !== "string")
          throw new Error("INVALID_REFERENCE");
        const [block, field, ...rest] = value.$ref.split(".");
        const source = steps.find((s) => s.blockId === block);
        if (
          !source ||
          source.status !== "COMPLETED" ||
          !source.outputRef ||
          !field ||
          rest.length
        )
          throw new Error("UNBOUND_REFERENCE");
        const output = await store.getValue(source.outputRef, runId);
        if (
          !output ||
          typeof output !== "object" ||
          Array.isArray(output) ||
          !Object.hasOwn(output, field)
        )
          throw new Error("UNBOUND_REFERENCE");
        return output[field]!;
      }
      return Object.fromEntries(
        await Promise.all(
          Object.entries(value).map(async ([key, child]) => [
            key,
            await resolve(child, steps, runId),
          ]),
        ),
      );
    }
    return value;
  }
  async function execute(
    context: StepExecutionContext,
  ): Promise<StepExecutionResult> {
    const custom = deps.executors?.[context.node.type];
    if (custom) return custom.execute(context);
    switch (context.node.type) {
      case "content.generate":
        return {
          output: await deps.content.generate(
            v.parse(ContentBriefSchema, context.input.brief),
          ),
        };
      case "content.transform": {
        const brief = v.parse(ContentBriefSchema, context.input.brief);
        return {
          output: await deps.content.generate({
            ...brief,
            context: {
              source: context.input.sourceRef!,
              context: brief.context,
            },
          }),
        };
      }
      case "control.join":
        return { output: {} };
      case "control.wait":
        if (Date.parse(String(context.input.until)) > clock().getTime())
          throw new WorkflowPause(
            "WAITING",
            "Waiting until the requested time",
            String(context.input.until),
          );
        return { output: {} };
      case "human.confirm":
        throw new WorkflowPause(
          "CONFIRMATION_REQUIRED",
          "Review the exact prepared action before confirming.",
        );
      case "human.input":
        throw new WorkflowPause("INPUT_REQUIRED", String(context.input.prompt));
      case "control.branch":
        throw new WorkflowPause(
          "INPUT_REQUIRED",
          "This conditional step needs a configured deterministic branch executor.",
        );
      case "schedule.once":
      case "schedule.recurring":
        throw new WorkflowPause(
          "INPUT_REQUIRED",
          "Configure this workflow's schedule before running it.",
        );
      default:
        throw new WorkflowPause(
          "CONNECTION_REQUIRED",
          `Connect an approved service for ${context.node.type}.`,
        );
    }
  }
  async function tick(now = clock()): Promise<boolean> {
    const claimed = await store.claimNextRun(deps.workerId, now, leaseMs);
    if (!claimed) return false;
    let run: WorkflowRun = claimed;
    const controller = new AbortController();
    let heartbeatError = false;
    let heartbeatActive = false;
    const lease = (): WorkflowLease => ({
      runId: run!.id,
      revision: run!.revision,
      workerId: deps.workerId,
      now: clock(),
    });
    const renewHeartbeat = async (): Promise<void> => {
      let captured = lease();
      for (let retry = 0; retry < 4; retry++) {
        try {
          await store.heartbeat(captured, leaseMs);
          return;
        } catch (error) {
          const current = await store.get<WorkflowRun>("workflow_runs", captured.runId);
          if (!current || current.status !== "RUNNING" || current.leaseOwner !== deps.workerId ||
              current.revision <= captured.revision || !current.leaseExpiresAt ||
              Date.parse(current.leaseExpiresAt) <= clock().getTime()) throw error;
          // This worker checkpointed a newer revision while the heartbeat waited.
          captured = { ...captured, revision: current.revision, now: clock() };
        }
      }
      throw new Error("LEASE_LOST");
    };
    const timer = setInterval(
      () => {
        if (heartbeatActive) return;
        heartbeatActive = true;
        void renewHeartbeat()
          .catch(() => {
            heartbeatError = true;
            controller.abort();
          })
          .finally(() => {
            heartbeatActive = false;
          });
      },
      Math.floor(leaseMs / 3),
    );
    try {
      const workflow = await store.get<Workflow>("workflows", run.workflowId),
        version = await store.get<WorkflowVersion>(
          "workflow_versions",
          run.workflowVersionId,
        );
      if (!workflow || !version) throw new Error("WORKFLOW_NOT_FOUND");
      const graph = validateWorkflowGraph(version.graph, registry);
      for (let iteration = 0; iteration <= 64; iteration++) {
        if (heartbeatError) throw new Error("LEASE_LOST");
        const steps = (await store.list<StepRun>("workflow_steps")).filter(
          (s) => s.runId === run!.id,
        );
        const node = graph.order.find((n) => {
          const step = steps.find((s) => s.blockId === n.id);
          return (
            step &&
            ["PENDING", "READY", "WAITING", "RETRY_SCHEDULED"].includes(
              step.status,
            ) &&
            n.dependsOn.every(
              (id) =>
                steps.find((s) => s.blockId === id)?.status === "COMPLETED",
            )
          );
        });
        if (!node) {
          const status = steps.every((s) =>
            ["COMPLETED", "SKIPPED"].includes(s.status),
          )
            ? "COMPLETED"
            : "FAILED";
          const next = transitionRun(run, status, clock().toISOString());
          next.leaseOwner = null;
          next.leaseExpiresAt = null;
          await store.compareAndSwapRun(
            run.id,
            run.revision,
            next,
            await event(run, `run.${status.toLowerCase()}`, null),
          );
          return true;
        }
        let step = steps.find((s) => s.blockId === node.id)!;
        const block = registry.get(node.type);
        const input = v.parse(
          block.input,
          await resolve(node.input, steps, run.id),
        ) as Record<string, JsonValue>;
        const context: StepExecutionContext = {
          actor: { accountId: workflow.accountId, rootId: workflow.rootId },
          run,
          version,
          step,
          node,
          input,
          idempotencyKey: step.idempotencyKey,
          signal: controller.signal,
        };
        if (!(await deps.authorize(context))) {
          const next = transitionRun(run, "REVOKED", clock().toISOString());
          next.leaseOwner = null;
          next.leaseExpiresAt = null;
          await store.compareAndSwapRun(
            run.id,
            run.revision,
            next,
            await event(run, "run.revoked", step.id),
          );
          return true;
        }
        if (step.status !== "READY")
          step = transitionStep(step, "READY", clock().toISOString());
        step = transitionStep(step, "RUNNING", clock().toISOString());
        step.attemptCount++;
        step.inputHash = hashCanonical(input);
        step.inputRef = randomUUID();
        await store.saveValue(step.inputRef, run.id, input);
        await store.updateStep(step, lease());
        const attempt: StepAttempt = {
          id: randomUUID(),
          stepRunId: step.id,
          attemptNumber: step.attemptCount,
          executor: block.executor,
          provider: node.type.startsWith("content.") ? "opencode" : null,
          metadata: {},
          requestHash: step.inputHash,
          responseHash: null,
          requestPreview: null,
          responsePreview: null,
          jevDecision: null,
          errorClass: null,
          errorMessage: null,
          startedAt: clock().toISOString(),
          completedAt: null,
          receiptId: null,
        };
        await store.recordAttempt(attempt, lease());
        let result: StepExecutionResult | undefined,
          runStatus: RunStatus = "RUNNING",
          reason: string | null = null,
          resumeAt: string | null = null;
        let timeout: ReturnType<typeof setTimeout> | undefined;
        let dispatched = false;
        try {
          // Re-check immediately before crossing the external executor boundary.
          if (!(await deps.authorize({ ...context, step })))
            throw new WorkflowExecutionError("AUTHORIZATION");
          const dispatch = async () => {
            const assertDispatchActive = async () => {
              if (controller.signal.aborted) throw new WorkflowExecutionError("TIMEOUT");
              const current = await store.get<WorkflowRun>("workflow_runs", run.id);
              if (!current || current.status !== "RUNNING" || current.revision !== run.revision || current.leaseOwner !== deps.workerId || Date.parse(current.leaseExpiresAt ?? "") <= clock().getTime())
                throw new WorkflowExecutionError("AUTHORIZATION");
              if (controller.signal.aborted) throw new WorkflowExecutionError("TIMEOUT");
            };
            await assertDispatchActive();
            if (!(await deps.authorize({ ...context, step })))
              throw new WorkflowExecutionError("AUTHORIZATION");
            await assertDispatchActive();
            dispatched = true;
            return deps.withUsage ? deps.withUsage({ ...context, step }, () => execute({ ...context, step })) : execute({ ...context, step });
          };
          const approvedDispatch = async () => {
            if (!block.requiresConfirmation) return dispatch();
            if (!deps.dispatchConfirmed)
              throw new WorkflowPause("CONFIRMATION_REQUIRED", "Review the exact prepared action before confirming.");
            return deps.dispatchConfirmed({ ...context, step }, dispatch);
          };
          result = await Promise.race([
            approvedDispatch(),
            new Promise<never>((_, reject) => {
              timeout = setTimeout(() => {
                controller.abort();
                reject(new WorkflowExecutionError("TIMEOUT"));
              }, node.timeoutMs);
            }),
          ]);
          v.parse(block.output, result.output);
          if (["irreversible_write", "reversible_write"].includes(block.effect) && !result.receipt)
            throw new WorkflowExecutionError("UNKNOWN_OUTCOME");
          step.outputHash = hashCanonical(result.output);
          step.outputRef = randomUUID();
          await store.saveValue(step.outputRef, run.id, result.output);
          attempt.responseHash = step.outputHash;
          if (result.receipt) {
            const receipt = result.receipt;
            if (
              receipt.runId !== run.id ||
              receipt.stepRunId !== step.id ||
              receipt.requestHash !== step.inputHash ||
              receipt.outputHash !== step.outputHash ||
              receipt.idempotencyKey !== step.idempotencyKey
            )
              throw new Error("RECEIPT_MISMATCH");
            attempt.receiptId = receipt.id;
          }
          step = transitionStep(step, "COMPLETED", clock().toISOString());
          if (
            steps.every(
              (s) =>
                s.id === step.id || ["COMPLETED", "SKIPPED"].includes(s.status),
            )
          )
            runStatus = "COMPLETED";
        } catch (error) {
          result = undefined;
          if (error instanceof WorkflowPause) {
            runStatus = error.status;
            reason = error.message;
            resumeAt = error.resumeAt;
            step = { ...step, status: "WAITING", completedAt: null };
            attempt.errorClass = "CONFIRMATION";
          } else {
            const kind =
              error instanceof WorkflowExecutionError
                ? error.errorClass
                : error instanceof ConnectorProviderError
                  ? error.errorClass
                : dispatched &&
                    ["irreversible_write", "reversible_write"].includes(
                      block.effect,
                    )
                  ? "UNKNOWN_OUTCOME"
                  : "INTERNAL";
            const decision = retryDecision({
              effect: block.effect,
              error: kind,
              attempt: step.attemptCount,
              maxAttempts: step.maxAttempts,
            });
            runStatus =
              kind === "AUTHORIZATION"
                ? "REVOKED"
                : decision === "reconcile"
                  ? "RECONCILIATION_REQUIRED"
                  : decision === "retry"
                    ? "RETRY_SCHEDULED"
                    : "FAILED";
            step = {
              ...step,
              status:
                runStatus === "REVOKED"
                  ? "REVOKED"
                  : decision === "reconcile"
                    ? "RECONCILIATION_REQUIRED"
                    : decision === "retry"
                      ? "RETRY_SCHEDULED"
                      : "FAILED",
              completedAt: null,
              errorClass: kind,
            };
            attempt.errorClass = kind;
            reason = kind;
            resumeAt =
              decision === "retry"
                ? new Date(
                    clock().getTime() + 1000 * 2 ** (step.attemptCount - 1),
                  ).toISOString()
                : null;
          }
          attempt.errorMessage = reason;
        } finally {
          if (timeout) clearTimeout(timeout);
        }
        attempt.completedAt = clock().toISOString();
        const next =
          runStatus === "RUNNING"
            ? { ...run, revision: run.revision + 1 }
            : transitionRun(run, runStatus, clock().toISOString());
        next.pauseReason = reason;
        next.nextResumeAt = resumeAt;
        if (runStatus !== "RUNNING") {
          next.leaseOwner = null;
          next.leaseExpiresAt = null;
        }
        await store.checkpoint(
          lease(),
          next,
          step,
          attempt,
          await event(run, `step.${step.status.toLowerCase()}`, step.id),
          result?.receipt,
        );
        run = next;
        if (runStatus !== "RUNNING") return true;
      }
      throw new Error("RUN_BUDGET_EXCEEDED");
    } finally {
      clearInterval(timer);
      controller.abort();
    }
  }
  return {
    tick,
    recover: (now = clock()) => store.recoverExpiredRuns(now),
    async start(signal: AbortSignal) {
      while (!signal.aborted) {
        await store.recoverExpiredRuns(clock());
        try {
          await tick();
        } catch {
          /* Persisted intent + lease expiry requires reconciliation; do not replay here. */
        }
        await new Promise<void>((resolve) => {
          const timer = setTimeout(done, 1000);
          function done() {
            clearTimeout(timer);
            signal.removeEventListener("abort", done);
            resolve();
          }
          signal.addEventListener("abort", done, { once: true });
        });
      }
    },
  };
}
