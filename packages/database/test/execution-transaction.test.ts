import { afterAll, beforeAll, expect, it } from "vitest";
import { Database } from "../src/index.js";
import {
  hashCanonical,
  type Mission,
  type ActionProposal,
  type Approval,
  type ExecutionReceipt,
} from "@humanos/schemas";
const schema = "test_" + Date.now();
const db = new Database(
  process.env.TEST_DATABASE_URL ??
    "postgresql://saikarthik@127.0.0.1:55432/humanos",
  { schema },
);
const date = new Date().toISOString(),
  future = new Date(Date.now() + 3600000).toISOString();
const accountId = "11155111:0x1111111111111111111111111111111111111111";
const mission: Mission = {
  id: "m",
  rootId: "r",
  agentEns: "a.eth",
  title: "t",
  goal: "g",
  capabilities: ["application.submit"],
  approvedCapabilities: ["application.submit"],
  steps: [],
  state: "RUNNING",
  expiresAt: future,
  createdAt: date,
  updatedAt: date,
  policyVersion: "v1",
};
const action: ActionProposal = {
  id: "a",
  rootId: "r",
  missionId: "m",
  agentEns: "a.eth",
  type: "SUBMIT_APPLICATION",
  capability: "application.submit",
  payload: {},
  payloadHash: hashCanonical({}),
  nonce: "n",
  expiresAt: future,
  createdAt: date,
  reason: "r",
};
const binding = {
  rootId: "r",
  agentEns: "a.eth",
  missionId: "m",
  actionType: action.type,
  payloadHash: action.payloadHash,
  nonce: "n",
  expiresAt: future,
};
const approval: Approval = {
  id: "p",
  actionId: "a",
  binding,
  bindingHash: hashCanonical(binding),
  kind: "WORLD_FRESH",
  status: "VERIFIED",
  createdAt: date,
  verifiedAt: date,
  consumedAt: null,
  nullifierHash: hashCanonical("human"),
};
const receipt: ExecutionReceipt = {
  id: "rc",
  actionId: "a",
  missionId: "m",
  idempotencyKey: "key",
  payloadHash: action.payloadHash,
  status: "SUCCEEDED",
  externalId: "external",
  executedAt: date,
  metadata: {},
};
beforeAll(async () => {
  await db.migrate();
  await db.insert("roots", {
    id: "r",
    ensName: null,
    createdAt: date,
    verificationEnvironment: "staging",
  });
  await db.insert("accounts", {
    id: accountId,
    address: "0x1111111111111111111111111111111111111111",
    chainId: 11155111,
    createdAt: date,
  });
  await db.insert("missions", mission);
  await db.insert("actions", action);
  await db.insert("approvals", approval);
});
afterAll(async () => {
  await db.query(`DROP SCHEMA "${schema}" CASCADE`);
  await db.close();
});
it("rolls back root nullifier claims on failure; rejects duplicate claims", async () => {
  await expect(
    db.transaction(async (tx) => {
      await tx.claimNullifier("n", "r");
      throw new Error("rollback");
    }),
  ).rejects.toThrow("rollback");
  await db.transaction((tx) => tx.claimNullifier("n", "r"));
  await expect(
    db.transaction((tx) => tx.claimNullifier("n", "r")),
  ).rejects.toThrow();
});
it("serializes concurrent execution and consumes approval exactly once", async () => {
  let sideEffects = 0;
  const execute = () =>
    db.withLockedAction("a", async (tx) => {
      const existing = await tx.getReceiptForAction("a");
      if (existing) return existing;
      await tx.consumeApproval("p", new Date());
      sideEffects++;
      await tx.insert("receipts", receipt);
      return receipt;
    });
  const result = await Promise.all([execute(), execute()]);
  expect(sideEffects).toBe(1);
  expect(result[0]).toEqual(result[1]);
  await expect(
    db.transaction((tx) => tx.consumeApproval("p", new Date())),
  ).rejects.toThrow();
  await expect(
    db.insert("receipts", { ...receipt, id: "other" }),
  ).rejects.toThrow();
});
it("prevents mutable upsert bypass for approvals and audit", async () => {
  await expect(db.put("approvals", approval)).rejects.toThrow();
  await expect(db.delete("audit", "x")).rejects.toThrow();
});
it("challenge survives separate pool and is single use", async () => {
  await db.insert("challenges", {
    id: "c",
    rootId: "r",
    expiresAt: future,
    consumedAt: null,
  });
  const second = new Database(
    process.env.TEST_DATABASE_URL ??
      "postgresql://saikarthik@127.0.0.1:55432/humanos",
    { schema },
  );
  try {
    expect(await second.get("challenges", "c")).toMatchObject({ id: "c" });
    const results = await Promise.allSettled([
      db.transaction((tx) => tx.consumeChallenge("c", new Date())),
      second.transaction((tx) => tx.consumeChallenge("c", new Date())),
    ]);
    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
  } finally {
    await second.close();
  }
});
it("mission row lock serializes revocation against action execution", async () => {
  let entered!: () => void, release!: () => void;
  const wait = new Promise<void>((r) => {
    release = r;
  });
  const ready = new Promise<void>((r) => {
    entered = r;
  });
  const revoke = db.transaction(async (tx) => {
    await tx.lockMission("m");
    entered();
    await wait;
    await tx.put("missions", { ...mission, state: "REVOKED" });
  });
  await ready;
  const execution = db.withLockedAction(
    "a",
    async (tx) => (await tx.get<Mission>("missions", "m"))!.state,
  );
  release();
  await revoke;
  expect(await execution).toBe("REVOKED");
});
it("rolls back approval consumption if callback fails", async () => {
  const a = { ...action, id: "a2", nonce: "n2" };
  await db.insert("actions", a);
  const b = { ...binding, nonce: "n2" };
  await db.insert("approvals", {
    ...approval,
    id: "p2",
    actionId: "a2",
    binding: b,
    bindingHash: hashCanonical(b),
  });
  await expect(
    db.withLockedAction("a2", async (tx) => {
      await tx.consumeApproval("p2", new Date());
      throw new Error("execution rejected");
    }),
  ).rejects.toThrow("execution rejected");
  expect(await db.get("approvals", "p2")).toMatchObject({
    status: "VERIFIED",
    consumedAt: null,
  });
});
it("expired challenges and approval cannot be consumed", async () => {
  const past = "2020-01-01T00:00:00.000Z";
  await db.insert("challenges", {
    id: "expired",
    expiresAt: past,
    consumedAt: null,
  });
  await expect(
    db.transaction((tx) => tx.consumeChallenge("expired", new Date())),
  ).rejects.toThrow("CHALLENGE_NOT_CONSUMABLE");
  const a = { ...action, id: "a3", nonce: "n3" };
  await db.insert("actions", a);
  const b = { ...binding, nonce: "n3", expiresAt: past };
  await db.insert("approvals", {
    ...approval,
    id: "p3",
    actionId: "a3",
    binding: b,
    bindingHash: hashCanonical(b),
  });
  await expect(
    db.transaction((tx) => tx.consumeApproval("p3", new Date())),
  ).rejects.toThrow("APPROVAL_NOT_CONSUMABLE");
});
it("same human may separately approve distinct action bindings", async () => {
  expect(await db.get<Approval>("approvals", "p2")).toMatchObject({
    nullifierHash: approval.nullifierHash,
  });
});
it("stores sessions durably across pool restarts", async () => {
  await db.insert("sessions", {
    id: "token-hash",
    accountId,
    rootId: "r",
    expiresAt: future,
  });
  const second = new Database(
    process.env.TEST_DATABASE_URL ??
      "postgresql://saikarthik@127.0.0.1:55432/humanos",
    { schema },
  );
  try {
    expect(await second.get("sessions", "token-hash")).toMatchObject({
      rootId: "r",
      expiresAt: future,
    });
  } finally {
    await second.close();
  }
});
it("pending approvals verify once and cannot reset consumed or cancelled approvals", async () => {
  const a = { ...action, id: "a4", nonce: "n4" };
  await db.insert("actions", a);
  const b = { ...binding, nonce: "n4" };
  await db.insert("approvals", {
    ...approval,
    id: "p4",
    actionId: "a4",
    binding: b,
    bindingHash: hashCanonical(b),
    status: "PENDING",
    verifiedAt: null,
    nullifierHash: null,
  });
  await expect(
    db.transaction((tx) => tx.updateApprovalStatus("p4", "VERIFIED")),
  ).rejects.toThrow();
  const verified = await db.transaction((tx) =>
    tx.updateApprovalStatus("p4", "VERIFIED", {
      verifiedAt: new Date().toISOString(),
      nullifierHash: hashCanonical("human"),
    }),
  );
  expect(verified.status).toBe("VERIFIED");
  await db.transaction((tx) => tx.consumeApproval("p4", new Date()));
  await expect(
    db.transaction((tx) => tx.updateApprovalStatus("p4", "CANCELLED")),
  ).rejects.toThrow();
  await expect(
    db.transaction((tx) =>
      tx.updateApprovalStatus("p4", "VERIFIED", {
        verifiedAt: new Date().toISOString(),
        nullifierHash: hashCanonical("human"),
      }),
    ),
  ).rejects.toThrow();
});
it("sessions require valid expiry and root, challenges require valid expiry", async () => {
  await expect(
    db.insert("sessions", {
      id: "bad-session",
      accountId,
      rootId: "r",
      expiresAt: "tomorrow",
    }),
  ).rejects.toThrow();
  await expect(
    db.insert("challenges", { id: "bad-challenge", expiresAt: "tomorrow" }),
  ).rejects.toThrow();
});

it("allows cancellation of unconsumed verified approval even after expiry without reopening it", async () => {
  const a = { ...action, id: "a-cancel", nonce: "n-cancel" };
  await db.insert("actions", a);
  const b = { ...binding, nonce: a.nonce, expiresAt: "2020-01-01T00:00:00Z" };
  await db.insert("approvals", {
    ...approval,
    id: "p-cancel",
    actionId: a.id,
    binding: b,
    bindingHash: hashCanonical(b),
  });
  const cancelled = await db.transaction((tx) =>
    tx.updateApprovalStatus("p-cancel", "CANCELLED"),
  );
  expect(cancelled.status).toBe("CANCELLED");
  expect(cancelled.verifiedAt).toBe(approval.verifiedAt);
  await expect(
    db.transaction((tx) => tx.consumeApproval("p-cancel", new Date())),
  ).rejects.toThrow();
  await expect(
    db.transaction((tx) =>
      tx.updateApprovalStatus("p-cancel", "VERIFIED", {
        verifiedAt: new Date().toISOString(),
        nullifierHash: hashCanonical("human"),
      }),
    ),
  ).rejects.toThrow();
});
