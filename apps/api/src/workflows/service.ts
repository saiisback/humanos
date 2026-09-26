import { randomUUID } from "node:crypto";
import * as v from "valibot";
import { type Database, type WorkflowStore } from "@humanos/database";
import {
  assembleWorkflow,
  AssemblyReviewError,
  validateWorkflowGraph,
  stepIdempotencyKey,
  transitionRun,
  type AssemblyInput,
  type BlockRegistry,
  type WorkflowSelector,
} from "@humanos/workflows";
import {
  CreateWorkflowRequestSchema,
  BoundedPayloadSchema,
  hashCanonical,
  type Workflow,
  type WorkflowVersion,
  type WorkflowDetailResponse,
  type WorkflowRun,
  type WorkflowRunDetailResponse,
  type StepRun,
  type StepAttempt,
  type WorkflowEvent,
  type RunConfirmation,
  type WorkflowReceipt,
  type WorkflowSchedule,
  type Mission,
  type JsonValue,
  type WorkflowNode,
  type Capability,
} from "@humanos/schemas";
import type { WorkflowActor } from "./types.js";
import { resolveAuthorityPin, scheduleAuthorityCurrent } from "./agent-authorizer.js";

export interface WorkflowServiceDependencies {
  db: Database;
  store: WorkflowStore;
  registry: BlockRegistry;
  selector: WorkflowSelector;
  capabilityForNode?(node: WorkflowNode): Capability | null;
  /** Deterministic, non-authoritative description of how a goal was classified. */
  describeGoal?(goal: string): Record<string, JsonValue>;
  assemblyInput(
    goal: string,
    actor: WorkflowActor,
  ): Promise<Omit<AssemblyInput, "goal" | "draft">>;
}
export function createWorkflowService(deps: WorkflowServiceDependencies) {
  const { db, store, registry } = deps;
  async function owned(actor: WorkflowActor, id: string): Promise<Workflow> {
    const workflow = await store.get<Workflow>("workflows", id);
    if (!workflow || workflow.accountId !== actor.accountId)
      throw new Error("NOT_FOUND");
    if (workflow.missionId) {
      const mission = await db.get<Mission>("missions", workflow.missionId);
      if (!actor.rootId || !mission || mission.rootId !== actor.rootId)
        throw new Error("NOT_FOUND");
    }
    return workflow;
  }
  async function detail(
    actor: WorkflowActor,
    id: string,
  ): Promise<WorkflowDetailResponse> {
    const workflow = await owned(actor, id);
    return {
      workflow,
      versions: (await store.list<WorkflowVersion>("workflow_versions"))
        .filter((v) => v.workflowId === id)
        .sort((a, b) => a.version - b.version),
      schedules: (
        await store.list<WorkflowSchedule>("workflow_schedules")
      ).filter((s) => s.workflowId === id),
    };
  }
  async function runDetail(
    actor: WorkflowActor,
    id: string,
  ): Promise<WorkflowRunDetailResponse> {
    const run = await store.get<WorkflowRun>("workflow_runs", id);
    if (!run) throw new Error("NOT_FOUND");
    await owned(actor, run.workflowId);
    const steps = (await store.list<StepRun>("workflow_steps")).filter(
      (s) => s.runId === id,
    );
    const stepIds = new Set(steps.map((s) => s.id));
    return {
      run,
      steps,
      attempts: (await store.list<StepAttempt>("workflow_attempts")).filter(
        (a) => stepIds.has(a.stepRunId),
      ),
      events: (await store.list<WorkflowEvent>("workflow_events"))
        .filter((e) => e.runId === id)
        .sort((a, b) => a.sequence - b.sequence),
      confirmations: (
        await store.list<RunConfirmation>("workflow_confirmations")
      ).filter((c) => c.runId === id),
      receipts: (await store.list<WorkflowReceipt>("workflow_receipts")).filter(
        (r) => r.runId === id,
      ),
    };
  }
  async function changeRun(
    actor: WorkflowActor,
    id: string,
    status: "CANCELLED" | "QUEUED",
  ) {
    const current = await runDetail(actor, id);
    if (
      status === "QUEUED" &&
      ![
        "CONNECTION_REQUIRED",
        "INPUT_REQUIRED",
        "WAITING",
        "RETRY_SCHEDULED",
      ].includes(current.run.status)
    )
      throw new Error("RESUME_NOT_ALLOWED");
    const at = new Date().toISOString();
    const next = transitionRun(current.run, status, at);
    next.leaseOwner = null;
    next.leaseExpiresAt = null;
    await store.compareAndSwapRun(id, current.run.revision, next, {
      id: randomUUID(),
      runId: id,
      stepRunId: null,
      sequence: (current.events.at(-1)?.sequence ?? 0) + 1,
      type: status === "CANCELLED" ? "run.cancelled" : "run.resumed",
      data: {},
      createdAt: at,
    });
    return runDetail(actor, id);
  }
  return {
    detail,
    runDetail,
    async list(actor: WorkflowActor) {
      return {
        workflows: (await store.list<Workflow>("workflows")).filter(
          (w) => w.accountId === actor.accountId,
        ),
      };
    },
    async createDraft(
      actor: WorkflowActor,
      missionId: string | null,
      goal: string,
    ): Promise<WorkflowDetailResponse> {
      v.parse(CreateWorkflowRequestSchema, { goal });
      if (missionId) {
        const mission = await db.get<Mission>("missions", missionId);
        if (!actor.rootId || !mission || mission.rootId !== actor.rootId)
          throw new Error("NOT_FOUND");
      }
      const now = new Date().toISOString(),
        id = randomUUID(),
        versionId = randomUUID();
      const workflow: Workflow = {
        id,
        accountId: actor.accountId,
        rootId: actor.rootId,
        missionId,
        name: goal.slice(0, 120),
        status: "DRAFT",
        latestVersionId: versionId,
        createdAt: now,
        updatedAt: now,
        archivedAt: null,
      };
      const version: WorkflowVersion = {
        id: versionId,
        workflowId: id,
        version: 1,
        goal,
        normalizedIntent: {},
        graph: { nodes: [] },
        graphHash: hashCanonical({ nodes: [] }),
        requiredCapabilities: [],
        connectorRefs: [],
        browserFallbackAllowed: false,
        trigger: { kind: "manual" },
        assembler: {
          modelId: "jev-1.13",
          modelVersion: "1.13",
          decisionHash: hashCanonical([]),
        },
        createdAt: now,
        activatedAt: null,
      };
      await store.createDraft(workflow, version);
      return detail(actor, id);
    },
    async assemble(
      actor: WorkflowActor,
      id: string,
    ): Promise<WorkflowDetailResponse> {
      const previous = await detail(actor, id);
      if (previous.workflow.status === "ARCHIVED")
        throw new Error("WORKFLOW_ARCHIVED");
      const latest = previous.versions.at(-1)!;
      const described = deps.describeGoal?.(latest.goal) ?? {};
      const config = await deps.assemblyInput(latest.goal, actor);
      let result;
      try {
        result = await assembleWorkflow(
          { ...config, goal: latest.goal, draft: { nodes: [] } },
          deps.selector,
          registry,
        );
      } catch (error) {
        // Keep the stop visible and actionable: an unexecutable draft version records why.
        const outcome = error instanceof AssemblyReviewError
          ? { outcome: "REVIEW_REQUIRED", ...structuredClone(error.diagnostics) as unknown as Record<string, JsonValue> }
          : error instanceof Error && error.message === "NO_CANDIDATES" ? { outcome: "NO_CANDIDATES" } : null;
        if (outcome) {
          const graph = { nodes: [] };
          await store.insertVersion({
            ...latest, id: randomUUID(), version: latest.version + 1,
            graph, graphHash: hashCanonical(graph), requiredCapabilities: [], connectorRefs: [],
            normalizedIntent: { ...described, assembly: outcome },
            activatedAt: null, createdAt: new Date().toISOString(),
          });
        }
        throw error;
      }
      const version: WorkflowVersion = {
        ...latest,
        id: randomUUID(),
        version: latest.version + 1,
        normalizedIntent: { ...described, assembly: { outcome: "ASSEMBLED" } },
        graph: result.graph,
        graphHash: hashCanonical(result.graph),
        requiredCapabilities: [
          ...new Set(
            result.graph.nodes.flatMap((n) =>
              (deps.capabilityForNode?.(n) ?? n.capability) ? [deps.capabilityForNode?.(n) ?? n.capability!] : [],
            ),
          ),
        ],
        connectorRefs: [
          ...new Set(
            result.graph.nodes
              .filter((n) => n.type === "connector.call")
              .map((n) => String(n.input.connectorId)),
          ),
        ],
        browserFallbackAllowed: config.browserFallbackAllowed ?? false,
        assembler: {
          modelId: "jev-1.13",
          modelVersion: "1.13",
          decisionHash: hashCanonical(result.trace),
        },
        activatedAt: null,
        createdAt: new Date().toISOString(),
      };
      await store.insertVersion(version);
      return detail(actor, id);
    },
    /** Save an edited request as a new, unassembled draft version. Activated versions are untouched. */
    async refine(
      actor: WorkflowActor,
      id: string,
      goal: string,
    ): Promise<WorkflowDetailResponse> {
      v.parse(CreateWorkflowRequestSchema, { goal });
      const previous = await detail(actor, id);
      if (previous.workflow.status === "ARCHIVED") throw new Error("WORKFLOW_ARCHIVED");
      const latest = previous.versions.at(-1)!;
      const graph = { nodes: [] };
      await store.insertVersion({
        ...latest, id: randomUUID(), version: latest.version + 1, goal,
        normalizedIntent: {}, graph, graphHash: hashCanonical(graph),
        requiredCapabilities: [], connectorRefs: [], browserFallbackAllowed: false,
        assembler: { modelId: "jev-1.13", modelVersion: "1.13", decisionHash: hashCanonical([]) },
        activatedAt: null, createdAt: new Date().toISOString(),
      });
      return detail(actor, id);
    },
    async activate(
      actor: WorkflowActor,
      id: string,
      versionId: string,
      graphHash: string,
    ): Promise<WorkflowDetailResponse> {
      await owned(actor, id);
      const version = await store.get<WorkflowVersion>(
        "workflow_versions",
        versionId,
      );
      if (!version || version.workflowId !== id) throw new Error("NOT_FOUND");
      if (!version.graph.nodes.length) throw new Error("EMPTY_WORKFLOW");
      validateWorkflowGraph(version.graph, registry);
      await store.activateVersion(id, versionId, graphHash);
      return detail(actor, id);
    },
    async runNow(
      actor: WorkflowActor,
      id: string,
      input: Record<string, JsonValue>,
      idempotencyKey?: string,
    ): Promise<WorkflowRunDetailResponse> {
      v.parse(BoundedPayloadSchema, input);
      const workflow = await owned(actor, id);
      if (idempotencyKey !== undefined && !/^[a-zA-Z0-9_-]{8,128}$/.test(idempotencyKey)) throw new Error("INVALID_IDEMPOTENCY_KEY");
      const runId = idempotencyKey ? hashCanonical({ accountId: actor.accountId, workflowId: id, idempotencyKey }) : randomUUID();
      const existing = await store.get<WorkflowRun>("workflow_runs", runId);
      if (existing) {
        if (existing.inputHash !== hashCanonical(input)) throw new Error("IDEMPOTENCY_CONFLICT");
        return runDetail(actor, runId);
      }
      if (workflow.status !== "ACTIVE" || !workflow.latestVersionId)
        throw new Error("WORKFLOW_NOT_ACTIVE");
      const version = await store.get<WorkflowVersion>(
        "workflow_versions",
        workflow.latestVersionId,
      );
      if (!version?.activatedAt) throw new Error("WORKFLOW_NOT_ACTIVE");
      validateWorkflowGraph(version.graph, registry);
      // Once any agent exists this workflow never falls back to account authority.
      const pin = await resolveAuthorityPin(db, id, version.id, new Date());
      const now = new Date().toISOString(),
        inputHash = hashCanonical(input);
      const run: WorkflowRun = {
        id: runId,
        workflowId: id,
        workflowVersionId: version.id,
        missionId: workflow.missionId,
        triggerKind: "manual",
        triggerOccurrenceId: null,
        executionSessionId: actor.sessionId ?? null,
        ...pin,
        inputSnapshot: structuredClone(input),
        inputHash,
        status: "QUEUED",
        pauseReason: null,
        revision: 0,
        leaseOwner: null,
        leaseExpiresAt: null,
        heartbeatAt: null,
        createdAt: now,
        startedAt: null,
        completedAt: null,
        cancelledAt: null,
        nextResumeAt: null,
      };
      const steps: StepRun[] = version.graph.nodes.map((node) => ({
        id: randomUUID(),
        runId,
        blockId: node.id,
        blockType: node.type,
        blockVersion: node.blockVersion,
        dependencies: [...node.dependsOn],
        status: "PENDING",
        attemptCount: 0,
        timeoutMs: node.timeoutMs,
        maxAttempts: node.maxAttempts,
        inputRef: null,
        inputHash: null,
        outputRef: null,
        outputHash: null,
        idempotencyKey: stepIdempotencyKey({
          versionId: version.id,
          runId,
          nodeId: node.id,
          occurrenceId: runId,
          inputHash,
        }),
        startedAt: null,
        completedAt: null,
        errorClass: null,
      }));
      try { await store.createRun(run, steps); }
      catch (error) {
        const raced = await store.get<WorkflowRun>("workflow_runs", runId);
        if (!raced) throw error;
        if (raced.inputHash !== run.inputHash) throw new Error("IDEMPOTENCY_CONFLICT");
      }
      return runDetail(actor, runId);
    },
    /** Authority pin for a new schedule; callers must have checked ownership. */
    authorityPin: (workflowId: string, versionId: string) =>
      resolveAuthorityPin(db, workflowId, versionId, new Date()),
    scheduleAuthorized: (schedule: WorkflowSchedule) =>
      scheduleAuthorityCurrent(db, schedule, new Date()),
    cancel: (actor: WorkflowActor, id: string) =>
      changeRun(actor, id, "CANCELLED"),
    resume: (actor: WorkflowActor, id: string) =>
      changeRun(actor, id, "QUEUED"),
  };
}
