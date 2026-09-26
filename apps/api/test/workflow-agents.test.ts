import { afterAll, beforeAll, expect, it, vi } from "vitest";
import { Database, WorkflowStore, WorkflowAgentStore } from "@humanos/database";
import {
  hashCanonical,
  ensNamehash,
  type WorkflowVersion,
} from "@humanos/schemas";
import { EnsAuthorizationError, type WorkflowEnsPort } from "@humanos/ens";
import { createWorkflowAgentService } from "../src/workflows/agents.js";
const schema = `test_workflow_agents_api_${Date.now()}`;
const db = new Database(
  process.env.TEST_DATABASE_URL ??
    "postgresql://saikarthik@127.0.0.1:55432/humanos",
  { schema },
);
const store = new WorkflowStore(db),
  agentStore = new WorkflowAgentStore(db);
const address = "0x1111111111111111111111111111111111111111";
const actor = { accountId: `11155111:${address}`, rootId: "root-agent-api" };
let sequence = 0;
const now = new Date();
const node = ensNamehash("agent.root.test-humanos.eth");
let active = true;
let registeredExpiry = new Date(now.getTime() + 86400000).toISOString();
const ens = {
  review: async (input: { requestedExpiry: string }) => ({
    parentName: "test-humanos.eth",
    effectiveExpiry: input.requestedExpiry,
    chainId: 11155111,
  }),
  register: vi.fn(async (input: { expiresAt: string }) => {
    registeredExpiry = input.expiresAt;
    return {
      ensName: "agent.root.test-humanos.eth",
      node,
      agentAddress: address,
      txHashes: [],
    };
  }),
  checkRootOwner: async () => true,
  readAuthorization: async () => ({
    active,
    revoked: !active,
    rootId: actor.rootId,
    capabilities: ["drafts.write"],
    expiresAt: registeredExpiry,
    checkedAt: new Date().toISOString(),
    finalized: true,
  }),
  readAuthorizationDetails: async () => ({
    authorization: await ens.readAuthorization("agent.root.test-humanos.eth"),
    node,
    account: address,
    finalizedSnapshot: { account: address },
    latestSnapshot: { account: address },
  }),
  revoke: vi.fn(async () => ({ txHashes: [] })),
  writeReceipt: vi.fn(async () => ({ txHashes: [] })),
} as unknown as WorkflowEnsPort;
const service = createWorkflowAgentService({ db, store, agentStore, ens });
it("settles the original missing registration before revoking so replacement is not blocked", async () => {
  const { id, version } = await workflow();
  let exists = false;
  let offline = true;
  const port: WorkflowEnsPort = {
    ...ens,
    identity: async () => ({
      ensName: "agent.root.test-humanos.eth",
      node,
      agentAddress: address,
    }),
    register: async (input) => {
      if (offline) throw new Error("offline");
      exists = true;
      return ens.register(input);
    },
    readAuthorizationDetails: async (name) => {
      if (!exists)
        throw new EnsAuthorizationError("NOT_FOUND", "not registered");
      return ens.readAuthorizationDetails(name);
    },
  };
  const guarded = createWorkflowAgentService({
    db,
    store,
    agentStore,
    ens: port,
  });
  const { review } = await guarded.review(actor, id, version.id);
  const pending = (
    await guarded.enable(actor, id, review.id, review.reviewHash)
  ).binding;
  expect(pending.state).toBe("PENDING_REGISTRATION");
  offline = false;
  const revoked = await guarded.revoke(actor, pending.id);
  expect(revoked.binding.state).toBe("REVOKED");
  expect(exists).toBe(true);
  const replacement = await guarded.review(actor, id, version.id);
  expect(replacement.review.id).not.toBe(review.id);
});
async function workflow() {
  const id = `wf-${++sequence}`,
    at = now.toISOString();
  const graph = {
    nodes: [
      {
        id: "draft",
        type: "content.generate" as const,
        blockVersion: "1.0.0",
        dependsOn: [],
        input: {
          brief: {
            instruction: "Write hello",
            context: {},
            outputSchema: "text",
            maxCharacters: 100,
          },
        },
        capability: null,
        timeoutMs: 1000,
        maxAttempts: 1,
      },
    ],
  };
  const version: WorkflowVersion = {
    id: `${id}-v1`,
    workflowId: id,
    version: 1,
    goal: "Write hello",
    normalizedIntent: {},
    graph,
    graphHash: hashCanonical(graph),
    requiredCapabilities: [],
    connectorRefs: [],
    browserFallbackAllowed: false,
    trigger: { kind: "manual" },
    assembler: {
      modelId: "test",
      modelVersion: "test",
      decisionHash: hashCanonical([]),
    },
    createdAt: at,
    activatedAt: null,
  };
  await store.createDraft(
    {
      id,
      accountId: actor.accountId,
      rootId: actor.rootId,
      missionId: null,
      name: "Draft",
      status: "DRAFT",
      latestVersionId: version.id,
      createdAt: at,
      updatedAt: at,
      archivedAt: null,
    },
    version,
  );
  await store.activateVersion(id, version.id, version.graphHash);
  return { id, version };
}
beforeAll(async () => {
  await db.migrate();
  await db.insert("accounts", {
    id: actor.accountId,
    address,
    chainId: 11155111,
    createdAt: now.toISOString(),
  });
  await db.insert("roots", {
    id: actor.rootId,
    ensName: null,
    createdAt: now.toISOString(),
    verificationEnvironment: "staging",
  });
  await db.transaction((tx) =>
    tx.bindRootAccount(actor.rootId, actor.accountId, now),
  );
});
afterAll(async () => {
  await db.query(`DROP SCHEMA "${schema}" CASCADE`);
  await db.close();
});
it("reviews content scope without a chain write, rejects tampering, and makes enable idempotent", async () => {
  const { id, version } = await workflow();
  const before = vi.mocked(ens.register).mock.calls.length;
  const { review } = await service.review(actor, id, version.id);
  expect(review.capabilities).toEqual(["drafts.write"]);
  expect(vi.mocked(ens.register).mock.calls.length).toBe(before);
  await expect(
    service.enable(actor, id, review.id, hashCanonical("tampered")),
  ).rejects.toThrow();
  const enabled = await service.enable(actor, id, review.id, review.reviewHash);
  expect(enabled.binding.state).toBe("ACTIVE");
  const duplicate = await service.enable(
    actor,
    id,
    review.id,
    review.reviewHash,
  );
  expect(duplicate.binding.id).toBe(enabled.binding.id);
  expect(vi.mocked(ens.register).mock.calls.length).toBe(before + 1);
});
it("rejects a different account or root without exposing a binding", async () => {
  const { id, version } = await workflow();
  await expect(
    service.review({ ...actor, accountId: "other" }, id, version.id),
  ).rejects.toThrow();
  await expect(
    service.review({ ...actor, rootId: "other" }, id, version.id),
  ).rejects.toThrow();
});
it("reports missing ENS configuration without pretending registration succeeded", async () => {
  const { id, version } = await workflow();
  const unavailable = createWorkflowAgentService({
    db,
    store,
    agentStore,
    ens: null,
  });
  expect((await unavailable.detail(actor, id)).available).toBe(false);
  await expect(unavailable.review(actor, id, version.id)).rejects.toThrow(
    "ENS_UNAVAILABLE",
  );
});
it("persists local denial even if onchain revocation is unavailable", async () => {
  const { id, version } = await workflow();
  const { review } = await service.review(actor, id, version.id);
  const { binding } = await service.enable(
    actor,
    id,
    review.id,
    review.reviewHash,
  );
  vi.mocked(ens.revoke).mockRejectedValueOnce(new Error("rpc unavailable"));
  await service.revoke(actor, binding.id);
  expect((await agentStore.get(binding.id))?.state).toBe("REVOKING");
});
it("rejects expired reviews without registering", async () => {
  const { id, version } = await workflow();
  let time = new Date();
  const timed = createWorkflowAgentService({
    db,
    store,
    agentStore,
    ens,
    clock: () => time,
  });
  const { review } = await timed.review(actor, id, version.id);
  time = new Date(time.getTime() + 300001);
  const count = vi.mocked(ens.register).mock.calls.length;
  await expect(
    timed.enable(actor, id, review.id, review.reviewHash),
  ).rejects.toThrow("REVIEW_EXPIRED");
  expect(vi.mocked(ens.register).mock.calls.length).toBe(count);
});
it("concurrent enable returns one binding without widening the reservation", async () => {
  const { id, version } = await workflow();
  const { review } = await service.review(actor, id, version.id);
  const results = await Promise.all(
    [1, 2, 3].map(() =>
      service.enable(actor, id, review.id, review.reviewHash),
    ),
  );
  expect(new Set(results.map((r) => r.binding.id)).size).toBe(1);
  expect((await service.detail(actor, id)).bindings).toHaveLength(1);
});
it("revocation while registration is awaiting RPC never becomes ACTIVE", async () => {
  const { id, version } = await workflow();
  let release!: () => void;
  let entered!: () => void;
  const started = new Promise<void>((resolve) => {
    entered = resolve;
  });
  const barrier = new Promise<void>((resolve) => {
    release = resolve;
  });
  const delayed = {
    ...ens,
    register: async (input: Parameters<WorkflowEnsPort["register"]>[0]) => {
      entered();
      await barrier;
      return ens.register(input);
    },
  };
  const guarded = createWorkflowAgentService({
    db,
    store,
    agentStore,
    ens: delayed,
  });
  const { review } = await guarded.review(actor, id, version.id);
  const enabling = guarded.enable(actor, id, review.id, review.reviewHash);
  await started;
  const pending = (await guarded.detail(actor, id)).binding!;
  await guarded.revoke(actor, pending.id);
  release();
  expect((await enabling).binding.state).toBe("REVOKING");
});
it("does not present stored ACTIVE as live authority when current chain reads fail", async () => {
  const { id, version } = await workflow();
  const { review } = await service.review(actor, id, version.id);
  await service.enable(actor, id, review.id, review.reviewHash);
  const offline = createWorkflowAgentService({
    db,
    store,
    agentStore,
    ens: {
      ...ens,
      readAuthorizationDetails: async () => {
        throw new Error("offline");
      },
    },
  });
  expect((await offline.detail(actor, id)).available).toBe(false);
});
it("rejects cross-root detail and revocation for an otherwise matching account", async () => {
  const { id, version } = await workflow();
  const { review } = await service.review(actor, id, version.id);
  const { binding } = await service.enable(
    actor,
    id,
    review.id,
    review.reviewHash,
  );
  await expect(
    service.detail({ ...actor, rootId: "different-root" }, id),
  ).rejects.toThrow("NOT_FOUND");
  await expect(
    service.revoke({ ...actor, rootId: "different-root" }, binding.id),
  ).rejects.toThrow("NOT_FOUND");
  expect((await agentStore.get(binding.id))?.state).toBe("ACTIVE");
});
