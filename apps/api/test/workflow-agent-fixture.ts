import { randomUUID } from "node:crypto";
import { vi } from "vitest";
import type { Address } from "viem";
import { Database, WorkflowAgentStore, WorkflowStore } from "@humanos/database";
import { createDefaultCatalog } from "@humanos/workflows";
import {
  ensNamehash,
  hashCanonical,
  type BlockType,
  type Capability,
  type Hex,
  type StepRun,
  type Workflow,
  type WorkflowAgentBinding,
  type WorkflowNode,
  type WorkflowReceipt,
  type WorkflowRun,
  type WorkflowVersion,
} from "@humanos/schemas";
import type {
  AgentAuthorizationDetails,
  WorkflowEnsIdentity,
  WorkflowEnsPort,
} from "@humanos/ens";
import { createWorkflowAuthorizer } from "../src/workflows/runtime.js";
import { ConnectorRegistry } from "../src/workflows/connectors.js";
import { createWorkflowService } from "../src/workflows/service.js";
import { createWorkflowRunner } from "../src/workflows/runner.js";
import {
  agentCapabilityFor,
  composeWorkflowAuthorizers,
  createWorkflowAgentAuthorizer,
} from "../src/workflows/agent-authorizer.js";
import type {
  StepExecutionContext,
  WorkflowExecutor,
} from "../src/workflows/types.js";

/** Controlled fixtures: local PostgreSQL, a scripted ENS port and counting executors. No live chain or provider. */
export const OWNER = "0x1111111111111111111111111111111111111111";
export const AGENT = "0x2222222222222222222222222222222222222222";
export const OTHER = "0x3333333333333333333333333333333333333333";
export const EMAIL = "alice@example.com";
const RESOLVER: Address = "0x4444444444444444444444444444444444444444";
const ROOT_ID = "root-agent-fixture";

export interface LiveChain {
  unavailable: boolean;
  active: boolean;
  revoked: boolean;
  finalized: boolean;
  capabilities: Capability[];
  account: string;
  finalizedAccount: string;
  latestAccount: string;
  latestActive: boolean;
  rootId: string | null;
  node: Hex | null;
  expiresAt: string;
  rootOwned: boolean;
  failures: string[];
}
export type Shape = "draft" | "research" | "research-draft";
const draftNode = (dependsOn: string[] = []): WorkflowNode => ({
  id: "draft",
  type: "content.generate",
  blockVersion: "1.0.0",
  dependsOn,
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
});
const researchNode: WorkflowNode = {
  id: "research",
  type: "research.web",
  blockVersion: "1.0.0",
  dependsOn: [],
  input: { query: "ENS workflow agents" },
  capability: "web.search",
  timeoutMs: 1000,
  maxAttempts: 1,
};
const graphs: Record<Shape, WorkflowNode[]> = {
  draft: [draftNode()],
  research: [researchNode],
  "research-draft": [researchNode, draftNode(["research"])],
};

export function createAgentFixture(prefix: string) {
  const schema = `${prefix}_${Date.now()}`;
  const db = new Database(
    process.env.TEST_DATABASE_URL ??
      "postgresql://saikarthik@127.0.0.1:55432/humanos",
    { schema },
  );
  const store = new WorkflowStore(db),
    agentStore = new WorkflowAgentStore(db),
    registry = createDefaultCatalog();
  const rootId = ROOT_ID,
    sessionId = `session-${prefix}`;
  const actor = { accountId: `11155111:${OWNER}`, rootId, sessionId };
  const baseline = (): LiveChain => ({
    unavailable: false,
    active: true,
    revoked: false,
    finalized: true,
    capabilities: ["drafts.write", "web.search"],
    account: AGENT,
    finalizedAccount: AGENT,
    latestAccount: AGENT,
    latestActive: true,
    rootId: null,
    node: null,
    expiresAt: new Date(Date.now() + 86400000).toISOString(),
    rootOwned: true,
    failures: [],
  });
  const chain = baseline();
  const hooks: { beforeRead?: (name: string) => Promise<void> } = {};
  async function details(name: string): Promise<AgentAuthorizationDetails> {
    await hooks.beforeRead?.(name);
    if (chain.unavailable) throw new Error("ENS RPC unavailable");
    const snapshot = (account: string, active: boolean) => ({
      blockNumber: 100n,
      blockTimestamp: BigInt(Math.floor(Date.now() / 1000)),
      exists: true,
      active,
      revoked: chain.revoked,
      rootId: chain.rootId ?? rootId,
      account: account as Address,
      resolver: RESOLVER,
      rootNode: ensNamehash(`${rootId}.test-humanos.eth`),
      capabilities: 0n,
      expiry: BigInt(Math.floor(Date.parse(chain.expiresAt) / 1000)),
      failures: active ? [] : ["inactive"],
    });
    return {
      authorization: {
        agentEns: name,
        rootId: chain.rootId ?? rootId,
        capabilities: chain.active ? [...chain.capabilities] : [],
        active: chain.active,
        revoked: chain.revoked,
        expiresAt: chain.expiresAt,
        checkedAt: new Date().toISOString(),
        blockNumber: 100,
        finalized: chain.finalized,
      },
      node: chain.node ?? ensNamehash(name),
      account: chain.account as Address,
      resolver: RESOLVER,
      finalizedSnapshot: snapshot(chain.finalizedAccount, chain.active),
      latestSnapshot: snapshot(
        chain.latestAccount,
        chain.active && chain.latestActive,
      ),
      failures: [...chain.failures],
    };
  }
  const port = {
    review: vi.fn(async () => {
      throw new Error("NOT_USED");
    }),
    register: vi.fn(async () => {
      throw new Error("NOT_USED");
    }),
    readAuthorization: vi.fn(
      async (name: string) => (await details(name)).authorization,
    ),
    readAuthorizationDetails: vi.fn(details),
    checkRootOwner: vi.fn(async (root: string, owner: string) => {
      if (chain.unavailable) throw new Error("ENS RPC unavailable");
      return (
        chain.rootOwned && root === rootId && owner.toLowerCase() === OWNER
      );
    }),
    revoke: vi.fn(async () => {
      throw new Error("NOT_USED");
    }),
    writeReceipt: vi.fn(async (_binding: WorkflowEnsIdentity, _hash: Hex) => ({
      txHashes: [] as Hex[],
    })),
  };
  const ens = port as unknown as WorkflowEnsPort;
  const effects: string[] = [];
  const executors: Partial<Record<BlockType, WorkflowExecutor>> = {
    "content.generate": {
      async execute(ctx) {
        effects.push(`${ctx.run.id}:${ctx.node.id}`);
        return { output: { outputSchema: "text", text: `Draft for ${EMAIL}` } };
      },
    },
    "research.web": {
      async execute(ctx) {
        effects.push(`${ctx.run.id}:${ctx.node.id}`);
        const output = {
          sources: [
            {
              url: "https://example.com/ens",
              title: "ENS",
              excerpt: `Private note for ${EMAIL}`,
            },
          ],
        };
        const receipt: WorkflowReceipt = {
          id: randomUUID(),
          runId: ctx.run.id,
          stepRunId: ctx.step.id,
          executor: "connector",
          destination: EMAIL,
          summary: `Searched on behalf of ${EMAIL}`,
          requestHash: hashCanonical(ctx.input),
          outputHash: hashCanonical(output),
          executedAt: new Date().toISOString(),
          idempotencyKey: ctx.idempotencyKey,
          providerReference: null,
          finalUrl: null,
          successEvidence: null,
          metadata: {},
        };
        return { output, receipt };
      },
    },
  };
  const service = createWorkflowService({
    db,
    store,
    registry,
    selector: {
      select: async () => {
        throw new Error("NOT_USED");
      },
    },
    assemblyInput: async () => {
      throw new Error("NOT_USED");
    },
  });
  const session = () =>
    db.put("sessions", {
      id: sessionId,
      accountId: actor.accountId,
      rootId,
      expiresAt: new Date(Date.now() + 86400000).toISOString(),
    });

  async function init() {
    await db.migrate();
    const at = new Date().toISOString();
    await db.insert("accounts", {
      id: actor.accountId,
      address: OWNER,
      chainId: 11155111,
      createdAt: at,
    });
    await db.insert("roots", {
      id: rootId,
      ensName: null,
      createdAt: at,
      verificationEnvironment: "staging",
    });
    await db.transaction((tx) =>
      tx.bindRootAccount(rootId, actor.accountId, new Date()),
    );
    await session();
  }
  async function close() {
    await db.query(`DROP SCHEMA "${schema}" CASCADE`);
    await db.close();
  }
  async function reset() {
    Object.assign(chain, baseline());
    delete hooks.beforeRead;
    for (const mock of Object.values(port)) mock.mockClear();
    port.writeReceipt.mockReset();
    port.writeReceipt.mockImplementation(async () => ({
      txHashes: [] as Hex[],
    }));
    await session();
  }
  async function workflow(shape: Shape = "draft") {
    const id = randomUUID(),
      at = new Date().toISOString(),
      graph = { nodes: graphs[shape] };
    const version: WorkflowVersion = {
      id: randomUUID(),
      workflowId: id,
      version: 1,
      goal: "Research and draft",
      normalizedIntent: {},
      graph,
      graphHash: hashCanonical(graph),
      requiredCapabilities: shape === "draft" ? [] : ["web.search"],
      connectorRefs: [],
      browserFallbackAllowed: false,
      trigger: { kind: "manual" },
      assembler: {
        modelId: "fixture",
        modelVersion: "fixture",
        decisionHash: hashCanonical([]),
      },
      createdAt: at,
      activatedAt: null,
    };
    await store.createDraft(
      {
        id,
        accountId: actor.accountId,
        rootId,
        missionId: null,
        name: "Agent fixture",
        status: "DRAFT",
        latestVersionId: version.id,
        createdAt: at,
        updatedAt: at,
        archivedAt: null,
      },
      version,
    );
    const active = await store.activateVersion(
      id,
      version.id,
      version.graphHash,
    );
    return {
      id,
      version: active,
      workflow: (await store.get<Workflow>("workflows", id))!,
    };
  }
  async function bind(
    target: { id: string; version: WorkflowVersion },
    capabilities: Capability[] = ["drafts.write", "web.search"],
    state: "ACTIVE" | "PENDING_REGISTRATION" = "ACTIVE",
  ) {
    const at = new Date(Date.now() - 1000).toISOString();
    const reserved = await agentStore.reserve({
      accountId: actor.accountId,
      rootId,
      workflowId: target.id,
      versionId: target.version.id,
      graphHash: target.version.graphHash,
      capabilities,
      expiresAt: new Date(Date.now() + 86400000).toISOString(),
      state: "PENDING_REGISTRATION",
      createdAt: at,
      updatedAt: at,
    });
    if (state === "PENDING_REGISTRATION") return reserved;
    const ensName = `w${reserved.generation}-${target.id.slice(0, 8)}.${rootId}.test-humanos.eth`;
    return agentStore.transition(reserved.id, reserved.revision, "ACTIVE", {
      at: new Date(),
      registration: {
        ensName,
        node: ensNamehash(ensName),
        agentAddress: AGENT,
        txHashes: [],
      },
    });
  }
  const latest = async (binding: WorkflowAgentBinding) =>
    (await agentStore.get(binding.id))!;
  const revoke = async (binding: WorkflowAgentBinding) =>
    agentStore.transition(
      binding.id,
      (await latest(binding)).revision,
      "REVOKING",
      { at: new Date() },
    );
  const finishRevoke = async (binding: WorkflowAgentBinding) =>
    agentStore.transition(
      binding.id,
      (await latest(binding)).revision,
      "REVOKED",
      { at: new Date(), revocation: { txHashes: [] } },
    );
  const fail = async (binding: WorkflowAgentBinding) =>
    agentStore.transition(
      binding.id,
      (await latest(binding)).revision,
      "FAILED",
      { at: new Date() },
    );
  const start = async (workflowId: string) =>
    (await service.runNow(actor, workflowId, {}, `agent-${randomUUID()}`)).run;
  const run = (id: string) => store.get<WorkflowRun>("workflow_runs", id);
  const effectsFor = (runId: string) =>
    effects
      .filter((effect) => effect.startsWith(`${runId}:`))
      .map((effect) => effect.slice(runId.length + 1));
  function authorizer(
    options: { ens?: WorkflowEnsPort | null; clock?: () => Date } = {},
  ) {
    const agent = createWorkflowAgentAuthorizer({
      db,
      ens: options.ens === undefined ? ens : options.ens,
      capabilityFor: agentCapabilityFor(registry),
      ...(options.clock ? { clock: options.clock } : {}),
    });
    return {
      agent,
      authorize: composeWorkflowAuthorizers(
        createWorkflowAuthorizer(db, store, registry, new ConnectorRegistry()),
        agent,
      ),
    };
  }
  async function drain(options: { ens?: WorkflowEnsPort | null } = {}) {
    const runner = createWorkflowRunner({
      store,
      registry,
      workerId: "agent-fixture-worker",
      authorize: authorizer(options).authorize,
      executors,
      content: {
        generate: async () => {
          throw new Error("NOT_USED");
        },
      },
    });
    for (let i = 0; i < 64; i++) if (!(await runner.tick())) break;
  }
  async function contextFor(
    target: WorkflowRun,
  ): Promise<StepExecutionContext> {
    const version = (await store.get<WorkflowVersion>(
      "workflow_versions",
      target.workflowVersionId,
    ))!;
    const step = (await store.list<StepRun>("workflow_steps")).find(
      (s) => s.runId === target.id,
    )!;
    const node = version.graph.nodes.find((n) => n.id === step.blockId)!;
    return {
      actor: { accountId: actor.accountId, rootId },
      run: target,
      version,
      step,
      node,
      input: {},
      idempotencyKey: step.idempotencyKey,
      signal: new AbortController().signal,
    };
  }
  return {
    db,
    store,
    agentStore,
    registry,
    actor,
    rootId,
    chain,
    hooks,
    port,
    ens,
    service,
    init,
    close,
    reset,
    workflow,
    bind,
    revoke,
    finishRevoke,
    fail,
    start,
    run,
    effectsFor,
    authorizer,
    drain,
    contextFor,
  };
}
