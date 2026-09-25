import { beforeAll, afterAll, describe, it, expect } from "vitest";
import { randomUUID } from "node:crypto";
import { Database } from "@humanos/database";
import {
  hashCanonical,
  type Mission,
  type AuditEvent,
  type ActionProposal,
  type Approval,
  type AgentAuthorization,
  type JevAssessment,
} from "@humanos/schemas";
import { approvalBinding } from "@humanos/world";
import { JEV_MODEL, JEV_QUESTION_VERSION } from "@humanos/models";
import { createExecutor } from "../src/services/execute-sensitive-action.js";
const db = new Database(
  process.env.TEST_DATABASE_URL ??
    "postgresql://saikarthik@127.0.0.1:55432/humanos",
  { schema: "executor_" + randomUUID().replaceAll("-", "") },
);
beforeAll(() => db.migrate());
afterAll(() => db.close());
async function setup(
  type: "SUBMIT_APPLICATION" | "CREATE_CALENDAR_EVENT" = "SUBMIT_APPLICATION",
) {
  const capability =
    type === "SUBMIT_APPLICATION" ? "application.submit" : "calendar.create";
  const kind = type === "SUBMIT_APPLICATION" ? "application" : "calendar";
  const now = Date.now(),
    stamp = new Date(now).toISOString(),
    expiry = new Date(now + 240000).toISOString();
  const rootId = randomUUID();
  await db.insert("roots", {
    id: rootId,
    ensName: "human.eth",
    createdAt: stamp,
    verificationEnvironment: "staging",
  });
  const mission: Mission = {
    id: randomUUID(),
    rootId,
    goal: "Submit application",
    title: "Apply",
    capabilities: [capability],
    approvedCapabilities: [capability],
    steps: ["Submit"],
    expiresAt: expiry,
    agentEns: "task.human.eth",
    state: "RUNNING",
    createdAt: stamp,
    updatedAt: stamp,
    policyVersion: "humanos-policy-v1",
  };
  await db.insert("missions", mission);
  const action: ActionProposal = {
    id: randomUUID(),
    rootId,
    missionId: mission.id,
    agentEns: mission.agentEns!,
    type,
    capability,
    reason: "Apply",
    payload: { name: "Alice" },
    payloadHash: hashCanonical({ name: "Alice" }),
    nonce: randomUUID(),
    expiresAt: expiry,
    createdAt: stamp,
  };
  await db.insert("actions", action);
  const binding = approvalBinding(action);
  const approval: Approval = {
    id: randomUUID(),
    actionId: action.id,
    binding,
    bindingHash: hashCanonical(binding),
    kind: "WORLD_FRESH",
    status: "VERIFIED",
    createdAt: stamp,
    verifiedAt: stamp,
    consumedAt: null,
    nullifierHash: hashCanonical(rootId),
  };
  await db.insert("approvals", approval);
  let revoked = false;
  let calls = 0;
  const auth = async (): Promise<AgentAuthorization> => ({
    agentEns: action.agentEns,
    rootId,
    capabilities: [capability],
    active: true,
    revoked,
    expiresAt: expiry,
    checkedAt: new Date().toISOString(),
    blockNumber: 100,
    finalized: true,
  });
  const evaluate = async (state: {
    mission: Mission;
    action: ActionProposal;
  }): Promise<JevAssessment> => ({
    stateHash: hashCanonical(state),
    questionVersion: JEV_QUESTION_VERSION,
    modelVersion: JEV_MODEL,
    evaluatedAt: new Date().toISOString(),
    risk: "SENSITIVE",
    missionAligned: true,
    injectionDetected: false,
    requiresReview: false,
    confidence: 0.99,
    missionAlignmentScore: 0.99,
    injectionScore: 0.01,
    reason: "Fixture transport, non-qualifying",
  });
  const effect = {
    execute: async () => {
      calls++;
      return {
        externalId: "submission",
        payloadHash: action.payloadHash,
        kind,
      };
    },
    reconcile: async () => ({
      externalId: "submission",
      payloadHash: action.payloadHash,
      kind,
    }),
  };
  return {
    mission,
    action,
    approval,
    auth,
    evaluate,
    effect,
    get calls() {
      return calls;
    },
    revoke() {
      revoked = true;
    },
  };
}
describe("atomic execution on real PostgreSQL with fixture provider transports", () => {
  it("simultaneous attempts consume once and persist one receipt", async () => {
    const s = await setup();
    const execute = createExecutor({
      db,
      readAuthorization: s.auth,
      evaluate: s.evaluate,
      effect: s.effect,
    });
    const receipts = await Promise.all(
      Array.from({ length: 5 }, () => execute(s.action.id)),
    );
    expect(new Set(receipts.map((r) => r.id)).size).toBe(1);
    expect(s.calls).toBe(1);
    expect((await db.get<Approval>("approvals", s.approval.id))?.status).toBe(
      "CONSUMED",
    );
  });
  it("blocks revocation racing after first read, rolling approval consumption back", async () => {
    const s = await setup();
    let reads = 0;
    const execute = createExecutor({
      db,
      readAuthorization: async () => {
        if (++reads === 2) s.revoke();
        return s.auth();
      },
      evaluate: s.evaluate,
      effect: s.effect,
    });
    await expect(execute(s.action.id)).rejects.toThrow();
    expect(s.calls).toBe(0);
    expect((await db.get<Approval>("approvals", s.approval.id))?.status).toBe(
      "VERIFIED",
    );
  });
  it("persists ambiguous status and reconciles without repeating side effect", async () => {
    const s = await setup();
    let attempts = 0;
    const execute = createExecutor({
      db,
      readAuthorization: s.auth,
      evaluate: s.evaluate,
      effect: {
        ...s.effect,
        execute: async () => {
          attempts++;
          throw new Error("timeout");
        },
      },
    });
    expect((await execute(s.action.id)).status).toBe("RECONCILIATION_REQUIRED");
    expect((await execute(s.action.id)).status).toBe("SUCCEEDED");
    expect(attempts).toBe(1);
  });
  it("rejects payload replacement and stale ENS state", async () => {
    const s = await setup();
    await db.put("actions", { ...s.action, payload: { name: "Bob" } });
    const execute = createExecutor({
      db,
      readAuthorization: s.auth,
      evaluate: s.evaluate,
      effect: s.effect,
    });
    await expect(execute(s.action.id)).rejects.toThrow();
    expect(s.calls).toBe(0);
  });
});
it("reconciliation advances mission and appends audit", async () => {
  const s = await setup();
  const execute = createExecutor({
    db,
    readAuthorization: s.auth,
    evaluate: s.evaluate,
    effect: {
      ...s.effect,
      execute: async () => {
        throw new Error("timeout");
      },
    },
  });
  await execute(s.action.id);
  await execute(s.action.id);
  expect((await db.get<Mission>("missions", s.mission.id))?.state).toBe(
    "RUNNING",
  );
  const events = (await db.list<AuditEvent>("audit")).filter(
    (e) => e.actionId === s.action.id,
  );
  expect(events.map((e) => e.type)).toContain("RECONCILED");
});
it("reconciliation preserves revoked mission", async () => {
  const s = await setup();
  const execute = createExecutor({
    db,
    readAuthorization: s.auth,
    evaluate: s.evaluate,
    effect: {
      ...s.effect,
      execute: async () => {
        throw new Error("timeout");
      },
    },
  });
  await execute(s.action.id);
  await db.put("missions", { ...s.mission, state: "REVOKED" });
  expect((await execute(s.action.id)).status).toBe("SUCCEEDED");
  expect((await db.get<Mission>("missions", s.mission.id))?.state).toBe(
    "REVOKED",
  );
});
it("rejects wrong-kind executor results in both paths", async () => {
  const s = await setup();
  const wrong = async () => ({
    externalId: "wrong",
    payloadHash: s.action.payloadHash,
    kind: "calendar",
  });
  const execute = createExecutor({
    db,
    readAuthorization: s.auth,
    evaluate: s.evaluate,
    effect: { execute: wrong, reconcile: wrong },
  });
  expect((await execute(s.action.id)).status).toBe("RECONCILIATION_REQUIRED");
  await expect(execute(s.action.id)).rejects.toThrow("RECONCILIATION_REQUIRED");
});
it("ENS update failure commits effect once and retries only receipt commitment", async () => {
  const s = await setup();
  let updates = 0;
  const hashes: string[] = [];
  const execute = createExecutor({
    db,
    readAuthorization: s.auth,
    evaluate: s.evaluate,
    effect: s.effect,
    updateEnsReceipt: async (input) => {
      hashes.push(input.receiptHash);
      if (++updates === 1) throw new Error("chain unavailable");
    },
  });
  const first = await execute(s.action.id);
  expect(first.status).toBe("SUCCEEDED");
  expect(first.metadata.ensUpdateStatus).toBe("PENDING");
  const second = await execute(s.action.id);
  expect(second.metadata.ensUpdateStatus).toBe("CONFIRMED");
  expect(updates).toBe(2);
  expect(s.calls).toBe(1);
  expect(new Set(hashes).size).toBe(1);
  expect(
    (await db.list<AuditEvent>("audit")).some(
      (e) => e.actionId === s.action.id && e.type === "ENS_UPDATE_PENDING",
    ),
  ).toBe(true);
});

it("calendar reconciliation completes mission with one effect", async () => {
  const s = await setup("CREATE_CALENDAR_EVENT");
  let posts = 0;
  const execute = createExecutor({
    db,
    readAuthorization: s.auth,
    evaluate: s.evaluate,
    effect: {
      ...s.effect,
      execute: async () => {
        posts++;
        throw new Error("timeout");
      },
    },
  });
  await execute(s.action.id);
  await execute(s.action.id);
  expect((await db.get<Mission>("missions", s.mission.id))?.state).toBe(
    "COMPLETED",
  );
  expect(posts).toBe(1);
});
it("blocks stale ENS authorization before effects", async () => {
  const s = await setup();
  const execute = createExecutor({
    db,
    readAuthorization: async () => ({
      ...(await s.auth()),
      checkedAt: new Date(Date.now() - 60000).toISOString(),
    }),
    evaluate: s.evaluate,
    effect: s.effect,
  });
  await expect(execute(s.action.id)).rejects.toThrow();
  expect(s.calls).toBe(0);
});
it("persists final policy and assessment summary without free text or personal payloads", async () => {
  const s = await setup();
  const execute = createExecutor({
    db,
    readAuthorization: s.auth,
    evaluate: async (state) => ({
      ...(await s.evaluate(state)),
      reason: "PRIVATE_REASON_DO_NOT_LOG",
    }),
    effect: s.effect,
  });
  await execute(s.action.id);
  const event = (await db.list<AuditEvent>("audit")).find(
    (e) => e.actionId === s.action.id && e.type === "EXECUTION_AUTHORIZED",
  );
  expect(event?.metadata.decision).toMatchObject({
    allowed: true,
    risk: "SENSITIVE",
    requiresApproval: true,
  });
  expect(event?.metadata.assessment).toMatchObject({
    confidence: 0.99,
    missionAligned: true,
    injectionDetected: false,
  });
  expect(JSON.stringify(event)).not.toContain("PRIVATE_REASON_DO_NOT_LOG");
  expect(JSON.stringify(event)).not.toContain("Alice");
});
it("persists denial after rollback without consuming approval or invoking effect", async () => {
  const s = await setup();
  let reads = 0;
  const execute = createExecutor({
    db,
    readAuthorization: async () => {
      if (++reads === 2) s.revoke();
      return s.auth();
    },
    evaluate: s.evaluate,
    effect: s.effect,
  });
  await expect(execute(s.action.id)).rejects.toThrow();
  expect((await db.get<Approval>("approvals", s.approval.id))?.status).toBe(
    "VERIFIED",
  );
  expect(s.calls).toBe(0);
  const event = (await db.list<AuditEvent>("audit")).find(
    (e) => e.actionId === s.action.id && e.type === "EXECUTION_DENIED",
  );
  expect(event?.metadata.decision).toMatchObject({ allowed: false });
  expect(event?.previousState).toBe(event?.nextState);
  expect(event?.metadata.phase).toBe("FINAL_RECHECK");
});
