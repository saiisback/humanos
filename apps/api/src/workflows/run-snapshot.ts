import { hashCanonical, type JsonValue, type StepRun, type WorkflowRun, type WorkflowVersion, type WorkflowSchedule, type Workflow } from "@humanos/schemas";
import { stepIdempotencyKey } from "@humanos/workflows";

export function createScheduledRunSnapshot(workflow: Workflow, version: WorkflowVersion, schedule: WorkflowSchedule, occurrenceAt: string, createdAt: string): { run: WorkflowRun; steps: StepRun[] } {
  if (workflow.id !== schedule.workflowId || version.id !== schedule.workflowVersionId || version.workflowId !== workflow.id ||
      workflow.status !== "ACTIVE" || version.activatedAt === null || schedule.status !== "ACTIVE")
    throw new Error("SCHEDULE_NOT_ACTIVE");
  const occurrenceId = hashCanonical({ scheduleId: schedule.id, occurrenceAt });
  const runId = hashCanonical({ occurrenceId, versionId: version.id });
  const inputSnapshot: Record<string, JsonValue> = {};
  const inputHash = hashCanonical(inputSnapshot);
  const run: WorkflowRun = {
    id: runId, workflowId: workflow.id, workflowVersionId: version.id,
    missionId: workflow.missionId, triggerKind: schedule.definition.kind,
    triggerOccurrenceId: occurrenceId, inputSnapshot, inputHash, status: "QUEUED",
    executionSessionId: schedule.executionSessionId ?? null,
    pauseReason: null, revision: 0, leaseOwner: null, leaseExpiresAt: null,
    heartbeatAt: null, createdAt, startedAt: null, completedAt: null,
    cancelledAt: null, nextResumeAt: null,
  };
  const steps: StepRun[] = version.graph.nodes.map(node => ({
    id: hashCanonical({ runId, nodeId: node.id }), runId, blockId: node.id,
    blockType: node.type, blockVersion: node.blockVersion,
    dependencies: [...node.dependsOn], status: "PENDING", attemptCount: 0,
    timeoutMs: node.timeoutMs, maxAttempts: node.maxAttempts,
    inputRef: null, inputHash: null, outputRef: null, outputHash: null,
    idempotencyKey: stepIdempotencyKey({ versionId: version.id, runId, nodeId: node.id, occurrenceId, inputHash }),
    startedAt: null, completedAt: null, errorClass: null,
  }));
  return { run, steps };
}
