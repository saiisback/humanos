import { afterAll, beforeAll, expect, it } from "vitest";
import {
  ensNamehash,
  hashCanonical,
  type Hex,
  type Workflow,
  type WorkflowAgentBinding,
  type WorkflowAgentReservation,
  type WorkflowEvent,
  type WorkflowRun,
  type WorkflowSchedule,
  type WorkflowVersion,
} from "@humanos/schemas";
import { Database, WorkflowAgentStore, WorkflowStore } from "../src/index.js";

const schema = `test_workflow_agents_${Date.now()}`;
const db = new Database(
  process.env.TEST_DATABASE_URL ??
    "postgresql://saikarthik@127.0.0.1:55432/humanos",
  { schema },
);
const workflows = new WorkflowStore(db);
const agents = new WorkflowAgentStore(db);
const stamp = "2026-09-26T00:00:00.000Z";
const later = "2026-09-27T00:00:00.000Z";
const at = new Date(stamp);
const txHash = `0x${"b".repeat(64)}` as Hex;
const account = (digit: string) => {
  const address = `0x${digit.repeat(40)}`;
  return {
    id: `11155111:${address}`,
    address,
    chainId: 11155111,
    createdAt: stamp,
  };
};
const owner = account("1");
const other = account("3");
it("upgrades the early outbox schema on repeated migration", async () => {
  // This schema is isolated to this test file, never the application database.
  await db.query("ALTER TABLE workflow_agent_receipt_jobs DROP COLUMN source_receipt_id");
  await db.migrate();
  const columns = await db.query("SELECT column_name FROM information_schema.columns WHERE table_schema=$1 AND table_name='workflow_agent_receipt_jobs' AND column_name='source_receipt_id'", [schema]);
  expect(columns.rows).toHaveLength(1);
});

async function activeVersion(
  id: string,
  accountId = owner.id,
): Promise<WorkflowVersion> {
  const graph = { nodes: [] };
  const version: WorkflowVersion = {
    id: `${id}-v1`,
    workflowId: id,
    version: 1,
    goal: "Draft",
    normalizedIntent: {},
    graph,
    graphHash: hashCanonical(graph),
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
  const workflow: Workflow = {
    id,
    accountId,
    rootId: null,
    missionId: null,
    name: "Draft",
    status: "DRAFT",
    latestVersionId: version.id,
    createdAt: stamp,
    updatedAt: stamp,
    archivedAt: null,
  };
  await workflows.createDraft(workflow, version);
  return workflows.activateVersion(id, version.id, version.graphHash, at);
}
function reservation(
  version: WorkflowVersion,
  overrides: Partial<WorkflowAgentReservation> = {},
): WorkflowAgentReservation {
  return {
    accountId: owner.id,
    rootId: "root-owner",
    workflowId: version.workflowId,
    versionId: version.id,
    graphHash: version.graphHash,
    capabilities: ["drafts.write"],
    expiresAt: later,
    state: "PENDING_REGISTRATION",
    createdAt: stamp,
    updatedAt: stamp,
    ...overrides,
  };
}
function registration(binding: WorkflowAgentBinding, txHashes: Hex[] = []) {
  const ensName = `a${binding.generation}.root.humanos.eth`;
  return {
    ensName,
    node: ensNamehash(ensName),
    agentAddress: `0x${"Ab".repeat(20)}`,
    txHashes,
  };
}
function run(
  id: string,
  version: WorkflowVersion,
  pin: Partial<WorkflowRun> = {},
): WorkflowRun {
  return {
    id,
    workflowId: version.workflowId,
    workflowVersionId: version.id,
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
    ...pin,
  };
}
const event = (id: string, runId: string): WorkflowEvent => ({
  id,
  runId,
  stepRunId: null,
  sequence: 1,
  type: "run.test",
  data: {},
  createdAt: stamp,
});

beforeAll(async () => {
  await db.migrate();
  await db.migrate();
  for (const a of [owner, other]) await db.insert("accounts", a);
  for (const id of ["root-owner", "root-other"])
    await db.insert("roots", {
      id,
      ensName: null,
      createdAt: stamp,
      verificationEnvironment: "staging",
    });
  await db.transaction((tx) => tx.bindRootAccount("root-owner", owner.id, at));
  await db.transaction((tx) => tx.bindRootAccount("root-other", other.id, at));
});
afterAll(async () => {
  await db.query(`DROP SCHEMA "${schema}" CASCADE`);
  await db.close();
});

it("reserves one pending binding with store-allocated identity under concurrent requests", async () => {
  const version = await activeVersion("concurrent");
  const results = await Promise.all(
    [1, 2, 3].map(() => agents.reserve(reservation(version))),
  );
  expect(new Set(results.map((b) => b.id)).size).toBe(1);
  expect(results[0]).toMatchObject({
    generation: 1,
    derivationId: "workflow:concurrent:1",
    chainId: 11155111,
    state: "PENDING_REGISTRATION",
    revision: 0,
    ensName: null,
    node: null,
    agentAddress: null,
    registrationTxHashes: [],
    revocationTxHashes: [],
  });
  expect(
    (
      await db.query(
        "SELECT id FROM workflow_agent_bindings WHERE workflow_id=$1",
        ["concurrent"],
      )
    ).rowCount,
  ).toBe(1);
  const retry = await agents.reserve(reservation(version));
  expect(retry.id).toBe(results[0]!.id);
  expect(await agents.get(retry.id)).toEqual(results[0]);
});

it("rejects mismatched account, root, graph, scope and unvalidated reservation fields", async () => {
  const version = await activeVersion("conflicts");
  await agents.reserve(reservation(version));
  await expect(
    agents.reserve(
      reservation(version, { expiresAt: "2026-09-26T12:00:00.000Z" }),
    ),
  ).rejects.toThrow("WORKFLOW_AGENT_CONFLICT");
  await expect(
    agents.reserve(
      reservation(version, { capabilities: ["drafts.write", "web.search"] }),
    ),
  ).rejects.toThrow("WORKFLOW_AGENT_CONFLICT");
  await expect(
    agents.reserve(
      reservation(version, { graphHash: hashCanonical("changed") }),
    ),
  ).rejects.toThrow("GRAPH_CHANGED");
  await expect(
    agents.reserve(
      reservation(version, { accountId: other.id, rootId: "root-other" }),
    ),
  ).rejects.toThrow("WORKFLOW_NOT_FOUND");
  await expect(
    agents.reserve(reservation(version, { rootId: "root-other" })),
  ).rejects.toThrow("ROOT_NOT_OWNED");
  await expect(
    agents.reserve({
      ...reservation(version),
      privateKey: "0x01",
    } as WorkflowAgentReservation),
  ).rejects.toThrow();
  await expect(
    agents.reserve({
      ...reservation(version),
      generation: 9,
    } as WorkflowAgentReservation),
  ).rejects.toThrow();
});

it("activates with verified evidence, revokes, and allocates a fresh generation", async () => {
  const version = await activeVersion("lifecycle");
  const first = await agents.reserve(reservation(version));
  await expect(
    agents.transition(first.id, 0, "ACTIVE", { at }),
  ).rejects.toThrow("EVIDENCE_MISMATCH");
  await expect(
    agents.transition(first.id, 0, "ACTIVE", {
      at: new Date(later),
      registration: registration(first),
    }),
  ).rejects.toThrow("AGENT_EXPIRED");
  // Reconciled registration of verified preexisting chain state carries no transaction hash.
  const active = await agents.transition(first.id, 0, "ACTIVE", {
    at,
    registration: registration(first),
  });
  expect(active).toMatchObject({
    state: "ACTIVE",
    revision: 1,
    agentAddress: `0x${"ab".repeat(20)}`,
    registrationTxHashes: [],
  });
  await expect(
    agents.transition(first.id, 0, "REVOKING", { at }),
  ).rejects.toThrow("REVISION_CONFLICT");
  await expect(agents.reserve(reservation(version))).rejects.toThrow(
    "WORKFLOW_AGENT_CONFLICT",
  );
  await agents.transition(first.id, 1, "REVOKING", { at });
  const revoked = await agents.transition(first.id, 2, "REVOKED", {
    at,
    revocation: { txHashes: [txHash] },
  });
  expect(revoked).toMatchObject({
    state: "REVOKED",
    revision: 3,
    revocationTxHashes: [txHash],
    ensName: active.ensName,
  });
  await expect(
    agents.transition(first.id, 3, "ACTIVE", {
      at,
      registration: registration(first),
    }),
  ).rejects.toThrow("INVALID_TRANSITION");
  const second = await agents.reserve(reservation(version));
  expect(second).toMatchObject({
    generation: 2,
    derivationId: "workflow:lifecycle:2",
    state: "PENDING_REGISTRATION",
  });
  expect(second.id).not.toBe(first.id);
  expect(await agents.get(first.id)).toEqual(revoked);
});

it("revokes a pending intent without chain identity or fabricated hashes", async () => {
  const version = await activeVersion("pending-revoke");
  const pending = await agents.reserve(reservation(version));
  const revoking = await agents.transition(pending.id, 0, "REVOKING", { at });
  expect(revoking).toMatchObject({
    state: "REVOKING",
    ensName: null,
    node: null,
    agentAddress: null,
  });
  await expect(
    agents.transition(pending.id, 1, "REVOKED", {
      at,
      revocation: { txHashes: [txHash] },
    }),
  ).rejects.toThrow();
  const revoked = await agents.transition(pending.id, 1, "REVOKED", {
    at,
    revocation: { txHashes: [] },
  });
  expect(revoked).toMatchObject({
    state: "REVOKED",
    revocationTxHashes: [],
    registrationTxHashes: [],
  });
});

it("lists only bindings owned by the account", async () => {
  const mine = await agents.reserve(
    reservation(await activeVersion("owned-mine")),
  );
  const theirs = await agents.reserve(
    reservation(await activeVersion("owned-theirs", other.id), {
      accountId: other.id,
      rootId: "root-other",
    }),
  );
  const ids = (await agents.listOwned(owner.id)).map((b) => b.id);
  expect(ids).toContain(mine.id);
  expect(ids).not.toContain(theirs.id);
  expect((await agents.listOwned(other.id)).map((b) => b.id)).toEqual([
    theirs.id,
  ]);
});

it("persists pending chain evidence without granting authority and cannot replace its identity", async () => {
  const pending = await agents.reserve(
    reservation(await activeVersion("finality-pending")),
  );
  const evidence = registration(pending, [txHash]);
  const staged = await agents.transition(
    pending.id,
    0,
    "PENDING_REGISTRATION",
    { at, registration: evidence },
  );
  expect(staged).toMatchObject({
    state: "PENDING_REGISTRATION",
    ensName: evidence.ensName,
    registrationTxHashes: [txHash],
  });
  await expect(
    agents.transition(staged.id, 1, "ACTIVE", {
      at,
      registration: { ...evidence, agentAddress: `0x${"1".repeat(40)}` },
    }),
  ).rejects.toThrow("IDENTITY_IMMUTABLE");
  const activated = await agents.transition(staged.id, 1, "ACTIVE", {
    at,
    registration: { ...evidence, txHashes: [] },
  });
  expect(activated.registrationTxHashes).toEqual([txHash]);
});

it("does not expire a live binding before its approved expiry", async () => {
  const pending = await agents.reserve(
    reservation(await activeVersion("expiry-guard")),
  );
  await expect(
    agents.transition(pending.id, 0, "EXPIRED", { at }),
  ).rejects.toThrow("NOT_EXPIRED");
});

it("pins run authority to an active matching binding and never rewrites it", async () => {
  const version = await activeVersion("pinned-run");
  const unrelated = await activeVersion("pinned-unrelated");
  const pending = await agents.reserve(reservation(version));
  const pin = { authorityMode: "ens" as const, agentBindingId: pending.id };
  await expect(
    workflows.createRun(run("pinned-early", version, pin), []),
  ).rejects.toThrow("AGENT_BINDING_INACTIVE");
  await agents.transition(pending.id, 0, "ACTIVE", {
    at,
    registration: registration(pending, [txHash]),
  });
  await expect(
    workflows.createRun(run("pinned-wrong", unrelated, pin), []),
  ).rejects.toThrow("AGENT_BINDING_MISMATCH");
  await expect(
    workflows.createRun(
      run("pinned-bare", version, { authorityMode: "ens" }),
      [],
    ),
  ).rejects.toThrow("INVALID_AUTHORITY_PIN");
  await workflows.createRun(run("pinned", version, pin), []);
  const created = (await workflows.get<WorkflowRun>(
    "workflow_runs",
    "pinned",
  ))!;
  expect(created).toMatchObject(pin);
  await expect(
    workflows.compareAndSwapRun(
      "pinned",
      0,
      { ...created, revision: 1, agentBindingId: "other" },
      event("pin-e1", "pinned"),
    ),
  ).rejects.toThrow("IMMUTABLE_RUN_INPUT");
  await expect(
    workflows.compareAndSwapRun(
      "pinned",
      0,
      {
        ...created,
        revision: 1,
        authorityMode: "account",
        agentBindingId: null,
      },
      event("pin-e2", "pinned"),
    ),
  ).rejects.toThrow("IMMUTABLE_RUN_INPUT");
  await workflows.compareAndSwapRun(
    "pinned",
    0,
    { ...created, revision: 1, pauseReason: "checked" },
    event("pin-e3", "pinned"),
  );
  expect(
    await workflows.get<WorkflowRun>("workflow_runs", "pinned"),
  ).toMatchObject({ ...pin, revision: 1 });

  await workflows.createRun(run("legacy", version), []);
  const legacy = (await workflows.get<WorkflowRun>("workflow_runs", "legacy"))!;
  expect(legacy).not.toHaveProperty("authorityMode");
  await expect(
    workflows.compareAndSwapRun(
      "legacy",
      0,
      { ...legacy, revision: 1, authorityMode: "account" },
      event("legacy-e1", "legacy"),
    ),
  ).rejects.toThrow("IMMUTABLE_RUN_INPUT");
});

it("pins schedules to their binding and keeps the pin after revocation", async () => {
  const version = await activeVersion("pinned-schedule");
  const pending = await agents.reserve(reservation(version));
  const active = await agents.transition(pending.id, 0, "ACTIVE", {
    at,
    registration: registration(pending),
  });
  const schedule: WorkflowSchedule = {
    id: "pinned-schedule-1",
    workflowId: version.workflowId,
    workflowVersionId: version.id,
    authorityMode: "ens",
    agentBindingId: active.id,
    definition: { kind: "once", fireAt: later, timezone: "UTC" },
    nextFireAt: later,
    lastFireAt: null,
    status: "ACTIVE",
    overlapPolicy: "skip",
    createdAt: stamp,
    updatedAt: stamp,
  };
  await workflows.saveSchedule(schedule);
  await expect(
    workflows.saveSchedule({
      ...schedule,
      authorityMode: "account",
      agentBindingId: null,
    }),
  ).rejects.toThrow("SCHEDULE_MISMATCH");
  await expect(
    workflows.saveSchedule({
      ...schedule,
      id: "pinned-schedule-2",
      agentBindingId: "missing",
    }),
  ).rejects.toThrow("AGENT_BINDING_MISMATCH");
  await expect(
    workflows.compareAndSwapSchedule(schedule, {
      ...schedule,
      agentBindingId: "other",
    }),
  ).rejects.toThrow("SCHEDULE_CONFLICT");
  await agents.transition(active.id, 1, "REVOKING", { at });
  await workflows.compareAndSwapSchedule(schedule, {
    ...schedule,
    status: "PAUSED",
  });
  expect(
    await workflows.get<WorkflowSchedule>("workflow_schedules", schedule.id),
  ).toMatchObject({
    status: "PAUSED",
    authorityMode: "ens",
    agentBindingId: active.id,
  });
  await expect(
    workflows.createRun(
      run("pinned-after-revoke", version, {
        authorityMode: "ens",
        agentBindingId: active.id,
      }),
      [],
    ),
  ).rejects.toThrow("AGENT_BINDING_INACTIVE");
});
