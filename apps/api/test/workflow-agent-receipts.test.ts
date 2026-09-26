import { afterAll, beforeAll, beforeEach, expect, it, vi } from "vitest";
import { hashCanonical, type Hex } from "@humanos/schemas";
import { createWorkflowAgentReceipts } from "../src/workflows/agent-receipts.js";
import { EMAIL, createAgentFixture } from "./workflow-agent-fixture.js";

const f = createAgentFixture("test_workflow_agent_receipts");
const TX = `0x${"ab".repeat(32)}` as Hex;
it("reconciles every receipt across batches without starving partially scanned runs", async () => {
  const { run, receipt } = await completedEnsRun();
  for (let i = 0; i < 105; i++)
    await f.store.recordReceipt({
      ...receipt,
      id: `batch-${i.toString().padStart(3, "0")}-${run.id}`,
    });
  const receipts = publisher();
  expect(await receipts.scan()).toBe(100);
  expect(await receipts.scan()).toBe(6);
  expect(await receipts.scan()).toBe(0);
  expect(await jobs(run.id)).toHaveLength(106);
}, 30000);
type Options = Omit<
  Parameters<typeof createWorkflowAgentReceipts>[0],
  "db" | "agentStore" | "ens"
>;
const publisher = (options: Options = {}) =>
  createWorkflowAgentReceipts({
    db: f.db,
    agentStore: f.agentStore,
    ens: f.ens,
    retryDelayMs: 0,
    ...options,
  });
const jobs = async (runId: string) =>
  (
    await f.db.query<{
      id: string;
      binding_id: string;
      receipt_hash: string;
      state: string;
      attempts: number;
      tx_hashes: Hex[];
    }>(
      "SELECT id,binding_id,receipt_hash,state,attempts,tx_hashes FROM workflow_agent_receipt_jobs WHERE run_id=$1",
      [runId],
    )
  ).rows;
async function completedEnsRun() {
  const wf = await f.workflow("research");
  const binding = await f.bind(wf, ["web.search"]);
  const run = await f.start(wf.id);
  await f.drain();
  expect((await f.run(run.id))?.status).toBe("COMPLETED");
  const receipt = (await f.service.runDetail(f.actor, run.id)).receipts[0]!;
  return { binding, run, receipt };
}

beforeAll(() => f.init());
afterAll(() => f.close());
beforeEach(async () => {
  await f.reset();
  // Isolate the shared queue: jobs from earlier tests are settled so each test observes only its own.
  await publisher().scan();
  await f.db.query(
    "UPDATE workflow_agent_receipt_jobs SET state='FAILED' WHERE state IN ('PENDING','PUBLISHING')",
  );
});

it("reconciles a durable ENS receipt into one hash-only job and retries publication without re-executing", async () => {
  const { binding, run, receipt } = await completedEnsRun();
  expect(f.effectsFor(run.id)).toEqual(["research"]);
  const receipts = publisher();
  expect(await receipts.scan()).toBe(1);
  expect(await receipts.scan()).toBe(0);
  expect(await jobs(run.id)).toMatchObject([
    {
      binding_id: binding.id,
      receipt_hash: hashCanonical(receipt),
      state: "PENDING",
      attempts: 0,
      tx_hashes: [],
    },
  ]);
  f.port.writeReceipt
    .mockRejectedValueOnce(new Error("receipt timeout"))
    .mockResolvedValueOnce({ txHashes: [TX] });
  expect(await receipts.publishNext()).toMatchObject({
    state: "PENDING",
    attempts: 1,
    txHashes: [],
  });
  expect(await jobs(run.id)).toMatchObject([
    { state: "PENDING", tx_hashes: [] },
  ]);
  expect(await receipts.publishNext()).toMatchObject({
    state: "PUBLISHED",
    attempts: 2,
    txHashes: [TX],
  });
  expect(await receipts.publishNext()).toBeNull();
  expect(f.effectsFor(run.id)).toEqual(["research"]);
  expect(f.port.writeReceipt).toHaveBeenCalledTimes(2);
  for (const [identity, hash] of f.port.writeReceipt.mock.calls) {
    expect(hash).toBe(hashCanonical(receipt));
    expect(identity.ensName).toBe(binding.ensName);
  }
  const published = JSON.stringify([
    f.port.writeReceipt.mock.calls,
    await jobs(run.id),
  ]);
  expect(published).not.toContain(EMAIL);
  expect(published).not.toContain("Private note");
  expect(published).not.toContain("Searched on behalf");
  expect(published).not.toMatch(/privateKey|agentKeySeed|mnemonic/i);
});

it("admits only receipts of ENS-pinned runs, to their own binding, as a hash", async () => {
  const { binding, run } = await completedEnsRun();
  const account = await f.workflow("research");
  const accountRun = await f.start(account.id);
  await f.drain();
  expect(accountRun.authorityMode).toBe("account");
  expect((await f.run(accountRun.id))?.status).toBe("COMPLETED");
  const accountReceipt = (await f.service.runDetail(f.actor, accountRun.id))
    .receipts[0]!;
  const receipts = publisher();
  await receipts.scan();
  expect(await jobs(accountRun.id)).toHaveLength(0);
  await expect(
    receipts.enqueue(binding.id, accountRun.id, hashCanonical(accountReceipt)),
  ).rejects.toThrow("RECEIPT_RUN_MISMATCH");
  const other = await f.bind(await f.workflow("research"), ["web.search"]);
  const extra = hashCanonical({ extra: run.id });
  await expect(receipts.enqueue(other.id, run.id, extra)).rejects.toThrow(
    "RECEIPT_RUN_MISMATCH",
  );
  await expect(
    receipts.enqueue(binding.id, run.id, `Sent to ${EMAIL}`),
  ).rejects.toThrow("INVALID_RECEIPT_HASH");
  await Promise.all(
    [1, 2, 3].map(() => receipts.enqueue(binding.id, run.id, extra)),
  );
  expect(
    (await jobs(run.id)).filter((job) => job.receipt_hash === extra),
  ).toHaveLength(1);
});

it("never publishes through, or claims publication for, a revoked agent", async () => {
  const { binding, run } = await completedEnsRun();
  const receipts = publisher();
  await receipts.scan();
  await f.revoke(binding);
  expect(await receipts.publishNext()).toMatchObject({
    runId: run.id,
    state: "FAILED",
    txHashes: [],
  });
  expect(f.port.writeReceipt).not.toHaveBeenCalled();
});

it("ends FAILED rather than PUBLISHED after exhausting retries", async () => {
  const { run } = await completedEnsRun();
  const receipts = publisher({ maxAttempts: 2 });
  await receipts.scan();
  f.port.writeReceipt.mockRejectedValue(new Error("rpc unavailable"));
  expect(await receipts.publishNext()).toMatchObject({
    state: "PENDING",
    attempts: 1,
  });
  expect(await receipts.publishNext()).toMatchObject({
    state: "FAILED",
    attempts: 2,
  });
  expect(await receipts.publishNext()).toBeNull();
  expect(await jobs(run.id)).toMatchObject([
    { state: "FAILED", tx_hashes: [] },
  ]);
  expect(f.effectsFor(run.id)).toEqual(["research"]);
});

it("persists a safe funding reason without leaking provider details and clears it after recovery", async () => {
  const { run } = await completedEnsRun();
  const receipts = publisher();
  await receipts.scan();
  f.port.writeReceipt
    .mockRejectedValueOnce(
      Object.assign(new Error("private RPC credential"), {
        cause: Object.assign(new Error("private transaction details"), {
          name: "InsufficientFundsError",
        }),
      }),
    )
    .mockResolvedValueOnce({ txHashes: [TX] });
  expect(await receipts.publishNext()).toMatchObject({
    errorCode: "INSUFFICIENT_FUNDS",
    state: "PENDING",
  });
  const detail = await f.db.query(
    "SELECT error_code FROM workflow_agent_receipt_jobs WHERE run_id=$1",
    [run.id],
  );
  expect(detail.rows).toEqual([{ error_code: "INSUFFICIENT_FUNDS" }]);
  expect(await receipts.publishNext()).toMatchObject({
    errorCode: null,
    state: "PUBLISHED",
  });
  expect(f.effectsFor(run.id)).toEqual(["research"]);
});

it("fences a stale publisher so it cannot overwrite a reclaimed job", async () => {
  const { run } = await completedEnsRun();
  let offset = 0;
  const receipts = publisher({
    clock: () => new Date(Date.now() + offset),
    leaseMs: 1000,
  });
  await receipts.scan();
  let release: (() => void) | undefined;
  f.port.writeReceipt
    .mockImplementationOnce(
      () =>
        new Promise<{ txHashes: Hex[] }>((_, reject) => {
          release = () => reject(new Error("late timeout"));
        }),
    )
    .mockResolvedValueOnce({ txHashes: [TX] });
  const stale = receipts.publishNext();
  await vi.waitFor(() => {
    if (!release) throw new Error("pending");
  });
  offset = 5000;
  expect(await receipts.publishNext()).toMatchObject({
    state: "PUBLISHED",
    attempts: 2,
    txHashes: [TX],
  });
  release!();
  expect(await stale).toBeNull();
  expect(await jobs(run.id)).toMatchObject([
    { state: "PUBLISHED", attempts: 2, tx_hashes: [TX] },
  ]);
});
