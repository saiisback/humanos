import { afterAll, beforeAll, expect, it } from "vitest";
import { createPublicClient, http, toHex, type PublicClient } from "viem";
import { foundry } from "viem/chains";
import {
  createAuthorizationReader,
  createEnsWriter,
  createHumanOSEnsAdapter,
  createPrivateKeyBackend,
  type WorkflowEnsPort,
} from "../src/index.js";
import {
  ANVIL_KEY_0,
  startLocalEnsv2,
  type LocalDeployment,
} from "./helpers/anvil.js";
import { createMemoryJournal } from "./helpers/memory-journal.js";
let env: LocalDeployment;
let port: WorkflowEnsPort;
let client: PublicClient;
let clockSkew = 0;
const rootOwner = "0x1111111111111111111111111111111111111111";
beforeAll(async () => {
  env = await startLocalEnsv2(BigInt(Math.floor(Date.now() / 1000) + 864000));
  const transport = http(env.rpcUrl);
  client = createPublicClient({
    chain: foundry,
    transport,
    pollingInterval: 30,
  }) as PublicClient;
  const writer = createEnsWriter({
    client,
    registrar: env.registrar,
    operator: createPrivateKeyBackend(ANVIL_KEY_0, foundry, transport),
    journal: createMemoryJournal(),
    receiptTimeoutMs: 2000,
  });
  port = createHumanOSEnsAdapter({
    writer,
    reader: createAuthorizationReader({
      client,
      chainId: 31337,
      registrar: env.registrar,
      universalResolver: env.universalResolver,
      now: () => new Date(Date.now() + clockSkew),
    }),
    chain: foundry,
    transport,
    agentKeySeed: `0x${"22".repeat(32)}`,
    agentFundingWei: 10n ** 16n,
  }).workflow;
}, 600000);
afterAll(() => env?.stop());
it("registers a real scoped generation, confirms finality, writes a hash and revokes without restoring access on retry", async () => {
  const reviewed = await port.review({
    rootId: "workflow-chain-root",
    rootOwner,
    requestedExpiry: new Date(Date.now() + 86400000).toISOString(),
  });
  expect(reviewed.chainId).toBe(31337);
  const input = {
    derivationId: "workflow:chain-test:1",
    rootId: "workflow-chain-root",
    rootOwner,
    capabilities: ["drafts.write" as const],
    expiresAt: reviewed.effectiveExpiry,
  };
  const registered = await port.register(input);
  expect(registered.txHashes.length).toBeGreaterThan(0);
  const retry = await port.register(input);
  expect(retry.ensName).toBe(registered.ensName);
  expect(retry.agentAddress).toBe(registered.agentAddress);
  await client.request({
    method: "anvil_mine" as never,
    params: [toHex(65)] as never,
  });
  clockSkew =
    Number((await client.getBlock({ blockTag: "latest" })).timestamp) * 1000 -
    Date.now();
  const authorization = await port.readAuthorizationDetails(registered.ensName);
  expect(authorization.authorization).toMatchObject({
    active: true,
    capabilities: ["drafts.write"],
    rootId: input.rootId,
  });
  expect(authorization.account.toLowerCase()).toBe(
    registered.agentAddress.toLowerCase(),
  );
  const binding = {
    ...registered,
    rootId: input.rootId,
    derivationId: input.derivationId,
  };
  const receipt = await port.writeReceipt(binding, `0x${"77".repeat(32)}`);
  expect(receipt.txHashes).toHaveLength(1);
  expect((await port.revoke(binding)).txHashes).toHaveLength(1);
  expect((await port.readAuthorization(registered.ensName)).active).toBe(false);
  await expect(port.register(input)).rejects.toThrow();
  expect((await port.revoke(binding)).txHashes).toEqual([]);
}, 60000);
