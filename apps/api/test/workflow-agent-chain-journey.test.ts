import { afterAll, beforeAll, expect, it } from "vitest";
import { createPublicClient, http, toHex, type PublicClient } from "viem";
import { foundry } from "viem/chains";
import {
  createAuthorizationReader,
  createEnsWriter,
  createHumanOSEnsAdapter,
  createPrivateKeyBackend,
  type WorkflowEnsPort,
} from "@humanos/ens";
import {
  startLocalEnsv2,
  ANVIL_KEY_0,
  type LocalDeployment,
} from "../../../packages/ens/test/helpers/anvil.js";
import { createMemoryJournal } from "../../../packages/ens/test/helpers/memory-journal.js";
import { createWorkflowAgentReceipts } from "../src/workflows/agent-receipts.js";
import { createWorkflowAgentService } from "../src/workflows/agents.js";
import { createAgentFixture, OWNER } from "./workflow-agent-fixture.js";

// Real local contracts + PostgreSQL + runner. Research executor is a counting fixture;
// this is not a Sepolia deployment, live provider test, or production chain override.
const f = createAgentFixture("test_workflow_agent_chain_journey");
let env: LocalDeployment | undefined;
let port: WorkflowEnsPort;
let client: PublicClient;
let skew = 0;
beforeAll(async () => {
  await f.init();
  env = await startLocalEnsv2(BigInt(Math.floor(Date.now() / 1000) + 864000));
  const transport = http(env.rpcUrl);
  client = createPublicClient({
    chain: foundry,
    transport,
    pollingInterval: 30,
  }) as PublicClient;
  port = createHumanOSEnsAdapter({
    writer: createEnsWriter({
      client,
      registrar: env.registrar,
      operator: createPrivateKeyBackend(ANVIL_KEY_0, foundry, transport),
      journal: createMemoryJournal(),
      receiptTimeoutMs: 3000,
    }),
    reader: createAuthorizationReader({
      client,
      chainId: 31337,
      registrar: env.registrar,
      universalResolver: env.universalResolver,
      now: () => new Date(Date.now() + skew),
    }),
    chain: foundry,
    transport,
    agentKeySeed: `0x${"33".repeat(32)}`,
    agentFundingWei: 10n ** 16n,
  }).workflow;
}, 600000);
afterAll(async () => {
  env?.stop();
  await f.close();
});
it("registers, executes with live ENS authority, publishes a receipt and denies a chain-revoked agent", async () => {
  const wf = await f.workflow("research");
  const review = await port.review({
    rootId: f.rootId,
    rootOwner: OWNER,
    requestedExpiry: new Date(Date.now() + 86400000).toISOString(),
  });
  expect(review.chainId).toBe(31337);
  const at = new Date().toISOString();
  const pending = await f.agentStore.reserve({
    accountId: f.actor.accountId,
    rootId: f.rootId,
    workflowId: wf.id,
    versionId: wf.version.id,
    graphHash: wf.version.graphHash,
    capabilities: ["web.search"],
    expiresAt: review.effectiveExpiry,
    state: "PENDING_REGISTRATION",
    createdAt: at,
    updatedAt: at,
  });
  const registration = await port.register({
    derivationId: pending.derivationId,
    rootId: f.rootId,
    rootOwner: OWNER,
    capabilities: pending.capabilities,
    expiresAt: pending.expiresAt,
  });
  expect(registration.txHashes.length).toBeGreaterThan(0);
  await client.request({
    method: "anvil_mine" as never,
    params: [toHex(65)] as never,
  });
  skew =
    Number((await client.getBlock({ blockTag: "latest" })).timestamp) * 1000 -
    Date.now();
  expect((await port.readAuthorization(registration.ensName)).active).toBe(
    true,
  );
  const binding = await f.agentStore.transition(
    pending.id,
    pending.revision,
    "ACTIVE",
    { at: new Date(), registration },
  );
  const run = await f.start(wf.id);
  await f.drain({ ens: port });
  expect((await f.run(run.id))?.status).toBe("COMPLETED");
  expect(f.effectsFor(run.id)).toEqual(["research"]);
  const receipts = createWorkflowAgentReceipts({
    db: f.db,
    agentStore: f.agentStore,
    ens: port,
    retryDelayMs: 0,
  });
  expect(await receipts.scan()).toBe(1);
  const published = await receipts.publishNext();
  expect(published?.state).toBe("PUBLISHED");
  expect(published?.txHashes).toHaveLength(1);
  const management = createWorkflowAgentService({
    db: f.db,
    store: f.store,
    agentStore: f.agentStore,
    ens: port,
  });
  expect(
    (await management.detail(f.actor, wf.id)).receiptPublications,
  ).toMatchObject([
    { state: "PUBLISHED", txHashes: published!.txHashes, runId: run.id },
  ]);
  const second = await f.start(wf.id);
  expect((await port.revoke(binding)).txHashes).toHaveLength(1);
  await f.drain({ ens: port });
  expect((await f.run(second.id))?.status).toBe("REVOKED");
  expect(f.effectsFor(second.id)).toEqual([]);
}, 60000);
