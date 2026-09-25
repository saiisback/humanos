import type { Hex, RunStatus, StepStatus, WorkflowRun, StepRun } from "@humanos/schemas";

export type ReconciliationOutcome = "already_completed" | "not_performed" | "unresolved" | "failed";
export interface ReconciliationResult {
  outcome: ReconciliationOutcome;
  evidenceHash: Hex;
}

const RECONCILIATION_RUN_TRANSITIONS: Readonly<Record<ReconciliationOutcome, readonly RunStatus[]>> = {
  already_completed: ["QUEUED"],
  not_performed: ["QUEUED"],
  unresolved: [],
  failed: ["FAILED"],
};
const RECONCILIATION_STEP_TRANSITIONS: Readonly<Record<ReconciliationOutcome, readonly StepStatus[]>> = {
  already_completed: ["COMPLETED"],
  not_performed: ["READY"],
  unresolved: [],
  failed: ["FAILED"],
};

function validReconciliation(result: ReconciliationResult | undefined): result is ReconciliationResult {
  return result !== null && typeof result === "object" && /^0x[0-9a-f]{64}$/.test(result.evidenceHash);
}

export const RUN_TRANSITIONS: Readonly<Record<RunStatus, readonly RunStatus[]>> = {
  QUEUED: ["RUNNING", "CANCELLED", "REVOKED"],
  RUNNING: ["CONNECTION_REQUIRED", "CONFIRMATION_REQUIRED", "INPUT_REQUIRED", "WAITING", "RETRY_SCHEDULED", "RECONCILIATION_REQUIRED", "COMPLETED", "FAILED", "CANCELLED", "REVOKED"],
  CONNECTION_REQUIRED: ["QUEUED", "CANCELLED", "REVOKED"],
  CONFIRMATION_REQUIRED: ["QUEUED", "CANCELLED", "REVOKED"],
  INPUT_REQUIRED: ["QUEUED", "CANCELLED", "REVOKED"],
  WAITING: ["QUEUED", "CANCELLED", "REVOKED"],
  RETRY_SCHEDULED: ["QUEUED", "CANCELLED", "REVOKED"],
  RECONCILIATION_REQUIRED: [],
  COMPLETED: [], FAILED: [], CANCELLED: [], REVOKED: [],
};
export const STEP_TRANSITIONS: Readonly<Record<StepStatus, readonly StepStatus[]>> = {
  PENDING: ["READY", "SKIPPED", "CANCELLED", "REVOKED"],
  READY: ["RUNNING", "SKIPPED", "CANCELLED", "REVOKED"],
  RUNNING: ["COMPLETED", "WAITING", "RETRY_SCHEDULED", "FAILED", "RECONCILIATION_REQUIRED", "CANCELLED", "REVOKED"],
  WAITING: ["READY", "CANCELLED", "REVOKED"],
  RETRY_SCHEDULED: ["READY", "CANCELLED", "REVOKED"],
  RECONCILIATION_REQUIRED: [],
  COMPLETED: [], SKIPPED: [], FAILED: [], CANCELLED: [], REVOKED: [],
};

export function transitionRun(run: WorkflowRun, next: RunStatus, at: string, reconciliation?: ReconciliationResult): WorkflowRun {
  const allowed = run.status === "RECONCILIATION_REQUIRED"
    ? validReconciliation(reconciliation) && RECONCILIATION_RUN_TRANSITIONS[reconciliation.outcome]?.includes(next)
    : reconciliation === undefined && RUN_TRANSITIONS[run.status].includes(next);
  if (!allowed) throw new Error("INVALID_RUN_TRANSITION");
  return { ...run, status: next, revision: run.revision + 1,
    startedAt: next === "RUNNING" && run.startedAt === null ? at : run.startedAt,
    completedAt: next === "COMPLETED" || next === "FAILED" ? at : run.completedAt,
    cancelledAt: next === "CANCELLED" ? at : run.cancelledAt };
}
export function transitionStep(step: StepRun, next: StepStatus, at: string, reconciliation?: ReconciliationResult): StepRun {
  const allowed = step.status === "RECONCILIATION_REQUIRED"
    ? validReconciliation(reconciliation) && RECONCILIATION_STEP_TRANSITIONS[reconciliation.outcome]?.includes(next)
    : reconciliation === undefined && STEP_TRANSITIONS[step.status].includes(next);
  if (!allowed) throw new Error("INVALID_STEP_TRANSITION");
  return { ...step, status: next, startedAt: next === "RUNNING" && step.startedAt === null ? at : step.startedAt,
    completedAt: ["COMPLETED", "SKIPPED", "FAILED", "CANCELLED", "REVOKED"].includes(next) ? at : step.completedAt,
    errorClass: reconciliation && (next === "READY" || next === "COMPLETED") ? null : step.errorClass };
}
