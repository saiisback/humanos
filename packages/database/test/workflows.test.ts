import { afterAll, beforeAll, expect, it } from "vitest";
import {
  hashCanonical,
  type Workflow,
  type WorkflowVersion,
  type WorkflowRun,
  type RunConfirmation,
  type StepAttempt,
  type StepRun,
  type WorkflowReceipt,
} from "@humanos/schemas";
import { Database, WorkflowStore } from "../src/index.js";

const schema = `test_workflows_${Date.now()}`;
const db = new Database(
  process.env.TEST_DATABASE_URL ??
    "postgresql://saikarthik@127.0.0.1:55432/humanos",
  { schema },
);
const store = new WorkflowStore(db);
const stamp = "2026-09-26T00:00:00.000Z";
const account = {
  id: "11155111:0x1111111111111111111111111111111111111111",
  address: "0x1111111111111111111111111111111111111111",
  chainId: 11155111,
  createdAt: stamp,
};
function draft(id: string): [Workflow, WorkflowVersion] {
  const version: WorkflowVersion = {
    id: `${id}-v1`,
    workflowId: id,
    version: 1,
    goal: "Draft",
    normalizedIntent: {},
    graph: { nodes: [] },
    graphHash: hashCanonical({ nodes: [] }),
    requiredCapabilities: [],
    connectorRefs: [],
    browserFallbackAllowed: false,
    trigger: { kind: "manual" },
    assembler: {
      modelId: "jev-1.13",
      modelVersion: "1",
      decisionHash: hashCanonical({}),
    },
    createdAt: stamp,
    activatedAt: null,
  };
  return [
    {
      id,
      accountId: account.id,
      rootId: null,
      missionId: null,
      name: "Draft",
      status: "DRAFT",
      latestVersionId: version.id,
      createdAt: stamp,
      updatedAt: stamp,
      archivedAt: null,
    },
    version,
  ];
}
function run(id: string, workflowId: string): WorkflowRun {
  return {
    id,
    workflowId,
    workflowVersionId: `${workflowId}-v1`,
    missionId: null,
    triggerKind: "manual",
    triggerOccurrenceId: null,
    inputSnapshot: {},
    inputHash: hashCanonical({}),
    status: "QUEUED",
    pauseReason: null,
    revision: 0,
    leaseOwner: null,
    leaseExpiresAt: null,
    heartbeatAt: null,
    createdAt: stamp,
    startedAt: null,
    completedAt: null,
    cancelledAt: null,
    nextResumeAt: null,
  };
}
beforeAll(async () => {
  await db.migrate();
  await db.migrate();
  await db.insert("accounts", account);
});
afterAll(async () => {
  await db.query(`DROP SCHEMA "${schema}" CASCADE`);
  await db.close();
});
it("activates only the exact reviewed version and keeps it immutable", async () => {
  const [workflow, version] = draft("immutable");
  await store.createDraft(workflow, version);
  await expect(
    store.activateVersion(
      workflow.id,
      version.id,
      hashCanonical("wrong"),
      new Date(stamp),
    ),
  ).rejects.toThrow("GRAPH_CHANGED");
  const activated = await store.activateVersion(
    workflow.id,
    version.id,
    version.graphHash,
    new Date(stamp),
  );
  expect(activated.activatedAt).toBe(stamp);
  await expect(
    store.updateVersion({ ...activated, goal: "Changed" }),
  ).rejects.toThrow("IMMUTABLE_VERSION");
});
it("lets only one worker claim a queued run", async () => {
  const [workflow, version] = draft("claim");
  await store.createDraft(workflow, version);
  await store.activateVersion(
    workflow.id,
    version.id,
    version.graphHash,
    new Date(stamp),
  );
  await store.createRun(run("claim-run", workflow.id), []);
  const claims = await Promise.all([
    store.claimNextRun("worker-a", new Date(stamp), 30000),
    store.claimNextRun("worker-b", new Date(stamp), 30000),
  ]);
  expect(claims.filter(Boolean)).toHaveLength(1);
  expect(claims.find(Boolean)).toMatchObject({
    status: "RUNNING",
    revision: 1,
  });
});
it("appends the next audit event when claiming a queued run", async () => {
  const [workflow, version] = draft("claim-audit");
  await store.createDraft(workflow, version);
  await store.activateVersion(
    workflow.id,
    version.id,
    version.graphHash,
    new Date(stamp),
  );
  await store.createRun(run("claim-audit-run", workflow.id), []);
  await db.query(
    "INSERT INTO workflow_events(id,run_id,sequence,data) VALUES($1,$2,$3,$4)",
    [
      "claim-audit-earlier",
      "claim-audit-run",
      7,
      JSON.stringify({
        id: "claim-audit-earlier",
        runId: "claim-audit-run",
        stepRunId: null,
        sequence: 7,
        type: "queued",
        data: {},
        createdAt: stamp,
      }),
    ],
  );
  const claimed = await store.claimNextRun(
    "audit-worker",
    new Date(stamp),
    30000,
  );
  expect(claimed?.id).toBe("claim-audit-run");
  expect(
    await db.query<{ sequence: string; data: { type: string } }>(
      "SELECT sequence,data FROM workflow_events WHERE run_id=$1 ORDER BY sequence",
      ["claim-audit-run"],
    ),
  ).toMatchObject({
    rows: [
      { sequence: "7", data: { type: "queued" } },
      { sequence: "8", data: { type: "claimed" } },
    ],
  });
});
it("rolls back a claim when its audit event cannot be inserted", async () => {
  const [workflow, version] = draft("claim-rollback");
  await store.createDraft(workflow, version);
  await store.activateVersion(
    workflow.id,
    version.id,
    version.graphHash,
    new Date(stamp),
  );
  await store.createRun(run("claim-rollback-run", workflow.id), []);
  await db.query(
    "ALTER TABLE workflow_events ADD CONSTRAINT reject_claim_rollback_event CHECK (run_id <> 'claim-rollback-run')",
  );
  try {
    await expect(
      store.claimNextRun("rollback-worker", new Date(stamp), 30000),
    ).rejects.toThrow();
  } finally {
    await db.query(
      "ALTER TABLE workflow_events DROP CONSTRAINT reject_claim_rollback_event",
    );
  }
  expect(
    await store.get<WorkflowRun>("workflow_runs", "claim-rollback-run"),
  ).toMatchObject({
    status: "QUEUED",
    revision: 0,
    leaseOwner: null,
  });
  expect(
    (
      await db.query("SELECT id FROM workflow_events WHERE run_id=$1", [
        "claim-rollback-run",
      ])
    ).rows,
  ).toEqual([]);
  await store.claimNextRun("rollback-worker", new Date(stamp), 30000);
});
it("keeps a heartbeat extension through a stale running CAS snapshot", async () => {
  const [workflow, version] = draft("heartbeat-cas");
  await store.createDraft(workflow, version);
  await store.activateVersion(
    workflow.id,
    version.id,
    version.graphHash,
    new Date(stamp),
  );
  await store.createRun(run("heartbeat-cas-run", workflow.id), []);
  const snapshot = await store.claimNextRun(
    "heartbeat-worker",
    new Date(stamp),
    30000,
  );
  expect(snapshot?.id).toBe("heartbeat-cas-run");
  const heartbeatAt = new Date("2026-09-26T00:00:15.000Z");
  await store.heartbeat(
    {
      runId: snapshot!.id,
      revision: snapshot!.revision,
      workerId: "heartbeat-worker",
      now: heartbeatAt,
    },
    30000,
  );
  await store.compareAndSwapRun(
    snapshot!.id,
    snapshot!.revision,
    { ...snapshot!, revision: snapshot!.revision + 1 },
    {
      id: "heartbeat-cas-event",
      runId: snapshot!.id,
      stepRunId: null,
      sequence: 2,
      type: "progress",
      data: {},
      createdAt: heartbeatAt.toISOString(),
    },
  );
  expect(
    await store.get<WorkflowRun>("workflow_runs", snapshot!.id),
  ).toMatchObject({
    status: "RUNNING",
    revision: 2,
    leaseOwner: "heartbeat-worker",
    heartbeatAt: "2026-09-26T00:00:15.000Z",
    leaseExpiresAt: "2026-09-26T00:00:45.000Z",
  });
});
it("checkpoints attempt, step, run, event, and receipt atomically under a live lease", async () => {
  const [workflow, version] = draft("checkpoint");
  version.graph = {
    nodes: [
      {
        id: "effect",
        type: "human.confirm",
        blockVersion: "1.0.0",
        dependsOn: [],
        input: {},
        capability: null,
        timeoutMs: 1000,
        maxAttempts: 1,
      },
    ],
  };
  version.graphHash = hashCanonical(version.graph);
  await store.createDraft(workflow, version);
  await store.activateVersion(
    workflow.id,
    version.id,
    version.graphHash,
    new Date(stamp),
  );
  const step: StepRun = {
    id: "checkpoint-step",
    runId: "checkpoint-run",
    blockId: "effect",
    blockType: "human.confirm",
    blockVersion: "1.0.0",
    dependencies: [],
    status: "PENDING",
    attemptCount: 0,
    timeoutMs: 1000,
    maxAttempts: 1,
    inputRef: null,
    inputHash: null,
    outputRef: null,
    outputHash: null,
    idempotencyKey: hashCanonical("checkpoint-step"),
    startedAt: null,
    completedAt: null,
    errorClass: null,
  };
  await store.createRun(run("checkpoint-run", workflow.id), [step]);
  const claimed = await store.claimNextRun(
    "checkpoint-worker",
    new Date(stamp),
    30000,
  );
  expect(claimed?.id).toBe("checkpoint-run");
  const lease = {
    runId: claimed!.id,
    revision: claimed!.revision,
    workerId: "checkpoint-worker",
    now: new Date(stamp),
  };
  const attempt: StepAttempt = {
    id: "checkpoint-attempt",
    stepRunId: step.id,
    attemptNumber: 1,
    executor: "connector",
    provider: null,
    metadata: {},
    requestHash: null,
    responseHash: null,
    requestPreview: null,
    responsePreview: null,
    jevDecision: null,
    errorClass: null,
    errorMessage: null,
    startedAt: stamp,
    completedAt: null,
    receiptId: null,
  };
  await store.recordAttempt(attempt, lease);
  const nextAttempt: StepAttempt = {
    ...attempt,
    completedAt: stamp,
    receiptId: "checkpoint-receipt",
  };
  const nextStep: StepRun = {
    ...step,
    status: "COMPLETED",
    attemptCount: 1,
    startedAt: stamp,
    completedAt: stamp,
  };
  const nextRun: WorkflowRun = {
    ...claimed!,
    revision: 2,
    status: "COMPLETED",
    leaseOwner: null,
    leaseExpiresAt: null,
    completedAt: stamp,
  };
  const receipt: WorkflowReceipt = {
    id: "checkpoint-receipt",
    runId: claimed!.id,
    stepRunId: step.id,
    executor: "connector",
    destination: "test",
    summary: "Done",
    requestHash: hashCanonical("request"),
    outputHash: hashCanonical("output"),
    executedAt: stamp,
    idempotencyKey: step.idempotencyKey,
    providerReference: null,
    finalUrl: null,
    successEvidence: null,
    metadata: {},
  };
  const event = {
    id: "checkpoint-event",
    runId: claimed!.id,
    stepRunId: step.id,
    sequence: 2,
    type: "step_completed",
    data: {},
    createdAt: stamp,
  };
  const claimEvent = (
    await db.query<{ id: string }>(
      "SELECT id FROM workflow_events WHERE run_id=$1",
      [claimed!.id],
    )
  ).rows[0]!;
  await expect(
    store.checkpoint(
      lease,
      nextRun,
      nextStep,
      nextAttempt,
      { ...event, id: claimEvent.id },
      receipt,
    ),
  ).rejects.toThrow();
  expect(await store.get<WorkflowRun>("workflow_runs", claimed!.id)).toEqual(
    claimed,
  );
  expect(await store.get<StepRun>("workflow_steps", step.id)).toEqual(step);
  expect(await store.get<StepAttempt>("workflow_attempts", attempt.id)).toEqual(
    attempt,
  );
  expect(
    await store.get<WorkflowReceipt>("workflow_receipts", receipt.id),
  ).toBeNull();
  await store.checkpoint(lease, nextRun, nextStep, nextAttempt, event, receipt);
  expect(
    await store.get<WorkflowRun>("workflow_runs", claimed!.id),
  ).toMatchObject({ status: "COMPLETED", revision: 2 });
  expect(await store.get<StepRun>("workflow_steps", step.id)).toMatchObject({
    status: "COMPLETED",
    attemptCount: 1,
  });
  expect(
    await store.get<StepAttempt>("workflow_attempts", attempt.id),
  ).toMatchObject({ completedAt: stamp, receiptId: receipt.id });
  expect(
    await store.get<WorkflowReceipt>("workflow_receipts", receipt.id),
  ).toEqual(receipt);
  expect(
    (await db.query("SELECT id FROM workflow_events WHERE id=$1", [event.id]))
      .rowCount,
  ).toBe(1);
  await expect(
    store.checkpoint(
      lease,
      nextRun,
      nextStep,
      nextAttempt,
      { ...event, id: "stale-checkpoint-event", sequence: 3 },
      receipt,
    ),
  ).rejects.toThrow("LEASE_LOST");
  expect(
    (
      await db.query("SELECT id FROM workflow_events WHERE id=$1", [
        "stale-checkpoint-event",
      ])
    ).rowCount,
  ).toBe(0);
});
it("atomically consumes a payload-bound confirmation once", async () => {
  const [workflow, version] = draft("confirm");
  version.graph = {
    nodes: [
      {
        id: "effect",
        type: "human.confirm",
        blockVersion: "1.0.0",
        dependsOn: [],
        input: {},
        capability: null,
        timeoutMs: 1000,
        maxAttempts: 1,
      },
    ],
  };
  version.graphHash = hashCanonical(version.graph);
  await store.createDraft(workflow, version);
  await store.activateVersion(
    workflow.id,
    version.id,
    version.graphHash,
    new Date(stamp),
  );
  const record = run("confirm-run", workflow.id);
  await store.createRun(record, [
    {
      id: "confirm-step",
      runId: record.id,
      blockId: "effect",
      blockType: "human.confirm",
      blockVersion: "1.0.0",
      dependencies: [],
      status: "PENDING",
      attemptCount: 0,
      timeoutMs: 1000,
      maxAttempts: 1,
      inputRef: null,
      inputHash: null,
      outputRef: null,
      outputHash: null,
      idempotencyKey: hashCanonical("confirm-step"),
      startedAt: null,
      completedAt: null,
      errorClass: null,
    },
  ]);
  await store.compareAndSwapRun(
    record.id,
    0,
    { ...record, status: "CONFIRMATION_REQUIRED", revision: 1 },
    {
      id: "await-confirm",
      runId: record.id,
      stepRunId: "confirm-step",
      sequence: 1,
      type: "confirmation_required",
      data: {},
      createdAt: stamp,
    },
  );
  const confirmation: RunConfirmation = {
    id: "confirmation",
    runId: record.id,
    stepRunId: "confirm-step",
    actorAccountId: account.id,
    actorRootId: null,
    destination: "test",
    payloadHash: hashCanonical("payload"),
    presentationHash: hashCanonical("preview"),
    createdAt: stamp,
    expiresAt: "2026-09-26T00:05:00.000Z",
    consumedAt: null,
    status: "PENDING",
  };
  await store.insertConfirmation(confirmation);
  await expect(
    store.consumeConfirmation(
      confirmation.id,
      hashCanonical("wrong"),
      new Date(stamp),
      account.id,
    ),
  ).rejects.toThrow("CONFIRMATION_MISMATCH");
  const results = await Promise.allSettled([
    store.consumeConfirmation(
      confirmation.id,
      confirmation.payloadHash,
      new Date(stamp),
      account.id,
    ),
    store.consumeConfirmation(
      confirmation.id,
      confirmation.payloadHash,
      new Date(stamp),
      account.id,
    ),
  ]);
  expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
});
it("rejects step snapshots not in the immutable version", async () => {
  const [workflow, version] = draft("mismatch");
  await store.createDraft(workflow, version);
  await store.activateVersion(
    workflow.id,
    version.id,
    version.graphHash,
    new Date(stamp),
  );
  const step = await store.get<import("@humanos/schemas").StepRun>(
    "workflow_steps",
    "confirm-step",
  );
  await expect(
    store.createRun(run("mismatch-run", workflow.id), [
      { ...step!, id: "bad-step", runId: "mismatch-run" },
    ]),
  ).rejects.toThrow("STEP_SNAPSHOT_MISMATCH");
  expect(await store.get("workflow_runs", "mismatch-run")).toBeNull();
});
it("recovers expired leases into reconciliation, never blind replay", async () => {
  await store.recoverExpiredRuns(new Date("2026-09-26T01:00:00.000Z"));
  expect(await store.get("workflow_runs", "claim-run")).toMatchObject({
    status: "RECONCILIATION_REQUIRED",
    leaseOwner: null,
    revision: 2,
  });
  await expect(
    store.compareAndSwapRun(
      "claim-run",
      1,
      { ...run("claim-run", "claim"), revision: 2 },
      {
        id: "stale",
        runId: "claim-run",
        stepRunId: null,
        sequence: 2,
        type: "stale",
        data: {},
        createdAt: stamp,
      },
    ),
  ).rejects.toThrow("REVISION_CONFLICT");
});
it("rolls back a run state change when its event cannot be recorded", async () => {
  const current = await store.get<WorkflowRun>("workflow_runs", "claim-run");
  const event = {
    id: "event-one",
    runId: "claim-run",
    stepRunId: null,
    sequence: 20,
    type: "test",
    data: {},
    createdAt: stamp,
  };
  await store.compareAndSwapRun(
    current!.id,
    current!.revision,
    { ...current!, revision: current!.revision + 1, status: "FAILED" },
    event,
  );
  const before = await store.get<WorkflowRun>("workflow_runs", "claim-run");
  await expect(
    store.compareAndSwapRun(
      before!.id,
      before!.revision,
      { ...before!, revision: before!.revision + 1 },
      event,
    ),
  ).rejects.toThrow();
  expect(await store.get("workflow_runs", "claim-run")).toEqual(before);
});
it("persists bounded values and scopes them to their owning run", async () => {
  const hash = await store.saveValue("draft-value", "confirm-run", {
    text: "Draft",
  });
  expect(hash).toBe(hashCanonical({ text: "Draft" }));
  expect(await store.getValue("draft-value", "confirm-run")).toEqual({
    text: "Draft",
  });
  expect(await store.getValue("draft-value", "claim-run")).toBeNull();
  await expect(
    store.saveValue("draft-value", "confirm-run", { text: "Changed" }),
  ).rejects.toThrow();
});
it("rejects an attempt from a worker that does not own a live lease", async () => {
  await expect(
    store.recordAttempt(
      {
        id: "unauthorized-attempt",
        stepRunId: "confirm-step",
        attemptNumber: 1,
        executor: "connector",
        provider: null,
        metadata: {},
        requestHash: null,
        responseHash: null,
        requestPreview: null,
        responsePreview: null,
        jevDecision: null,
        errorClass: null,
        errorMessage: null,
        startedAt: stamp,
        completedAt: null,
        receiptId: null,
      },
      {
        runId: "confirm-run",
        revision: 1,
        workerId: "stale-worker",
        now: new Date(stamp),
      },
    ),
  ).rejects.toThrow("LEASE_LOST");
});
it("binds scheduled occurrences to the schedule's workflow and skips overlap", async () => {
  const [workflow, version] = draft("scheduled");
  await store.createDraft(workflow, version);
  await store.activateVersion(
    workflow.id,
    version.id,
    version.graphHash,
    new Date(stamp),
  );
  await store.saveSchedule({
    id: "schedule",
    workflowId: workflow.id,
    workflowVersionId: version.id,
    definition: {
      kind: "recurring",
      expression: "0 * * * *",
      timezone: "Asia/Tokyo",
    },
    nextFireAt: stamp,
    lastFireAt: null,
    status: "ACTIVE",
    overlapPolicy: "skip",
    createdAt: stamp,
    updatedAt: stamp,
  });
  await expect(
    store.createOccurrence("schedule", stamp, run("wrong-occurrence", "claim")),
  ).rejects.toThrow("SCHEDULE_MISMATCH");
  expect(
    await store.createOccurrence(
      "schedule",
      stamp,
      run("occurrence-1", workflow.id),
    ),
  ).toBe(true);
  expect(
    await store.createOccurrence(
      "schedule",
      stamp,
      run("occurrence-duplicate", workflow.id),
    ),
  ).toBe(false);
  expect(
    await store.createOccurrence(
      "schedule",
      "2026-09-26T01:00:00.000Z",
      run("occurrence-overlap", workflow.id),
    ),
  ).toBe(false);
  expect(await store.get("workflow_runs", "occurrence-overlap")).toBeNull();
});
it("does not consume a fresh confirmation after its run was cancelled", async () => {
  const previous = await store.get<RunConfirmation>(
    "workflow_confirmations",
    "confirmation",
  );
  await store.insertConfirmation({
    ...previous!,
    id: "cancelled-confirmation",
    status: "PENDING",
    consumedAt: null,
  });
  const current = await store.get<WorkflowRun>("workflow_runs", "confirm-run");
  await store.compareAndSwapRun(
    current!.id,
    current!.revision,
    { ...current!, status: "CANCELLED", revision: current!.revision + 1 },
    {
      id: "cancel-event",
      runId: current!.id,
      stepRunId: null,
      sequence: 2,
      type: "cancelled",
      data: {},
      createdAt: stamp,
    },
  );
  await expect(
    store.consumeConfirmation(
      "cancelled-confirmation",
      previous!.payloadHash,
      new Date(stamp),
      account.id,
    ),
  ).rejects.toThrow("CONFIRMATION_UNAVAILABLE");
});
