import { randomUUID } from "node:crypto";
import type { WorkflowStore } from "@humanos/database";
import { hashCanonical, type Workflow, type WorkflowVersion, type WorkflowSchedule, type WorkflowRun, type WorkflowEvent } from "@humanos/schemas";
import { nextOccurrence, transitionRun, validateWorkflowGraph, type BlockRegistry } from "@humanos/workflows";
import { createScheduledRunSnapshot } from "./run-snapshot.js";

export type ScheduleDefinition = WorkflowSchedule["definition"];
export function createPinnedSchedule(workflow: Workflow, version: WorkflowVersion, definition: ScheduleDefinition, now: Date, executionSessionId: string | null = null): WorkflowSchedule {
  if (workflow.status !== "ACTIVE" || workflow.latestVersionId !== version.id ||
      version.workflowId !== workflow.id || version.activatedAt === null)
    throw new Error("WORKFLOW_NOT_ACTIVE");
  const at = now.toISOString();
  const base: WorkflowSchedule = { id: randomUUID(), workflowId: workflow.id,
    workflowVersionId: version.id, definition, nextFireAt: null,
    lastFireAt: null, status: "ACTIVE", overlapPolicy: "skip", createdAt: at, updatedAt: at, executionSessionId };
  const next = nextOccurrence(base, now);
  if (!next) throw new Error("NO_FUTURE_OCCURRENCE");
  return { ...base, nextFireAt: next.at };
}
export function revisePinnedSchedule(current: WorkflowSchedule, patch: { definition?: ScheduleDefinition; status?: "ACTIVE" | "PAUSED" | "CANCELLED" }, now: Date): WorkflowSchedule {
  if (current.status === "CANCELLED" || current.status === "COMPLETED") throw new Error("SCHEDULE_TERMINAL");
  const definition = patch.definition ?? current.definition;
  const status = patch.status ?? current.status;
  const candidate = { ...current, definition };
  const nextFireAt = status === "ACTIVE" ? nextOccurrence(candidate, now)?.at ?? null : null;
  if (status === "ACTIVE" && nextFireAt === null) throw new Error("NO_FUTURE_OCCURRENCE");
  return { ...candidate, status, nextFireAt, updatedAt: now.toISOString() };
}

export interface WorkflowSchedulerDependencies { store: WorkflowStore; registry: BlockRegistry; pollMs?: number }
export function createWorkflowScheduler({ store, registry, pollMs = 1000 }: WorkflowSchedulerDependencies) {
  if (!Number.isInteger(pollMs) || pollMs < 100 || pollMs > 60_000) throw new Error("INVALID_POLL_INTERVAL");
  async function tick(now = new Date()): Promise<number> {
    if (!Number.isFinite(now.getTime())) throw new Error("INVALID_NOW");
    let created = 0, processed = 0;
    const schedules = await store.list<WorkflowSchedule>("workflow_schedules");
    for (const initial of schedules) {
      let current = initial;
      while (current.status === "ACTIVE" && current.nextFireAt && Date.parse(current.nextFireAt) <= now.getTime() && processed < 64) {
        processed++;
        const workflow = await store.get<Workflow>("workflows", current.workflowId);
        const version = await store.get<WorkflowVersion>("workflow_versions", current.workflowVersionId);
        if (!workflow || !version || workflow.status !== "ACTIVE" || !version.activatedAt) break;
        validateWorkflowGraph(version.graph, registry);
        const at = current.nextFireAt;
        const snapshot = createScheduledRunSnapshot(workflow, version, current, at, now.toISOString());
        let inserted: boolean;
        try { inserted = await store.createOccurrence(current.id, at, snapshot.run, snapshot.steps); }
        catch (error) { if (error instanceof Error && error.message === "SCHEDULE_MISMATCH") break; throw error; }
        if (inserted) created++;
        const following = nextOccurrence(current, new Date(at));
        const next: WorkflowSchedule = { ...current, lastFireAt: at, nextFireAt: following?.at ?? null,
          status: following ? "ACTIVE" : "COMPLETED", updatedAt: now.toISOString() };
        try { await store.compareAndSwapSchedule(current, next); }
        catch (error) { if (error instanceof Error && error.message === "SCHEDULE_CONFLICT") break; throw error; }
        current = next;
      }
      if (processed >= 64) break;
    }
    return created;
  }
  async function recover(now = new Date()): Promise<{ leases: number; retries: number; schedules: number }> {
    const leases = await store.recoverExpiredRuns(now);
    let retries = 0;
    const runs = await store.list<WorkflowRun>("workflow_runs");
    for (const run of runs) {
      if ((run.status !== "WAITING" && run.status !== "RETRY_SCHEDULED") ||
          !run.nextResumeAt || Date.parse(run.nextResumeAt) > now.getTime()) continue;
      const next = { ...transitionRun(run, "QUEUED", now.toISOString()), nextResumeAt: null,
        pauseReason: null, leaseOwner: null, leaseExpiresAt: null };
      const events = (await store.list<WorkflowEvent>("workflow_events")).filter(event => event.runId === run.id);
      try {
        await store.compareAndSwapRun(run.id, run.revision, next, {
          id: hashCanonical({ runId: run.id, revision: next.revision, type: "run.resumed" }),
          runId: run.id, stepRunId: null, sequence: Math.max(0, ...events.map(event => event.sequence)) + 1,
          type: "run.resumed", data: {}, createdAt: now.toISOString(),
        });
        retries++;
      } catch (error) { if (!(error instanceof Error && error.message === "REVISION_CONFLICT")) throw error; }
    }
    return { leases, retries, schedules: await tick(now) };
  }
  async function start(signal: AbortSignal): Promise<void> {
    while (!signal.aborted) {
      await recover();
      if (signal.aborted) break;
      await new Promise<void>(resolve => {
        const timeout = setTimeout(done, pollMs);
        function done() { clearTimeout(timeout); signal.removeEventListener("abort", done); resolve(); }
        signal.addEventListener("abort", done, { once: true });
      });
    }
  }
  return { tick, recover, start };
}
