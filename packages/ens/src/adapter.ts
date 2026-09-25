import {
  http,
  keccak256,
  toHex,
  type Address,
  type Chain,
  type Transport,
} from "viem";
import type { AgentAuthorization, Mission } from "@humanos/schemas";
import {
  createAuthorizationReader,
  type AuthorizationReader,
} from "./authorize.js";
import { createEnsPublicClient, loadEnsEnvConfig } from "./config.js";
import {
  createEnsWriter,
  createPrivateKeyBackend,
  deriveAgentPrivateKey,
  EnsWriteError,
  type EnsWriter,
  type PrivateKeyBackend,
} from "./register.js";
import { nodeOf } from "./resolve.js";

/** Structural match for apps/api EnsAdapter. */
export interface EnsAdapter {
  register(mission: Mission): Promise<string>;
  revoke(mission: Mission): Promise<void>;
  readAuthorization(name: string): Promise<AgentAuthorization>;
}

/** Opaque, charset-safe labels derived from server IDs (IDs themselves may contain any characters). */
export const rootLabelFor = (rootId: string) =>
  `r${keccak256(toHex(rootId)).slice(2, 18)}`;
export const agentLabelFor = (missionId: string) =>
  `m${keccak256(toHex(missionId)).slice(2, 18)}`;

export interface HumanOSEnsAdapterOptions {
  reader: AuthorizationReader;
  writer: EnsWriter;
  operator: PrivateKeyBackend;
  agentKeySeed: `0x${string}`;
  chain: Chain;
  transport: Transport;
  /** Wei sent to a new agent account so it can pay for its own status/receipt writes. */
  agentFundingWei?: bigint;
  /** Owner recorded for root names; defaults to the operator (humans hold no wallets in the MVP). */
  rootOwner?: Address;
}

export function createHumanOSEnsAdapter(options: HumanOSEnsAdapterOptions) {
  const { reader, writer, operator } = options;

  const agentBackend = (missionId: string) =>
    createPrivateKeyBackend(
      deriveAgentPrivateKey(options.agentKeySeed, missionId),
      options.chain,
      options.transport,
    );

  async function agentNameFor(mission: Pick<Mission, "id" | "rootId">) {
    return `${agentLabelFor(mission.id)}.${rootLabelFor(mission.rootId)}.${await writer.getParentName()}`;
  }

  async function register(mission: Mission): Promise<string> {
    if (mission.approvedCapabilities.length === 0) {
      throw new EnsWriteError(
        "INVALID_INPUT",
        "mission has no human-approved capabilities",
      );
    }
    const rootLabel = rootLabelFor(mission.rootId);
    const rootOwner = options.rootOwner ?? operator.account.address;
    const [bound, state] = await Promise.all([
      writer.rootNodeOf(mission.rootId),
      writer.rootState(rootLabel),
    ]);
    if (bound === state.node) {
      // Reuse only a live root bound to this rootId and owner, at its actual expiry.
      if (
        !state.live ||
        state.owner.toLowerCase() !== rootOwner.toLowerCase()
      ) {
        throw new EnsWriteError(
          "CONFLICT",
          "root identity is revoked, expired or owned by another account",
        );
      }
    } else {
      await writer.registerRoot({
        label: rootLabel,
        rootId: mission.rootId,
        owner: rootOwner,
        expiresAt: new Date(Number(await writer.parentExpiry()) * 1000),
      });
    }
    const rootExpiryMs = Number(await writer.rootExpiry(rootLabel)) * 1000;
    const expiresAt = new Date(
      Math.min(Date.parse(mission.expiresAt), rootExpiryMs),
    );
    const agent = agentBackend(mission.id);
    await writer.registerAgent({
      rootNode: state.node,
      rootLabel,
      label: agentLabelFor(mission.id),
      account: agent.account.address,
      capabilities: mission.approvedCapabilities,
      expiresAt,
    });
    const funding = options.agentFundingWei ?? 0n;
    if (funding > 0n) await writer.fundAccount(agent.account.address, funding);
    return agentNameFor(mission);
  }

  async function revoke(mission: Mission): Promise<void> {
    const name = mission.agentEns ?? (await agentNameFor(mission));
    await writer.revokeAgent(nodeOf(name));
  }

  return {
    register,
    revoke,
    readAuthorization: (name: string) => reader.readAgentAuthorization(name),
    readAuthorizationDetails: (name: string) =>
      reader.readAgentAuthorizationDetails(name),
    agentNameFor,
    agentBackend,
    writeAgentRecord: (
      mission: Pick<Mission, "id" | "rootId">,
      key: "status" | "receipt",
      value: string,
    ) =>
      agentNameFor(mission).then((name) =>
        writer.writeAgentRecord({
          agent: agentBackend(mission.id),
          name,
          key,
          value,
        }),
      ),
  } satisfies EnsAdapter & Record<string, unknown>;
}

/**
 * Builds the Sepolia adapter from environment. Throws EnsConfigError (names only, no values)
 * when anything required is missing; callers should report the integration as unavailable.
 */
export function createEnsAdapterFromEnv(
  env: Record<string, string | undefined>,
) {
  const config = loadEnsEnvConfig(env, { requireWrites: true });
  const client = createEnsPublicClient(config);
  const transport = http(config.rpcUrl);
  const operator = createPrivateKeyBackend(
    config.operatorPrivateKey!,
    config.chain,
    transport,
  );
  const reader = createAuthorizationReader({
    client,
    chainId: config.chain.id,
    registrar: config.registrar,
    universalResolver: config.universalResolver,
  });
  const writer = createEnsWriter({
    client,
    registrar: config.registrar,
    operator,
    confirmations: config.confirmations,
  });
  return createHumanOSEnsAdapter({
    reader,
    writer,
    operator,
    agentKeySeed: config.agentKeySeed!,
    chain: config.chain,
    transport,
    agentFundingWei: config.agentFundingWei,
  });
}
