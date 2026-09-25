import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { Database } from "@humanos/database";
import {
  createPublicClient,
  http,
  keccak256,
  parseTransaction,
  type PublicClient,
} from "viem";
import { foundry } from "viem/chains";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import {
  createEnsWriter,
  createPrivateKeyBackend,
  createPostgresTransactionJournal,
  initializeEnsTransactionJournal,
  createEnsAdapterFromEnv,
  type EnsWriter,
  type JournalEntry,
  readText,
  TEXT_KEYS,
} from "../src/index.js";
import { createMemoryJournal } from "./helpers/memory-journal.js";
import {
  ANVIL_KEY_0,
  startLocalEnsv2,
  type LocalDeployment,
} from "./helpers/anvil.js";

const schema = `ens_journal_${randomUUID().replaceAll("-", "")}`;
const url =
  process.env.TEST_DATABASE_URL ??
  process.env.DATABASE_URL ??
  "postgresql://saikarthik@127.0.0.1:55432/humanos";
let db: Database;
let env: LocalDeployment;
let client: PublicClient;
let writer: EnsWriter;
const reopen = async () => {
  await db?.close();
  db = new Database(url, { schema });
  await db.query(`CREATE SCHEMA IF NOT EXISTS "${schema}"`);
  await initializeEnsTransactionJournal(db);
  writer = createEnsWriter({
    client,
    registrar: env.registrar,
    operator: createPrivateKeyBackend(ANVIL_KEY_0, foundry, http(env.rpcUrl)),
    journal: createPostgresTransactionJournal(db),
    receiptTimeoutMs: 200,
  });
};
const rpc = (method: string, params: unknown[] = []) =>
  client.request({ method: method as never, params: params as never });
const records = async () =>
  (
    await db.query<{
      nonce: string;
      raw: `0x${string}`;
      hash: `0x${string}`;
      operation: string;
    }>(
      "SELECT nonce,raw,hash,operation FROM humanos_ens_transactions ORDER BY nonce",
    )
  ).rows;
beforeAll(async () => {
  env = await startLocalEnsv2(
    BigInt(Math.floor(Date.now() / 1000) + 86400 * 365),
  );
  client = createPublicClient({
    chain: foundry,
    transport: http(env.rpcUrl),
    pollingInterval: 20,
  }) as PublicClient;
  await reopen();
});
afterAll(async () => {
  await db?.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
  await db?.close();
  env?.stop();
});

describe("durable ENS signed transaction journal", () => {
  it("reuses pending funding bytes and nonce after database/client restart, without topping up twice", async () => {
    const recipient = privateKeyToAccount(generatePrivateKey()).address;
    await rpc("evm_setAutomine", [false]);
    try {
      await expect(writer.fundAccount(recipient, 1000n)).rejects.toMatchObject({
        code: "UNAVAILABLE",
      });
      const original = (await records()).at(-1)!;
      expect(keccak256(original.raw)).toBe(original.hash);
      expect(parseTransaction(original.raw).value).toBe(1000n);
      await reopen();
      const broadcast = vi.spyOn(client, "sendRawTransaction");
      await expect(writer.fundAccount(recipient, 1000n)).rejects.toMatchObject({
        code: "UNAVAILABLE",
      });
      expect(broadcast).toHaveBeenCalledWith({
        serializedTransaction: original.raw,
      });
      expect((await records()).at(-1)).toEqual(original);
      broadcast.mockRestore();
      await rpc("evm_mine");
      const done = await writer.fundAccount(recipient, 1000n);
      expect(done.hash).toBe(original.hash);
      expect(await client.getBalance({ address: recipient })).toBe(1000n);
      // Spending the funding does not turn a retry into a second top-up.
      await rpc("anvil_setBalance", [recipient, "0x0"]);
      expect((await writer.fundAccount(recipient, 1000n)).hash).toBe(
        original.hash,
      );
      expect(await client.getBalance({ address: recipient })).toBe(0n);
    } finally {
      await rpc("evm_setAutomine", [true]);
    }
  });

  it("persists before broadcast failure and resumes exactly that signed intent", async () => {
    const recipient = privateKeyToAccount(generatePrivateKey()).address;
    const before = (await records()).length;
    const send = vi
      .spyOn(client, "sendRawTransaction")
      .mockRejectedValue(new Error("transport unavailable"));
    await expect(writer.fundAccount(recipient, 1234n)).rejects.toMatchObject({
      code: "UNAVAILABLE",
    });
    const entry = (await records()).at(-1)!;
    expect((await records()).length).toBe(before + 1);
    expect(await client.getBalance({ address: recipient })).toBe(0n);
    send.mockRestore();
    await reopen();
    const done = await writer.fundAccount(recipient, 1234n);
    expect(done.hash).toBe(entry.hash);
    expect(await client.getBalance({ address: recipient })).toBe(1234n);
  });

  it("serializes independent journal instances and reserves each signer nonce once", async () => {
    const recipient = privateKeyToAccount(generatePrivateKey()).address;
    const otherDb = new Database(url, { schema });
    const other = createEnsWriter({
      client,
      registrar: env.registrar,
      operator: createPrivateKeyBackend(ANVIL_KEY_0, foundry, http(env.rpcUrl)),
      journal: createPostgresTransactionJournal(otherDb),
    });
    try {
      const before = (await records()).length;
      const results = await Promise.all([
        writer.fundAccount(recipient, 4321n),
        other.fundAccount(recipient, 4321n),
      ]);
      expect(results[0]?.hash).toBe(results[1]?.hash);
      expect((await records()).length).toBe(before + 1);
      expect(await client.getBalance({ address: recipient })).toBe(4321n);
    } finally {
      await otherDb.close();
    }
  });

  it("replays a completed logical resolver write without reverting a later value", async () => {
    const expiry = new Date(
      (Number((await client.getBlock()).timestamp) + 86400) * 1000,
    );
    const owner = createPrivateKeyBackend(
      ANVIL_KEY_0,
      foundry,
      http(env.rpcUrl),
    );
    const root = await writer.registerRoot({
      label: "journalroot",
      rootId: "journalroot",
      owner: owner.account.address,
      expiresAt: expiry,
    });
    const agent = createPrivateKeyBackend(
      generatePrivateKey(),
      foundry,
      http(env.rpcUrl),
    );
    await writer.registerAgent({
      rootNode: root.node,
      rootLabel: "journalroot",
      label: "agent",
      account: agent.account.address,
      capabilities: ["drafts.write"],
      expiresAt: expiry,
    });
    await writer.fundAccount(agent.account.address, 10n ** 16n);
    const name = `agent.journalroot.${await writer.getParentName()}`;
    const first = await writer.writeAgentRecord({
      agent,
      name,
      key: "status",
      value: "first",
    });
    await writer.writeAgentRecord({
      agent,
      name,
      key: "status",
      value: "second",
    });
    const count = (await records()).length;
    await reopen();
    const retry = await writer.writeAgentRecord({
      agent,
      name,
      key: "status",
      value: "first",
    });
    expect(retry.hash).toBe(first.hash);
    const authorization = await writer.agentAuthorization(first.node);
    expect(
      await readText(
        client,
        authorization.resolver,
        name,
        TEXT_KEYS.status,
        await client.getBlockNumber({ cacheTime: 0 }),
      ),
    ).toBe("second");
    expect((await records()).length).toBe(count);
  });

  it("never prepares again after a journaled reverted transaction", async () => {
    const recipient = privateKeyToAccount(generatePrivateKey()).address;
    const result = await writer.fundAccount(recipient, 99n);
    await createPostgresTransactionJournal(db).markReverted(result.hash!);
    await reopen();
    const send = vi.spyOn(client, "sendRawTransaction");
    await expect(writer.fundAccount(recipient, 99n)).rejects.toMatchObject({
      code: "REVERTED",
    });
    expect(send).not.toHaveBeenCalled();
    send.mockRestore();
  });

  it("fails closed without a durable production journal", () => {
    expect(() => createEnsAdapterFromEnv({}, createMemoryJournal())).toThrow(
      "durable ENS journal required",
    );
  });

  it("does not broadcast when persistence fails", async () => {
    const failing = createEnsWriter({
      client,
      registrar: env.registrar,
      operator: createPrivateKeyBackend(ANVIL_KEY_0, foundry, http(env.rpcUrl)),
      journal: {
        durable: true,
        reserve: async (): Promise<JournalEntry> => {
          throw new Error("database down");
        },
        markReverted: async () => {},
      },
    });
    const send = vi.spyOn(client, "sendRawTransaction");
    await expect(
      failing.fundAccount(
        privateKeyToAccount(generatePrivateKey()).address,
        100n,
      ),
    ).rejects.toThrow("database down");
    expect(send).not.toHaveBeenCalled();
    send.mockRestore();
  });
});
