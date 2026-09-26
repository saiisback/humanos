import { getAddress, type Hex } from "viem";
import type { AgentAuthorization, Capability } from "@humanos/schemas";
import type { AgentAuthorizationDetails } from "./authorize.js";
import type { HumanOSEnsAdapterOptions } from "./adapter.js";
import { agentLabelFor, rootLabelFor } from "./adapter.js";
import {
  createPrivateKeyBackend,
  deriveAgentPrivateKey,
  EnsWriteError,
} from "./register.js";
import { nodeOf } from "./resolve.js";

export const workflowDerivationId = (
  workflowId: string,
  generation: number,
): string => {
  if (!workflowId || !Number.isSafeInteger(generation) || generation < 1)
    throw new EnsWriteError("INVALID_INPUT", "invalid workflow generation");
  return `workflow:${workflowId}:${generation}`;
};

export interface WorkflowEnsIdentity {
  derivationId: string;
  rootId: string;
  ensName: string | null;
  node: string | null;
  agentAddress: string | null;
}
export interface WorkflowEnsPort {
  identity(
    input: Pick<WorkflowEnsIdentity, "derivationId" | "rootId">,
  ): Promise<{ ensName: string; node: Hex; agentAddress: string }>;
  review(input: {
    rootId: string;
    rootOwner: string;
    requestedExpiry: string;
  }): Promise<{ parentName: string; effectiveExpiry: string; chainId: number }>;
  register(input: {
    derivationId: string;
    rootId: string;
    rootOwner: string;
    capabilities: Capability[];
    expiresAt: string;
  }): Promise<{
    ensName: string;
    node: Hex;
    agentAddress: string;
    txHashes: Hex[];
  }>;
  readAuthorization(name: string): Promise<AgentAuthorization>;
  /** Controller and hierarchy evidence must accompany capability checks. */
  readAuthorizationDetails(name: string): Promise<AgentAuthorizationDetails>;
  checkRootOwner(rootId: string, owner: string): Promise<boolean>;
  revoke(binding: WorkflowEnsIdentity): Promise<{ txHashes: Hex[] }>;
  writeReceipt(
    binding: WorkflowEnsIdentity,
    receiptHash: Hex,
  ): Promise<{ txHashes: Hex[] }>;
}

/** Uses the same writer, nonce journal and signer as the legacy adapter. */
export function createWorkflowEnsPort(
  options: HumanOSEnsAdapterOptions,
): WorkflowEnsPort {
  const { writer, reader } = options;
  const backend = (id: string) =>
    createPrivateKeyBackend(
      deriveAgentPrivateKey(options.agentKeySeed, id),
      options.chain,
      options.transport,
    );
  const nameFor = async (id: string, rootId: string) =>
    `${agentLabelFor(id)}.${rootLabelFor(rootId)}.${await writer.getParentName()}`;
  const ownerAddress = (owner: string) => {
    try {
      const address = getAddress(owner);
      if (BigInt(address) === 0n) throw new Error();
      return address;
    } catch {
      throw new EnsWriteError("INVALID_INPUT", "invalid root owner");
    }
  };
  async function inspect(rootId: string, owner: string) {
    const address = ownerAddress(owner);
    const [bound, state, parentExpiry] = await Promise.all([
      writer.rootNodeOf(rootId),
      writer.rootState(rootLabelFor(rootId)),
      writer.parentExpiry(),
    ]);
    if (BigInt(bound) !== 0n || state.used) {
      if (
        bound !== state.node ||
        !state.live ||
        state.owner.toLowerCase() !== address.toLowerCase()
      )
        throw new EnsWriteError(
          "CONFLICT",
          "root identity is expired, revoked or owned by another owner",
        );
    }
    return {
      state,
      address,
      expiry:
        state.used && state.expiry < parentExpiry ? state.expiry : parentExpiry,
    };
  }
  async function review(input: {
    rootId: string;
    rootOwner: string;
    requestedExpiry: string;
  }) {
    if (![11155111, 31337].includes(options.chain.id))
      throw new EnsWriteError(
        "INVALID_INPUT",
        "workflow ENS requires Sepolia or local development chain",
      );
    const { expiry } = await inspect(input.rootId, input.rootOwner);
    const end = Math.min(
      Date.parse(input.requestedExpiry),
      Number(expiry) * 1000,
    );
    if (!Number.isFinite(end) || end <= Date.now())
      throw new EnsWriteError("CONFLICT", "expiry must be in the future");
    return {
      parentName: await writer.getParentName(),
      effectiveExpiry: new Date(Math.floor(end / 1000) * 1000).toISOString(),
      chainId: options.chain.id,
    };
  }
  async function checkedIdentity(binding: WorkflowEnsIdentity) {
    const ensName = await nameFor(binding.derivationId, binding.rootId);
    const agent = backend(binding.derivationId);
    if (
      binding.ensName !== ensName ||
      binding.node !== nodeOf(ensName) ||
      binding.agentAddress?.toLowerCase() !==
        agent.account.address.toLowerCase()
    )
      throw new EnsWriteError("CONFLICT", "workflow agent identity mismatch");
    return { ensName, agent };
  }
  return {
    async identity(input) {
      const ensName = await nameFor(input.derivationId, input.rootId);
      return {
        ensName,
        node: nodeOf(ensName),
        agentAddress: backend(input.derivationId).account.address,
      };
    },
    review,
    async register(input) {
      if (
        !/^workflow:.+:\d+$/.test(input.derivationId) ||
        !input.capabilities.length
      )
        throw new EnsWriteError(
          "INVALID_INPUT",
          "workflow identity and explicit capabilities required",
        );
      const reviewed = await review({
        rootId: input.rootId,
        rootOwner: input.rootOwner,
        requestedExpiry: input.expiresAt,
      });
      if (Date.parse(reviewed.effectiveExpiry) !== Date.parse(input.expiresAt))
        throw new EnsWriteError("CONFLICT", "expiry changed; review again");
      const { state, address } = await inspect(input.rootId, input.rootOwner);
      const txHashes: Hex[] = [];
      if (!state.used) {
        const root = await writer.registerRoot({
          label: rootLabelFor(input.rootId),
          rootId: input.rootId,
          owner: address,
          expiresAt: new Date(Number(await writer.parentExpiry()) * 1000),
        });
        if (root.hash) txHashes.push(root.hash);
      }
      const agent = backend(input.derivationId);
      const result = await writer.registerAgent({
        rootNode: state.node,
        rootLabel: rootLabelFor(input.rootId),
        label: agentLabelFor(input.derivationId),
        account: agent.account.address,
        capabilities: input.capabilities,
        expiresAt: new Date(input.expiresAt),
      });
      if (result.hash) txHashes.push(result.hash);
      if ((options.agentFundingWei ?? 0n) > 0n) {
        const funded = await writer.fundAccount(
          agent.account.address,
          options.agentFundingWei!,
        );
        if (funded.hash) txHashes.push(funded.hash);
      }
      return {
        ensName: await nameFor(input.derivationId, input.rootId),
        node: result.node,
        agentAddress: agent.account.address,
        txHashes,
      };
    },
    readAuthorization: (name) => reader.readAgentAuthorization(name),
    readAuthorizationDetails: (name) =>
      reader.readAgentAuthorizationDetails(name),
    async checkRootOwner(rootId, owner) {
      const { state } = await inspect(rootId, owner);
      return state.used && state.live;
    },
    async revoke(binding) {
      const { ensName } = await checkedIdentity(binding);
      const tx = await writer.revokeAgent(nodeOf(ensName));
      return { txHashes: tx.hash ? [tx.hash] : [] };
    },
    async writeReceipt(binding, receiptHash) {
      if (!/^0x[0-9a-fA-F]{64}$/.test(receiptHash))
        throw new EnsWriteError("INVALID_INPUT", "receipt must be a hash");
      const { ensName, agent } = await checkedIdentity(binding);
      const tx = await writer.writeAgentRecord({
        agent,
        name: ensName,
        key: "receipt",
        value: receiptHash,
      });
      return { txHashes: tx.hash ? [tx.hash] : [] };
    },
  };
}
