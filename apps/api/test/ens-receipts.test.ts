import { expect, it } from "vitest";
import {
  hashCanonical,
  type Mission,
  type ExecutionReceipt,
  type AgentAuthorization,
} from "@humanos/schemas";
import {
  createReceiptPublisher,
  type ReceiptPublisherIO,
} from "../src/ens-receipts.js";
const mission: Mission = {
  id: "m",
  rootId: "r",
  agentEns: "a.eth",
  state: "RUNNING",
  title: "t",
  goal: "g",
  steps: [],
  capabilities: ["application.submit"],
  approvedCapabilities: ["application.submit"],
  expiresAt: "2099-01-01T00:00:00.000Z",
  createdAt: "2026-01-01T00:00:00.000Z",
  updatedAt: "2026-01-01T00:00:00.000Z",
  policyVersion: "v1",
};
const receipt: ExecutionReceipt = {
  id: "receipt",
  actionId: "action",
  missionId: "m",
  payloadHash: hashCanonical({}),
  idempotencyKey: "key",
  status: "SUCCEEDED",
  externalId: "external",
  executedAt: "2026-01-01T00:00:00.000Z",
  metadata: {},
};
const receiptHash = hashCanonical({
  id: receipt.id,
  actionId: receipt.actionId,
  missionId: receipt.missionId,
  payloadHash: receipt.payloadHash,
  externalId: receipt.externalId,
  status: receipt.status,
});
function setup() {
  let latest = "",
    finalized = "";
  let writes = 0;
  const authorization: AgentAuthorization = {
    agentEns: "a.eth",
    rootId: "r",
    capabilities: ["application.submit"],
    active: true,
    revoked: false,
    expiresAt: mission.expiresAt,
    checkedAt: new Date().toISOString(),
    blockNumber: 10,
    finalized: true,
  };
  const io: ReceiptPublisherIO = {
    getMission: async () => mission,
    readAuthorization: async () => ({
      authorization,
      resolver: "0x0000000000000000000000000000000000000001",
      latestBlock: 11n,
      finalizedBlock: 10n,
    }),
    readRecord: async ({ blockNumber }) =>
      blockNumber === 10n ? finalized : latest,
    writeRecord: async (_m, value) => {
      writes++;
      latest = value;
      finalized = value;
    },
  };
  return {
    io,
    authorization,
    publish: () =>
      createReceiptPublisher(io)({ agentEns: "a.eth", receiptHash, receipt }),
    get writes() {
      return writes;
    },
    get latest() {
      return latest;
    },
    set latest(value: string) {
      latest = value;
    },
    set finalized(value: string) {
      finalized = value;
    },
  };
}
it("preserves previous entries and repeated publication writes once", async () => {
  const x = setup();
  const previous = hashCanonical("previous");
  x.latest = JSON.stringify({ previous });
  x.finalized = x.latest;
  await x.publish();
  await x.publish();
  expect(x.writes).toBe(1);
  expect(JSON.parse(x.latest)).toEqual({ previous, action: receiptHash });
});
it("rejects conflicting commitments without overwriting", async () => {
  const x = setup();
  x.latest = JSON.stringify({ action: hashCanonical("other") });
  await expect(x.publish()).rejects.toThrow("CONFLICT");
  expect(x.writes).toBe(0);
});
it("pending finality retry does not write or submit again", async () => {
  const x = setup();
  x.latest = JSON.stringify({ action: receiptHash });
  await expect(x.publish()).rejects.toThrow("FINALITY_PENDING");
  await expect(x.publish()).rejects.toThrow("FINALITY_PENDING");
  expect(x.writes).toBe(0);
  x.finalized = x.latest;
  await expect(x.publish()).resolves.toBeUndefined();
});
it("revoked authorization cannot write", async () => {
  const x = setup();
  x.authorization.revoked = true;
  await expect(x.publish()).rejects.toThrow();
  expect(x.writes).toBe(0);
});
it("rejects wrong mission ownership and malformed existing ledger", async () => {
  const x = setup();
  x.authorization.rootId = "other";
  await expect(x.publish()).rejects.toThrow();
  expect(x.writes).toBe(0);
  const y = setup();
  y.latest = '{"action":"personal-data"}';
  await expect(y.publish()).rejects.toThrow();
  expect(y.writes).toBe(0);
});
it("rechecks latest authority before writing", async () => {
  const x = setup();
  let calls = 0;
  const read = x.io.readAuthorization;
  x.io.readAuthorization = async (name) => {
    calls++;
    const result = await read(name);
    if (calls === 2) result.authorization.revoked = true;
    return result;
  };
  await expect(x.publish()).rejects.toThrow();
  expect(x.writes).toBe(0);
});
it("a mined but unfinalized write stays pending and retries do not repeat it", async () => {
  const x = setup();
  let submitted = 0;
  x.io.writeRecord = async (_m, value) => {
    submitted++;
    x.latest = value;
  };
  await expect(x.publish()).rejects.toThrow("FINALITY_PENDING");
  await expect(x.publish()).rejects.toThrow("FINALITY_PENDING");
  expect(submitted).toBe(1);
  x.finalized = x.latest;
  await x.publish();
  expect(submitted).toBe(1);
});
it("rejects mismatched receipt digest and unfinalized authorization", async () => {
  const x = setup();
  await expect(
    createReceiptPublisher(x.io)({
      agentEns: "a.eth",
      receipt,
      receiptHash: hashCanonical("wrong"),
    }),
  ).rejects.toThrow("INVALID_RECEIPT_COMMITMENT");
  x.authorization.finalized = false;
  await expect(x.publish()).rejects.toThrow("NOT_AUTHORIZED");
  expect(x.writes).toBe(0);
});
it("retrying an old receipt preserves a newer committed receipt", async () => {
  const x = setup();
  x.latest = JSON.stringify({
    action: receiptHash,
    newer: hashCanonical("newer"),
  });
  x.finalized = x.latest;
  await x.publish();
  expect(x.writes).toBe(0);
  expect(JSON.parse(x.latest).newer).toBe(hashCanonical("newer"));
});
