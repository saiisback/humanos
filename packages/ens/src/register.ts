import { createHmac } from "node:crypto";
import {
  BaseError,
  ContractFunctionRevertedError,
  createWalletClient,
  encodeFunctionData,
  isHex,
  keccak256,
  toHex,
  type Account,
  type Address,
  type Chain,
  type Hash,
  type Hex,
  type PublicClient,
  type Transport,
  type WalletClient,
} from "viem";
import { privateKeyToAccount } from "viem/accounts";
import type { Capability } from "@humanos/schemas";
import { humanosRegistrarAbi } from "./abi/humanosRegistrar.js";
import {
  permissionedRegistryAbi,
  permissionedResolverAbi,
} from "./abi/official.js";
import {
  encodeCapabilities,
  TEXT_KEYS,
  type AgentWritableKey,
} from "./roles.js";
import type { TransactionJournal } from "./transaction-journal.js";
import { dnsEncode, isValidLabel, nodeOf } from "./resolve.js";

export type EnsWriteErrorCode =
  | "INVALID_INPUT"
  | "CONFLICT"
  | "REVERTED"
  | "UNAVAILABLE";

export class EnsWriteError extends Error {
  override name = "EnsWriteError";
  constructor(
    readonly code: EnsWriteErrorCode,
    message: string,
    readonly revertName?: string,
    options?: { cause?: unknown },
  ) {
    super(message, options);
  }
}

/**
 * The only supported signing backend: a server-held secp256k1 private key. Errors never include
 * the key; callers must source it from secret configuration, never from clients.
 */
export interface PrivateKeyBackend {
  account: Account;
  wallet: WalletClient<Transport, Chain, Account>;
}

export function createPrivateKeyBackend(
  privateKey: string,
  chain: Chain,
  transport: Transport,
): PrivateKeyBackend {
  if (!isHex(privateKey) || privateKey.length !== 66) {
    throw new EnsWriteError(
      "INVALID_INPUT",
      "private key must be a 32-byte 0x-prefixed hex string",
    );
  }
  const account = privateKeyToAccount(privateKey);
  return { account, wallet: createWalletClient({ account, chain, transport }) };
}

/** Deterministic per-mission agent key: HMAC-SHA256(seed, "humanos-agent:v1:" + missionId). */
export function deriveAgentPrivateKey(seed: string, missionId: string): Hex {
  if (!isHex(seed) || seed.length !== 66)
    throw new EnsWriteError(
      "INVALID_INPUT",
      "agent key seed must be 32-byte hex",
    );
  const key = createHmac("sha256", Buffer.from(seed.slice(2), "hex"))
    .update(`humanos-agent:v1:${missionId}`)
    .digest("hex");
  return `0x${key}`;
}

export interface WriteResult {
  node: Hex;
  /** null when the call was an idempotent no-op (state already as requested). */
  hash: Hash | null;
  blockNumber: bigint | null;
}

export interface EnsWriterConfig {
  client: PublicClient;
  registrar: Address;
  operator: PrivateKeyBackend;
  /** Confirmations to await per transaction. */
  confirmations?: number;
  journal: TransactionJournal;
  /** Bounded confirmation wait; pending transactions remain journaled for retry. */
  receiptTimeoutMs?: number;
}

const toSeconds = (date: Date): bigint => {
  const ms = date.getTime();
  if (!Number.isFinite(ms))
    throw new EnsWriteError("INVALID_INPUT", "invalid expiry");
  return BigInt(Math.floor(ms / 1000));
};

function decodeRevert(error: unknown): EnsWriteError {
  if (error instanceof BaseError) {
    const reverted = error.walk(
      (e) => e instanceof ContractFunctionRevertedError,
    );
    if (reverted instanceof ContractFunctionRevertedError) {
      const revertName = reverted.data?.errorName;
      return new EnsWriteError(
        "REVERTED",
        `ENS transaction reverted: ${revertName ?? "unknown"}`,
        revertName,
        {
          cause: error,
        },
      );
    }
  }
  return new EnsWriteError(
    "UNAVAILABLE",
    "ENS transaction could not be submitted",
    undefined,
    { cause: error },
  );
}

export function createEnsWriter(config: EnsWriterConfig) {
  const { client, registrar, operator } = config;
  const confirmations = config.confirmations ?? 1;

  async function publish(
    backend: PrivateKeyBackend,
    operation: string,
    prepareIntent: () => Promise<{ to: Address; data?: Hex; value?: bigint }>,
  ): Promise<{ hash: Hash; blockNumber: bigint }> {
    if (!config.journal)
      throw new EnsWriteError(
        "UNAVAILABLE",
        "ENS transaction journal required",
      );
    const chainId = backend.wallet.chain.id;
    const entry = await config.journal.reserve(
      {
        operation: keccak256(
          toHex(
            `${chainId}:${backend.account.address.toLowerCase()}:${operation}`,
          ),
        ),
        chainId,
        signer: backend.account.address,
      },
      async (floor) => {
        const intent = await prepareIntent();
        const pending = await client.getTransactionCount({
          address: backend.account.address,
          blockTag: "pending",
        });
        const nonce = Math.max(pending, floor ?? 0);
        const prepared = await backend.wallet.prepareTransactionRequest({
          ...intent,
          nonce,
        });
        const raw = await backend.wallet.signTransaction(prepared);
        return { nonce, raw };
      },
    );
    if (entry.reverted)
      throw new EnsWriteError("REVERTED", `transaction ${entry.hash} reverted`);
    // Missing receipts and transport failures never permit signing another transaction.
    let receipt = await client
      .getTransactionReceipt({ hash: entry.hash })
      .catch(() => null);
    let broadcastError: unknown;
    if (!receipt) {
      try {
        const hash = await client.sendRawTransaction({
          serializedTransaction: entry.raw,
        });
        if (hash !== entry.hash)
          throw new Error("ENS_TRANSACTION_HASH_MISMATCH");
      } catch (error) {
        broadcastError = error;
        // Already-known / nonce-too-low may mean this identical transaction was mined.
        // Confirmation below is authoritative; any other broadcast failure remains pending.
      }
    }
    try {
      const confirmed =
        receipt &&
        (confirmations <= 1 ||
          (await client.getBlockNumber({ cacheTime: 0 })) >=
            receipt.blockNumber + BigInt(confirmations - 1));
      if (!confirmed)
        receipt = await client.waitForTransactionReceipt({
          hash: entry.hash,
          confirmations,
          timeout: config.receiptTimeoutMs ?? 60_000,
        });
    } catch (error) {
      throw new EnsWriteError(
        "UNAVAILABLE",
        `receipt for ${entry.hash} unavailable`,
        undefined,
        { cause: broadcastError ?? error },
      );
    }
    if (!receipt)
      throw new EnsWriteError(
        "UNAVAILABLE",
        `receipt for ${entry.hash} unavailable`,
      );
    if (receipt.status !== "success") {
      await config.journal.markReverted(entry.hash);
      throw new EnsWriteError("REVERTED", `transaction ${entry.hash} reverted`);
    }
    return { hash: entry.hash, blockNumber: receipt.blockNumber };
  }

  function send(
    backend: PrivateKeyBackend,
    request: Parameters<PublicClient["simulateContract"]>[0],
  ): Promise<{ hash: Hash; blockNumber: bigint }> {
    const data = encodeFunctionData(
      request as Parameters<typeof encodeFunctionData>[0],
    );
    return publish(
      backend,
      `${request.address.toLowerCase()}:${data}`,
      async () => {
        try {
          await client.simulateContract({
            ...request,
            account: backend.account,
          });
        } catch (error) {
          throw decodeRevert(error);
        }
        return { to: request.address, data };
      },
    );
  }

  const registrarCall = (functionName: string, args: readonly unknown[]) =>
    send(operator, {
      address: registrar,
      abi: humanosRegistrarAbi,
      functionName,
      args,
    } as never);

  const read = <T>(functionName: string, args: readonly unknown[] = []) =>
    client.readContract({
      address: registrar,
      abi: humanosRegistrarAbi,
      functionName,
      args,
    } as never) as Promise<T>;

  let parentName: string | undefined;
  const getParentName = async () =>
    (parentName ??= await read<string>("parentName"));

  const agentAuthorization = (node: Hex) =>
    read<{
      exists: boolean;
      active: boolean;
      revoked: boolean;
      rootNode: Hex;
      account: Address;
      resolver: Address;
      capabilities: bigint;
      expiry: bigint | number;
      agentExpiry: bigint | number;
      rootExpiry: bigint | number;
      parentExpiry: bigint | number;
      name: string;
    }>("authorization", [node]);

  const labelId = (label: string) => BigInt(keccak256(toHex(label)));
  const sameAddress = (a: Address, b: Address) =>
    a.toLowerCase() === b.toLowerCase();
  const noop = (node: Hex): WriteResult => ({
    node,
    hash: null,
    blockNumber: null,
  });

  /** Live state of `<label>.<parent>` read from the official HumanOS registry. */
  async function rootState(label: string) {
    const node = nodeOf(`${label}.${await getParentName()}`);
    const registry = await read<Address>("HUMANOS_REGISTRY");
    const [used, revoked, owner, expiry, head] = await Promise.all([
      read<boolean>("nodeUsed", [node]),
      read<boolean>("isRootRevoked", [node]),
      client.readContract({
        address: registry,
        abi: permissionedRegistryAbi,
        functionName: "getOwner",
        args: [labelId(label)],
      }),
      client.readContract({
        address: registry,
        abi: permissionedRegistryAbi,
        functionName: "getExpiry",
        args: [labelId(label)],
      }),
      client.getBlock({ blockTag: "latest" }),
    ]);
    const [parentRegistry, parentLabel, expectedRootRegistry] =
      await Promise.all([
        read<Address>("PARENT_REGISTRY"),
        read<string>("parentLabel"),
        read<Address>("rootRegistry", [node]),
      ]);
    const [parentExpiry, parentLink, rootLink] = await Promise.all([
      client.readContract({
        address: parentRegistry,
        abi: permissionedRegistryAbi,
        functionName: "getExpiry",
        args: [labelId(parentLabel)],
      }),
      client.readContract({
        address: parentRegistry,
        abi: permissionedRegistryAbi,
        functionName: "getSubregistry",
        args: [parentLabel],
      }),
      client.readContract({
        address: registry,
        abi: permissionedRegistryAbi,
        functionName: "getSubregistry",
        args: [label],
      }),
    ]);
    const live =
      head.timestamp < parentExpiry &&
      sameAddress(parentLink, registry) &&
      sameAddress(rootLink, expectedRootRegistry) &&
      used &&
      !revoked &&
      BigInt(owner) !== 0n &&
      head.timestamp < BigInt(expiry);
    return { node, used, revoked, owner, expiry: BigInt(expiry), live };
  }

  return {
    getParentName,
    agentAuthorization,
    rootState,

    async parentExpiry(): Promise<bigint> {
      const parentRegistry = await read<Address>("PARENT_REGISTRY");
      const label = await read<string>("parentLabel");
      return client.readContract({
        address: parentRegistry,
        abi: permissionedRegistryAbi,
        functionName: "getExpiry",
        args: [labelId(label)],
      });
    },

    rootNodeOf: (rootId: string) =>
      read<Hex>("rootNodeOf", [keccak256(toHex(rootId))]),

    async rootExpiry(rootLabel: string): Promise<bigint> {
      return (await rootState(rootLabel)).expiry;
    },

    /**
     * Idempotent only for an exact match: same rootId bound to this label, live, same owner and
     * same expiry. Anything else already bound is a CONFLICT, never a silent success.
     */
    async registerRoot(input: {
      label: string;
      rootId: string;
      owner: Address;
      expiresAt: Date;
    }): Promise<WriteResult> {
      if (!isValidLabel(input.label))
        throw new EnsWriteError("INVALID_INPUT", "invalid root label");
      const requested = toSeconds(input.expiresAt);
      const rootIdHash = keccak256(toHex(input.rootId));
      const inspect = async () => {
        const [bound, state] = await Promise.all([
          read<Hex>("rootNodeOf", [rootIdHash]),
          rootState(input.label),
        ]);
        const exact =
          bound === state.node &&
          state.live &&
          sameAddress(state.owner, input.owner) &&
          state.expiry === requested;
        return { bound, state, exact };
      };
      const before = await inspect();
      if (before.exact) return noop(before.state.node);
      if (BigInt(before.bound) !== 0n || before.state.used) {
        throw new EnsWriteError(
          "CONFLICT",
          "root id or label already bound (different parameters, revoked or expired)",
        );
      }
      try {
        const tx = await registrarCall("registerRoot", [
          input.label,
          input.rootId,
          input.owner,
          requested,
        ]);
        return { node: before.state.node, ...tx };
      } catch (error) {
        // A concurrent identical registration may have won the race.
        if ((await inspect()).exact) return noop(before.state.node);
        throw error;
      }
    },

    /**
     * Idempotent only for an exact match: live, unrevoked, same root, name, account, capability
     * bitmap and agent expiry. The same predicate guards the fast path and the failure path.
     */
    async registerAgent(input: {
      rootNode: Hex;
      rootLabel: string;
      label: string;
      account: Address;
      capabilities: readonly Capability[];
      expiresAt: Date;
    }): Promise<WriteResult> {
      if (!isValidLabel(input.label) || !isValidLabel(input.rootLabel))
        throw new EnsWriteError("INVALID_INPUT", "invalid agent or root label");
      const parent = await getParentName();
      if (nodeOf(`${input.rootLabel}.${parent}`) !== input.rootNode)
        throw new EnsWriteError(
          "INVALID_INPUT",
          "rootLabel does not match rootNode",
        );
      const bitmap = encodeCapabilities(input.capabilities);
      if (bitmap === 0n)
        throw new EnsWriteError(
          "INVALID_INPUT",
          "agent needs at least one capability",
        );
      const requested = toSeconds(input.expiresAt);
      const name = `${input.label}.${input.rootLabel}.${parent}`;
      const node = nodeOf(name);
      const exact = (a: Awaited<ReturnType<typeof agentAuthorization>>) =>
        a.exists &&
        a.active &&
        !a.revoked &&
        a.rootNode === input.rootNode &&
        a.name === name &&
        sameAddress(a.account, input.account) &&
        a.capabilities === bitmap &&
        BigInt(a.agentExpiry) === requested;
      const current = await agentAuthorization(node);
      if (exact(current)) return noop(node);
      if (current.exists)
        throw new EnsWriteError(
          "CONFLICT",
          "agent label already used (different parameters, revoked or expired)",
        );
      try {
        const tx = await registrarCall("registerAgent", [
          input.rootNode,
          input.label,
          input.account,
          bitmap,
          requested,
        ]);
        return { node, ...tx };
      } catch (error) {
        if (exact(await agentAuthorization(node))) return noop(node);
        throw error;
      }
    },

    /** A one-time initial funding intent per target and account, durable across retries. */
    async fundAccount(
      account: Address,
      minBalance: bigint,
    ): Promise<{ hash: Hash | null; blockNumber: bigint | null }> {
      try {
        return await publish(
          operator,
          `initial-funding:${account.toLowerCase()}:${minBalance}`,
          async () => {
            // This callback runs inside the durable per-signer lock, before signing.
            const balance = await client.getBalance({ address: account });
            if (balance >= minBalance)
              throw new Error("ENS_FUNDING_NOT_NEEDED");
            return { to: account, value: minBalance - balance };
          },
        );
      } catch (error) {
        if (
          error instanceof Error &&
          error.message === "ENS_FUNDING_NOT_NEEDED"
        )
          return { hash: null, blockNumber: null };
        throw error;
      }
    },

    async renewRoot(rootNode: Hex, expiresAt: Date): Promise<WriteResult> {
      return {
        node: rootNode,
        ...(await registrarCall("renewRoot", [rootNode, toSeconds(expiresAt)])),
      };
    },

    async renewAgent(agentNode: Hex, expiresAt: Date): Promise<WriteResult> {
      return {
        node: agentNode,
        ...(await registrarCall("renewAgent", [
          agentNode,
          toSeconds(expiresAt),
        ])),
      };
    },

    async narrowAgentCapabilities(
      agentNode: Hex,
      capabilities: readonly Capability[],
    ): Promise<WriteResult> {
      const bitmap = encodeCapabilities(capabilities);
      const current = await agentAuthorization(agentNode);
      if (current.exists && current.capabilities === bitmap)
        return { node: agentNode, hash: null, blockNumber: null };
      return {
        node: agentNode,
        ...(await registrarCall("narrowAgentCapabilities", [
          agentNode,
          bitmap,
        ])),
      };
    },

    /** Idempotent: revoking an already revoked agent is a no-op. */
    async revokeAgent(agentNode: Hex): Promise<WriteResult> {
      const current = await agentAuthorization(agentNode);
      if (!current.exists)
        throw new EnsWriteError("INVALID_INPUT", "unknown agent");
      if (current.revoked)
        return { node: agentNode, hash: null, blockNumber: null };
      try {
        return {
          node: agentNode,
          ...(await registrarCall("revokeAgent", [agentNode])),
        };
      } catch (error) {
        // A concurrent revocation (root cascade or retry) may win the race: that is success.
        if ((await agentAuthorization(agentNode)).revoked)
          return { node: agentNode, hash: null, blockNumber: null };
        throw error;
      }
    },

    async revokeRoot(rootNode: Hex): Promise<WriteResult> {
      if (await read<boolean>("isRootRevoked", [rootNode]))
        return { node: rootNode, hash: null, blockNumber: null };
      return {
        node: rootNode,
        ...(await registrarCall("revokeRoot", [rootNode])),
      };
    },

    /**
     * Writes the agent's own status/receipt record, signed by the agent key. The official resolver
     * enforces the argument-scoped grant; any other key or a revoked agent reverts.
     */
    async writeAgentRecord(input: {
      agent: PrivateKeyBackend;
      name: string;
      key: AgentWritableKey;
      value: string;
    }): Promise<WriteResult> {
      const node = nodeOf(input.name);
      const current = await agentAuthorization(node);
      if (!current.exists)
        throw new EnsWriteError("INVALID_INPUT", "unknown agent");
      const tx = await send(input.agent, {
        address: current.resolver,
        abi: permissionedResolverAbi,
        functionName: "setText",
        args: [dnsEncode(input.name), TEXT_KEYS[input.key], input.value],
      } as never);
      return { node, ...tx };
    },
  };
}

export type EnsWriter = ReturnType<typeof createEnsWriter>;
