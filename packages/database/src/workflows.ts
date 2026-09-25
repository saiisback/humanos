import * as v from "valibot";
import {
  WorkflowSchema,
  WorkflowVersionSchema,
  WorkflowRunSchema,
  StepRunSchema,
  StepAttemptSchema,
  WorkflowEventSchema,
  RunConfirmationSchema,
  WorkflowScheduleSchema,
  WorkflowReceiptSchema,
  hashCanonical,
  HexSchema,
  BoundedJsonValueSchema,
  type JsonValue,
  type Workflow,
  type WorkflowVersion,
  type WorkflowRun,
  type StepRun,
  type StepAttempt,
  type WorkflowEvent,
  type RunConfirmation,
  type WorkflowSchedule,
  type WorkflowReceipt,
  type Hex,
} from "@humanos/schemas";
import type { Database, Transaction } from "./index.js";

type WorkflowTable =
  | "workflows"
  | "workflow_versions"
  | "workflow_runs"
  | "workflow_steps"
  | "workflow_attempts"
  | "workflow_events"
  | "workflow_confirmations"
  | "workflow_schedules"
  | "workflow_receipts";
const tables = new Set<WorkflowTable>([
  "workflows",
  "workflow_versions",
  "workflow_runs",
  "workflow_steps",
  "workflow_attempts",
  "workflow_events",
  "workflow_confirmations",
  "workflow_schedules",
  "workflow_receipts",
]);
function tableName(table: WorkflowTable) {
  if (!tables.has(table)) throw new Error("UNKNOWN_TABLE");
  return table;
}
const json = (value: unknown) => JSON.stringify(value);
export interface WorkflowLease {
  runId: string;
  revision: number;
  workerId: string;
  now: Date;
}
export class WorkflowStore {
  constructor(private readonly db: Database) {}
  async saveValue(
    id: string,
    runId: string,
    value: JsonValue,
  ): Promise<string> {
    v.parse(BoundedJsonValueSchema, value);
    const valueHash = hashCanonical(value);
    await this.db.query(
      "INSERT INTO workflow_values(id,run_id,value_hash,data) VALUES($1,$2,$3,$4)",
      [id, runId, valueHash, json(value)],
    );
    return valueHash;
  }
  async getValue(id: string, runId: string): Promise<JsonValue | null> {
    return (
      (
        await this.db.query<{ data: JsonValue }>(
          "SELECT data FROM workflow_values WHERE id=$1 AND run_id=$2",
          [id, runId],
        )
      ).rows[0]?.data ?? null
    );
  }
  async recoverExpiredRuns(now: Date): Promise<number> {
    return this.db.transaction(async (tx) => {
      const rows = await tx.query<{ data: WorkflowRun }>(
        "SELECT data FROM workflow_runs WHERE status='RUNNING' AND lease_expires_at <= $1 FOR UPDATE SKIP LOCKED",
        [now.toISOString()],
      );
      for (const { data: run } of rows.rows) {
        await this.writeRun(tx, {
          ...run,
          status: "RECONCILIATION_REQUIRED",
          revision: run.revision + 1,
          leaseOwner: null,
          leaseExpiresAt: null,
          pauseReason:
            "Worker lease expired; reconcile in-flight actions before resuming.",
        });
        const sequence = Number(
          (
            await tx.query<{ sequence: string }>(
              "SELECT COALESCE(MAX(sequence),0)+1 AS sequence FROM workflow_events WHERE run_id=$1",
              [run.id],
            )
          ).rows[0]!.sequence,
        );
        const event: WorkflowEvent = {
          id: hashCanonical({
            runId: run.id,
            revision: run.revision + 1,
            type: "lease_expired",
          }),
          runId: run.id,
          stepRunId: null,
          sequence,
          type: "lease_expired",
          data: {},
          createdAt: now.toISOString(),
        };
        await tx.query(
          "INSERT INTO workflow_events(id,run_id,sequence,data) VALUES($1,$2,$3,$4)",
          [event.id, run.id, sequence, json(event)],
        );
      }
      return rows.rows.length;
    });
  }
  async get<T>(table: WorkflowTable, id: string): Promise<T | null> {
    return (
      (
        await this.db.query<{ data: T }>(
          `SELECT data FROM ${tableName(table)} WHERE id=$1`,
          [id],
        )
      ).rows[0]?.data ?? null
    );
  }
  async list<T>(table: WorkflowTable): Promise<T[]> {
    return (
      await this.db.query<{ data: T }>(
        `SELECT data FROM ${tableName(table)} ORDER BY id`,
      )
    ).rows.map((r) => r.data);
  }
  async createDraft(
    workflow: Workflow,
    version: WorkflowVersion,
  ): Promise<void> {
    v.parse(WorkflowSchema, workflow);
    v.parse(WorkflowVersionSchema, version);
    if (
      version.workflowId !== workflow.id ||
      version.activatedAt !== null ||
      version.graphHash !== hashCanonical(version.graph)
    )
      throw new Error("INVALID_VERSION");
    await this.db.transaction(async (tx) => {
      await tx.query(
        "INSERT INTO workflows(id,account_id,root_id,mission_id,data) VALUES($1,$2,$3,$4,$5)",
        [
          workflow.id,
          workflow.accountId,
          workflow.rootId,
          workflow.missionId,
          json(workflow),
        ],
      );
      await this.writeVersion(tx, version);
    });
  }
  private async writeVersion(tx: Transaction, version: WorkflowVersion) {
    v.parse(WorkflowVersionSchema, version);
    if (version.graphHash !== hashCanonical(version.graph))
      throw new Error("GRAPH_CHANGED");
    await tx.query(
      "INSERT INTO workflow_versions(id,workflow_id,version,graph_hash,data) VALUES($1,$2,$3,$4,$5)",
      [
        version.id,
        version.workflowId,
        version.version,
        version.graphHash,
        json(version),
      ],
    );
  }
  async insertVersion(version: WorkflowVersion) {
    await this.db.transaction((tx) => this.writeVersion(tx, version));
  }
  async updateVersion(version: WorkflowVersion) {
    v.parse(WorkflowVersionSchema, version);
    await this.db.transaction(async (tx) => {
      const current = (
        await tx.query<{ data: WorkflowVersion }>(
          "SELECT data FROM workflow_versions WHERE id=$1 FOR UPDATE",
          [version.id],
        )
      ).rows[0]?.data;
      if (!current) throw new Error("VERSION_NOT_FOUND");
      if (current.activatedAt !== null) throw new Error("IMMUTABLE_VERSION");
      if (
        version.activatedAt !== null ||
        version.workflowId !== current.workflowId ||
        version.version !== current.version ||
        version.graphHash !== hashCanonical(version.graph)
      )
        throw new Error("INVALID_VERSION");
      await tx.query(
        "UPDATE workflow_versions SET graph_hash=$2,data=$3 WHERE id=$1",
        [version.id, version.graphHash, json(version)],
      );
    });
  }
  async activateVersion(
    workflowId: string,
    versionId: string,
    expectedGraphHash: string,
    now = new Date(),
  ): Promise<WorkflowVersion> {
    v.parse(HexSchema, expectedGraphHash);
    return this.db.transaction(async (tx) => {
      const workflow = (
        await tx.query<{ data: Workflow }>(
          "SELECT data FROM workflows WHERE id=$1 FOR UPDATE",
          [workflowId],
        )
      ).rows[0]?.data;
      const version = (
        await tx.query<{ data: WorkflowVersion }>(
          "SELECT data FROM workflow_versions WHERE id=$1 AND workflow_id=$2 FOR UPDATE",
          [versionId, workflowId],
        )
      ).rows[0]?.data;
      if (!workflow || !version) throw new Error("VERSION_NOT_FOUND");
      if (
        version.graphHash !== expectedGraphHash ||
        hashCanonical(version.graph) !== expectedGraphHash
      )
        throw new Error("GRAPH_CHANGED");
      const active = {
        ...version,
        activatedAt: version.activatedAt ?? now.toISOString(),
      };
      await tx.query("UPDATE workflow_versions SET data=$2 WHERE id=$1", [
        versionId,
        json(active),
      ]);
      await tx.query("UPDATE workflows SET data=$2 WHERE id=$1", [
        workflowId,
        json({
          ...workflow,
          status: "ACTIVE",
          latestVersionId: versionId,
          updatedAt: now.toISOString(),
        }),
      ]);
      return active;
    });
  }
  private async insertRun(
    tx: Transaction,
    run: WorkflowRun,
    steps: readonly StepRun[],
  ) {
    v.parse(WorkflowRunSchema, run);
    if (run.inputHash !== hashCanonical(run.inputSnapshot))
      throw new Error("INPUT_CHANGED");
    const version = (
      await tx.query<{ data: WorkflowVersion }>(
        "SELECT data FROM workflow_versions WHERE id=$1 AND workflow_id=$2",
        [run.workflowVersionId, run.workflowId],
      )
    ).rows[0]?.data;
    if (!version?.activatedAt) throw new Error("VERSION_NOT_ACTIVE");
    if (
      run.status !== "QUEUED" ||
      run.revision !== 0 ||
      run.leaseOwner !== null ||
      run.leaseExpiresAt !== null
    )
      throw new Error("INVALID_INITIAL_RUN");
    if (
      steps.length !== version.graph.nodes.length ||
      new Set(steps.map((s) => s.blockId)).size !== steps.length
    )
      throw new Error("STEP_SNAPSHOT_MISMATCH");
    for (const step of steps) {
      const node = version.graph.nodes.find((n) => n.id === step.blockId);
      if (
        !node ||
        step.blockType !== node.type ||
        step.blockVersion !== node.blockVersion ||
        hashCanonical(step.dependencies) !== hashCanonical(node.dependsOn) ||
        step.timeoutMs !== node.timeoutMs ||
        step.maxAttempts !== node.maxAttempts ||
        step.status !== "PENDING" ||
        step.attemptCount !== 0
      )
        throw new Error("STEP_SNAPSHOT_MISMATCH");
    }
    await tx.query(
      "INSERT INTO workflow_runs(id,workflow_id,version_id,status,revision,lease_expires_at,next_resume_at,data) VALUES($1,$2,$3,$4,$5,$6,$7,$8)",
      [
        run.id,
        run.workflowId,
        run.workflowVersionId,
        run.status,
        run.revision,
        run.leaseExpiresAt,
        run.nextResumeAt,
        json(run),
      ],
    );
    for (const step of steps) {
      v.parse(StepRunSchema, step);
      if (step.runId !== run.id) throw new Error("STEP_RUN_MISMATCH");
      await tx.query(
        "INSERT INTO workflow_steps(id,run_id,block_id,idempotency_key,data) VALUES($1,$2,$3,$4,$5)",
        [step.id, run.id, step.blockId, step.idempotencyKey, json(step)],
      );
    }
  }
  async createRun(run: WorkflowRun, steps: readonly StepRun[]) {
    await this.db.transaction((tx) => this.insertRun(tx, run, steps));
  }
  async claimNextRun(
    workerId: string,
    now: Date,
    leaseMs: number,
  ): Promise<WorkflowRun | null> {
    if (
      !workerId ||
      !Number.isInteger(leaseMs) ||
      leaseMs < 100 ||
      leaseMs > 300000
    )
      throw new Error("INVALID_LEASE");
    return this.db.transaction(async (tx) => {
      const current = (
        await tx.query<{ data: WorkflowRun }>(
          "SELECT data FROM workflow_runs WHERE status='QUEUED' AND (next_resume_at IS NULL OR next_resume_at <= $1) ORDER BY id FOR UPDATE SKIP LOCKED LIMIT 1",
          [now.toISOString()],
        )
      ).rows[0]?.data;
      if (!current) return null;
      const next: WorkflowRun = {
        ...current,
        status: "RUNNING",
        revision: current.revision + 1,
        leaseOwner: workerId,
        leaseExpiresAt: new Date(now.getTime() + leaseMs).toISOString(),
        heartbeatAt: now.toISOString(),
        startedAt: current.startedAt ?? now.toISOString(),
      };
      await this.writeRun(tx, next);
      const sequence = Number(
        (
          await tx.query<{ sequence: string }>(
            "SELECT COALESCE(MAX(sequence),0)+1 AS sequence FROM workflow_events WHERE run_id=$1",
            [current.id],
          )
        ).rows[0]!.sequence,
      );
      const event: WorkflowEvent = {
        id: hashCanonical({
          runId: current.id,
          revision: next.revision,
          type: "claimed",
        }),
        runId: current.id,
        stepRunId: null,
        sequence,
        type: "claimed",
        data: { workerId },
        createdAt: now.toISOString(),
      };
      await tx.query(
        "INSERT INTO workflow_events(id,run_id,sequence,data) VALUES($1,$2,$3,$4)",
        [event.id, event.runId, event.sequence, json(event)],
      );
      return next;
    });
  }
  private async writeRun(tx: Transaction, run: WorkflowRun) {
    v.parse(WorkflowRunSchema, run);
    await tx.query(
      "UPDATE workflow_runs SET status=$2,revision=$3,lease_expires_at=$4,next_resume_at=$5,data=$6 WHERE id=$1",
      [
        run.id,
        run.status,
        run.revision,
        run.leaseExpiresAt,
        run.nextResumeAt,
        json(run),
      ],
    );
  }
  private assertRunChange(
    current: WorkflowRun,
    next: WorkflowRun,
    event: WorkflowEvent,
  ) {
    if (
      next.id !== current.id ||
      next.revision !== current.revision + 1 ||
      next.workflowId !== current.workflowId ||
      next.workflowVersionId !== current.workflowVersionId ||
      next.inputHash !== current.inputHash ||
      hashCanonical(next.inputSnapshot) !== current.inputHash ||
      event.runId !== current.id
    )
      throw new Error("IMMUTABLE_RUN_INPUT");
    v.parse(WorkflowEventSchema, event);
  }
  private async appendEvent(tx: Transaction, event: WorkflowEvent) {
    await tx.query(
      "INSERT INTO workflow_events(id,run_id,sequence,data) VALUES($1,$2,$3,$4)",
      [event.id, event.runId, event.sequence, json(event)],
    );
  }
  private retainLiveHeartbeat(
    current: WorkflowRun,
    next: WorkflowRun,
  ): WorkflowRun {
    if (
      current.status !== "RUNNING" ||
      next.status !== "RUNNING" ||
      current.leaseOwner === null ||
      next.leaseOwner !== current.leaseOwner
    )
      return next;
    const latest = (first: string | null, second: string | null) =>
      first === null
        ? second
        : second === null
          ? first
          : Date.parse(first) >= Date.parse(second)
            ? first
            : second;
    return {
      ...next,
      heartbeatAt: latest(current.heartbeatAt, next.heartbeatAt),
      leaseExpiresAt: latest(current.leaseExpiresAt, next.leaseExpiresAt),
    };
  }
  async compareAndSwapRun(
    id: string,
    expectedRevision: number,
    next: WorkflowRun,
    event: WorkflowEvent,
  ) {
    await this.db.transaction(async (tx) => {
      const current = (
        await tx.query<{ data: WorkflowRun }>(
          "SELECT data FROM workflow_runs WHERE id=$1 FOR UPDATE",
          [id],
        )
      ).rows[0]?.data;
      if (!current || current.revision !== expectedRevision)
        throw new Error("REVISION_CONFLICT");
      this.assertRunChange(current, next, event);
      await this.writeRun(tx, this.retainLiveHeartbeat(current, next));
      await this.appendEvent(tx, event);
    });
  }
  private async assertLease(
    tx: Transaction,
    lease: WorkflowLease,
  ): Promise<WorkflowRun> {
    const run = (
      await tx.query<{ data: WorkflowRun }>(
        "SELECT data FROM workflow_runs WHERE id=$1 FOR UPDATE",
        [lease.runId],
      )
    ).rows[0]?.data;
    if (
      !run ||
      run.status !== "RUNNING" ||
      run.revision !== lease.revision ||
      run.leaseOwner !== lease.workerId ||
      !run.leaseExpiresAt ||
      Date.parse(run.leaseExpiresAt) <= lease.now.getTime()
    )
      throw new Error("LEASE_LOST");
    return run;
  }
  async heartbeat(lease: WorkflowLease, leaseMs: number): Promise<WorkflowRun> {
    if (!Number.isInteger(leaseMs) || leaseMs < 100 || leaseMs > 300000)
      throw new Error("INVALID_LEASE");
    return this.db.transaction(async (tx) => {
      const run = await this.assertLease(tx, lease);
      const next = {
        ...run,
        heartbeatAt: lease.now.toISOString(),
        leaseExpiresAt: new Date(lease.now.getTime() + leaseMs).toISOString(),
      };
      await this.writeRun(tx, next);
      return next;
    });
  }
  async updateStep(step: StepRun, lease: WorkflowLease) {
    v.parse(StepRunSchema, step);
    await this.db.transaction(async (tx) => {
      await this.assertLease(tx, lease);
      await this.updateStepInTx(tx, step, lease);
    });
  }
  private async updateStepInTx(
    tx: Transaction,
    step: StepRun,
    lease: WorkflowLease,
  ) {
    const current = (
      await tx.query<{ data: StepRun }>(
        "SELECT data FROM workflow_steps WHERE id=$1 AND run_id=$2 FOR UPDATE",
        [step.id, lease.runId],
      )
    ).rows[0]?.data;
    if (
      !current ||
      step.runId !== lease.runId ||
      step.blockId !== current.blockId ||
      step.blockType !== current.blockType ||
      step.blockVersion !== current.blockVersion ||
      step.idempotencyKey !== current.idempotencyKey ||
      hashCanonical(step.dependencies) !==
        hashCanonical(current.dependencies) ||
      step.timeoutMs !== current.timeoutMs ||
      step.maxAttempts !== current.maxAttempts
    )
      throw new Error("IMMUTABLE_STEP");
    await tx.query("UPDATE workflow_steps SET data=$2 WHERE id=$1", [
      step.id,
      json(step),
    ]);
  }
  async recordAttempt(attempt: StepAttempt, lease: WorkflowLease) {
    v.parse(StepAttemptSchema, attempt);
    await this.db.transaction(async (tx) => {
      await this.assertLease(tx, lease);
      const step = (
        await tx.query(
          "SELECT id FROM workflow_steps WHERE id=$1 AND run_id=$2",
          [attempt.stepRunId, lease.runId],
        )
      ).rows[0];
      if (!step) throw new Error("STEP_RUN_MISMATCH");
      await tx.query(
        "INSERT INTO workflow_attempts(id,step_id,attempt_number,data) VALUES($1,$2,$3,$4)",
        [attempt.id, attempt.stepRunId, attempt.attemptNumber, json(attempt)],
      );
    });
  }
  async insertConfirmation(confirmation: RunConfirmation) {
    v.parse(RunConfirmationSchema, confirmation);
    const owner = (
      await this.db.query<{ account_id: string }>(
        "SELECT w.account_id FROM workflows w JOIN workflow_runs r ON r.workflow_id=w.id WHERE r.id=$1",
        [confirmation.runId],
      )
    ).rows[0]?.account_id;
    if (owner !== confirmation.actorAccountId)
      throw new Error("CONFIRMATION_MISMATCH");
    await this.db.query(
      "INSERT INTO workflow_confirmations(id,run_id,step_id,data) VALUES($1,$2,$3,$4)",
      [
        confirmation.id,
        confirmation.runId,
        confirmation.stepRunId,
        json(confirmation),
      ],
    );
  }
  async completeAttempt(attempt: StepAttempt, lease: WorkflowLease) {
    v.parse(StepAttemptSchema, attempt);
    await this.db.transaction(async (tx) => {
      await this.assertLease(tx, lease);
      await this.completeAttemptInTx(tx, attempt, lease);
    });
  }
  private async completeAttemptInTx(
    tx: Transaction,
    attempt: StepAttempt,
    lease: WorkflowLease,
  ) {
    const current = (
      await tx.query<{ data: StepAttempt }>(
        "SELECT a.data FROM workflow_attempts a JOIN workflow_steps s ON s.id=a.step_id WHERE a.id=$1 AND s.run_id=$2 FOR UPDATE OF a",
        [attempt.id, lease.runId],
      )
    ).rows[0]?.data;
    if (
      !current ||
      current.completedAt !== null ||
      attempt.completedAt === null ||
      current.stepRunId !== attempt.stepRunId ||
      current.attemptNumber !== attempt.attemptNumber ||
      current.startedAt !== attempt.startedAt ||
      current.requestHash !== attempt.requestHash ||
      current.executor !== attempt.executor ||
      current.provider !== attempt.provider
    )
      throw new Error("IMMUTABLE_ATTEMPT");
    await tx.query("UPDATE workflow_attempts SET data=$2 WHERE id=$1", [
      attempt.id,
      json(attempt),
    ]);
  }
  async checkpoint(
    lease: WorkflowLease,
    nextRun: WorkflowRun,
    step: StepRun,
    attempt: StepAttempt,
    event: WorkflowEvent,
    receipt?: WorkflowReceipt,
  ): Promise<void> {
    v.parse(StepRunSchema, step);
    v.parse(StepAttemptSchema, attempt);
    if (receipt) v.parse(WorkflowReceiptSchema, receipt);
    await this.db.transaction(async (tx) => {
      const current = await this.assertLease(tx, lease);
      this.assertRunChange(current, nextRun, event);
      if (
        step.runId !== lease.runId ||
        attempt.stepRunId !== step.id ||
        event.stepRunId !== step.id ||
        (receipt &&
          (receipt.runId !== lease.runId ||
            receipt.stepRunId !== step.id ||
            attempt.receiptId !== receipt.id))
      )
        throw new Error("STEP_RUN_MISMATCH");
      await this.completeAttemptInTx(tx, attempt, lease);
      await this.updateStepInTx(tx, step, lease);
      await this.writeRun(tx, this.retainLiveHeartbeat(current, nextRun));
      await this.appendEvent(tx, event);
      if (receipt)
        await tx.query(
          "INSERT INTO workflow_receipts(id,run_id,step_id,data) VALUES($1,$2,$3,$4)",
          [receipt.id, receipt.runId, receipt.stepRunId, json(receipt)],
        );
    });
  }
  async claimConfirmedDispatch(input: WorkflowLease & { confirmationId: string; stepId: string; accountId: string; payloadHash: string; idempotencyKey: string }): Promise<boolean> {
    v.parse(HexSchema, input.payloadHash);
    v.parse(HexSchema, input.idempotencyKey);
    return this.db.transaction(async tx => {
      const run = (await tx.query<{ data: WorkflowRun }>("SELECT data FROM workflow_runs WHERE id=$1 FOR UPDATE", [input.runId])).rows[0]?.data;
      if (!run || run.status !== "RUNNING" || run.revision !== input.revision || run.leaseOwner !== input.workerId || !input.workerId || !run.leaseExpiresAt || Date.parse(run.leaseExpiresAt) <= input.now.getTime()) return false;
      const confirmation = (await tx.query<{ data: RunConfirmation }>("SELECT data FROM workflow_confirmations WHERE id=$1", [input.confirmationId])).rows[0]?.data;
      const step = (await tx.query<{ data: StepRun }>("SELECT data FROM workflow_steps WHERE id=$1", [input.stepId])).rows[0]?.data;
      if (!confirmation || confirmation.status !== "CONSUMED" || confirmation.runId !== input.runId || confirmation.stepRunId !== input.stepId || confirmation.actorAccountId !== input.accountId || confirmation.payloadHash !== input.payloadHash || Date.parse(confirmation.expiresAt) <= input.now.getTime() || !step || step.runId !== input.runId || step.status !== "RUNNING" || step.idempotencyKey !== input.idempotencyKey) return false;
      const result = await tx.query("INSERT INTO workflow_dispatch_claims(step_id,confirmation_id,claimed_at) VALUES($1,$2,$3) ON CONFLICT(step_id) DO NOTHING", [input.stepId, input.confirmationId, input.now.toISOString()]);
      return result.rowCount === 1;
    });
  }
  async consumeConfirmation(
    id: string,
    expectedPayloadHash: string,
    now: Date,
    actorAccountId: string,
    resume = false,
  ): Promise<RunConfirmation> {
    v.parse(HexSchema, expectedPayloadHash);
    return this.db.transaction(async (tx) => {
      const ownerRow = (
        await tx.query<{ run_id: string }>(
          "SELECT run_id FROM workflow_confirmations WHERE id=$1",
          [id],
        )
      ).rows[0];
      const run = ownerRow
        ? (
            await tx.query<{ data: WorkflowRun }>(
              "SELECT data FROM workflow_runs WHERE id=$1 FOR UPDATE",
              [ownerRow.run_id],
            )
          ).rows[0]?.data
        : null;
      if (!run || run.status !== "CONFIRMATION_REQUIRED")
        throw new Error("CONFIRMATION_UNAVAILABLE");
      const current = (
        await tx.query<{ data: RunConfirmation }>(
          "SELECT data FROM workflow_confirmations WHERE id=$1 FOR UPDATE",
          [id],
        )
      ).rows[0]?.data;
      if (
        !current ||
        current.payloadHash !== expectedPayloadHash ||
        current.actorAccountId !== actorAccountId
      )
        throw new Error("CONFIRMATION_MISMATCH");
      if (
        current.status !== "PENDING" ||
        Date.parse(current.expiresAt) <= now.getTime()
      )
        throw new Error("CONFIRMATION_UNAVAILABLE");
      const next: RunConfirmation = {
        ...current,
        status: "CONSUMED",
        consumedAt: now.toISOString(),
      };
      v.parse(RunConfirmationSchema, next);
      await tx.query("UPDATE workflow_confirmations SET data=$2 WHERE id=$1", [
        id,
        json(next),
      ]);
      if (resume) {
        const resumed: WorkflowRun = { ...run, status: "QUEUED", revision: run.revision + 1, pauseReason: null, nextResumeAt: null, leaseOwner: null, leaseExpiresAt: null };
        const sequence = Number((await tx.query<{ sequence: string }>("SELECT COALESCE(MAX(sequence),0)+1 AS sequence FROM workflow_events WHERE run_id=$1", [run.id])).rows[0]!.sequence);
        const event: WorkflowEvent = { id: `${id}:approved`, runId: run.id, stepRunId: current.stepRunId, sequence, type: "run.confirmed", data: { confirmationId: id, payloadHash: expectedPayloadHash }, createdAt: now.toISOString() };
        this.assertRunChange(run, resumed, event);
        await this.writeRun(tx, resumed);
        await this.appendEvent(tx, event);
      }
      return next;
    });
  }
  async saveSchedule(schedule: WorkflowSchedule) {
    v.parse(WorkflowScheduleSchema, schedule);
    const saved = await this.db.query(
      "INSERT INTO workflow_schedules(id,workflow_id,version_id,status,next_fire_at,data) VALUES($1,$2,$3,$4,$5,$6) ON CONFLICT(id) DO UPDATE SET status=EXCLUDED.status,next_fire_at=EXCLUDED.next_fire_at,data=EXCLUDED.data WHERE workflow_schedules.workflow_id=EXCLUDED.workflow_id AND workflow_schedules.version_id=EXCLUDED.version_id",
      [
        schedule.id,
        schedule.workflowId,
        schedule.workflowVersionId,
        schedule.status,
        schedule.nextFireAt,
        json(schedule),
      ],
    );
    if (saved.rowCount !== 1) throw new Error("SCHEDULE_MISMATCH");
  }
  /** Guarded schedule advancement: compares the entire snapshot, not a possibly colliding timestamp. */
  async compareAndSwapSchedule(expected: WorkflowSchedule, next: WorkflowSchedule): Promise<void> {
    v.parse(WorkflowScheduleSchema, next);
    await this.db.transaction(async (tx) => {
      const current = (await tx.query<{ data: WorkflowSchedule }>(
        "SELECT data FROM workflow_schedules WHERE id=$1 FOR UPDATE", [expected.id],
      )).rows[0]?.data;
      if (!current || hashCanonical(current) !== hashCanonical(expected) ||
          next.id !== current.id || next.workflowId !== current.workflowId ||
          next.workflowVersionId !== current.workflowVersionId ||
          next.executionSessionId !== current.executionSessionId)
        throw new Error("SCHEDULE_CONFLICT");
      await tx.query("UPDATE workflow_schedules SET status=$2,next_fire_at=$3,data=$4 WHERE id=$1", [
        next.id, next.status, next.nextFireAt, json(next),
      ]);
    });
  }
  async recordReceipt(receipt: WorkflowReceipt) {
    v.parse(WorkflowReceiptSchema, receipt);
    await this.db.query(
      "INSERT INTO workflow_receipts(id,run_id,step_id,data) VALUES($1,$2,$3,$4)",
      [receipt.id, receipt.runId, receipt.stepRunId, json(receipt)],
    );
  }
  async createOccurrence(
    scheduleId: string,
    occurrenceAt: string,
    run: WorkflowRun,
    steps: readonly StepRun[] = [],
  ): Promise<boolean> {
    return this.db.transaction(async (tx) => {
      const schedule = (
        await tx.query<{ data: WorkflowSchedule }>(
          "SELECT data FROM workflow_schedules WHERE id=$1 FOR UPDATE",
          [scheduleId],
        )
      ).rows[0]?.data;
      if (
        !schedule ||
        schedule.status !== "ACTIVE" ||
        schedule.nextFireAt !== occurrenceAt ||
        schedule.workflowId !== run.workflowId ||
        schedule.workflowVersionId !== run.workflowVersionId
      )
        throw new Error("SCHEDULE_MISMATCH");
      // Serialize overlap checks across different schedules for the same workflow.
      await tx.query("SELECT id FROM workflows WHERE id=$1 FOR UPDATE", [
        schedule.workflowId,
      ]);
      if (
        (
          await tx.query(
            "SELECT 1 FROM workflow_occurrences WHERE schedule_id=$1 AND occurrence_at=$2",
            [scheduleId, occurrenceAt],
          )
        ).rowCount
      )
        return false;
      const overlap = (
        await tx.query(
          "SELECT id FROM workflow_runs WHERE workflow_id=$1 AND status NOT IN ('COMPLETED','FAILED','CANCELLED','REVOKED') LIMIT 1",
          [schedule.workflowId],
        )
      ).rowCount;
      if (overlap) {
        await tx.query(
          "INSERT INTO workflow_occurrences(schedule_id,occurrence_at,run_id,status) VALUES($1,$2,NULL,'SKIPPED')",
          [scheduleId, occurrenceAt],
        );
        return false;
      }
      await this.insertRun(tx, run, steps);
      await tx.query(
        "INSERT INTO workflow_occurrences(schedule_id,occurrence_at,run_id,status) VALUES($1,$2,$3,'CREATED')",
        [scheduleId, occurrenceAt, run.id],
      );
      return true;
    });
  }
}
