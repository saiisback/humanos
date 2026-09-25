import * as v from "valibot";
import {
  AgentAuthorizationSchema,
  type AgentAuthorization,
  type Capability,
} from "@humanos/schemas";
import {
  keccak256,
  toHex,
  type Address,
  type Hex,
  type PublicClient,
} from "viem";
import { humanosRegistrarAbi } from "./abi/humanosRegistrar.js";
import { permissionedResolverAbi } from "./abi/official.js";
import {
  capabilitiesRecordValue,
  decodeCapabilities,
  RESOLVER_ROLES,
  TEXT_KEYS,
} from "./roles.js";
import { findResolver, nodeOf, parseAgentName, readText } from "./resolve.js";

export type EnsAuthorizationErrorCode =
  | "INVALID_NAME"
  | "NOT_FOUND"
  | "UNAVAILABLE"
  | "WRONG_CHAIN";

export class EnsAuthorizationError extends Error {
  override name = "EnsAuthorizationError";
  constructor(
    readonly code: EnsAuthorizationErrorCode,
    message: string,
    options?: { cause?: unknown },
  ) {
    super(message, options);
  }
}

export interface AuthorizationReaderConfig {
  client: PublicClient;
  chainId: number;
  /** HumanOSRegistrar address. */
  registrar: Address;
  /** Official Universal Resolver (the canonical proxy on Sepolia). */
  universalResolver: Address;
  now?: () => Date;
  /** Oldest acceptable latest-head timestamp relative to `now` (default 60s, ~5 Sepolia slots). */
  maxLatestHeadAgeMs?: number;
  /** Largest acceptable latest-head timestamp ahead of `now` (default 15s). */
  maxLatestHeadFutureSkewMs?: number;
  /** Attempts when the latest head moves during a read (default 3). */
  maxHeadMoveRetries?: number;
}

/** One consistent view of the chain: every call is pinned to the same block number. */
export interface AuthorizationSnapshot {
  blockNumber: bigint;
  blockTimestamp: bigint;
  exists: boolean;
  /** Registrar says active AND the official hierarchy, records and EAC grants independently agree. */
  active: boolean;
  revoked: boolean;
  rootId: string;
  account: Address;
  resolver: Address;
  rootNode: Hex;
  capabilities: bigint;
  expiry: bigint;
  /** Human-readable reasons the snapshot is not active; empty when active. */
  failures: string[];
}

export interface AgentAuthorizationDetails {
  authorization: AgentAuthorization;
  node: Hex;
  account: Address;
  resolver: Address;
  finalizedSnapshot: AuthorizationSnapshot;
  latestSnapshot: AuthorizationSnapshot;
  /** Reasons, beyond the snapshots, that forced the result inactive (e.g. stale head). */
  failures: string[];
}

const ZERO_ADDRESS = "0x0000000000000000000000000000000000000000";
const ZERO_HASH =
  "0x0000000000000000000000000000000000000000000000000000000000000000";
const STATUS_RESOURCE = BigInt(keccak256(toHex(TEXT_KEYS.status)));
const RECEIPT_RESOURCE = BigInt(keccak256(toHex(TEXT_KEYS.receipt)));

const intersect = (a: Capability[], b: Capability[]) =>
  a.filter((c) => b.includes(c));

export function createAuthorizationReader(config: AuthorizationReaderConfig) {
  const now = config.now ?? (() => new Date());
  const maxAge = config.maxLatestHeadAgeMs ?? 60_000;
  const maxFuture = config.maxLatestHeadFutureSkewMs ?? 15_000;
  const attempts = config.maxHeadMoveRetries ?? 3;
  if (
    !Number.isFinite(maxAge) ||
    maxAge < 0 ||
    !Number.isFinite(maxFuture) ||
    maxFuture < 0 ||
    !Number.isInteger(attempts) ||
    attempts < 1 ||
    attempts > 5
  )
    throw new EnsAuthorizationError(
      "UNAVAILABLE",
      "Invalid authorization freshness configuration",
    );
  let parentName: string | undefined;
  let chainChecked = false;

  async function guard<T>(what: string, fn: () => Promise<T>): Promise<T> {
    try {
      return await fn();
    } catch (error) {
      if (error instanceof EnsAuthorizationError) throw error;
      throw new EnsAuthorizationError("UNAVAILABLE", `ENS ${what} failed`, {
        cause: error,
      });
    }
  }

  async function ensureChain() {
    if (chainChecked) return;
    const chainId = await guard("chain id read", () =>
      config.client.getChainId(),
    );
    if (chainId !== config.chainId) {
      throw new EnsAuthorizationError(
        "WRONG_CHAIN",
        `expected chain ${config.chainId}, RPC reports ${chainId}`,
      );
    }
    chainChecked = true;
  }

  async function getParentName(): Promise<string> {
    parentName ??= await guard("registrar read", () =>
      config.client.readContract({
        address: config.registrar,
        abi: humanosRegistrarAbi,
        functionName: "parentName",
      }),
    );
    return parentName;
  }

  const hasTextGrant = (
    resolver: Address,
    resource: bigint,
    account: Address,
    blockNumber: bigint,
  ) =>
    config.client.readContract({
      address: resolver,
      abi: permissionedResolverAbi,
      functionName: "hasRoles",
      args: [resource, RESOLVER_ROLES.SET_TEXT, account],
      blockNumber,
    });

  async function snapshot(
    name: string,
    node: Hex,
    blockNumber: bigint,
    blockTimestamp: bigint,
  ): Promise<AuthorizationSnapshot> {
    const code = await config.client.getCode({
      address: config.registrar,
      blockNumber,
    });
    if (!code || code === "0x") {
      // Registrar not deployed yet at this block: nothing can be authorized there.
      return {
        blockNumber,
        blockTimestamp,
        exists: false,
        active: false,
        revoked: false,
        rootId: "",
        account: ZERO_ADDRESS,
        resolver: ZERO_ADDRESS,
        rootNode: ZERO_HASH,
        capabilities: 0n,
        expiry: 0n,
        failures: ["registrar not deployed at block"],
      };
    }
    const a = await config.client.readContract({
      address: config.registrar,
      abi: humanosRegistrarAbi,
      functionName: "authorization",
      args: [node],
      blockNumber,
    });
    const base: AuthorizationSnapshot = {
      blockNumber,
      blockTimestamp,
      exists: a.exists,
      active: false,
      revoked: a.revoked,
      rootId: a.rootId,
      account: a.account,
      resolver: a.resolver,
      rootNode: a.rootNode,
      capabilities: a.capabilities,
      expiry: BigInt(a.expiry),
      failures: [],
    };
    if (!a.exists) return { ...base, failures: ["agent not registered"] };
    const failures: string[] = [];
    if (a.name !== name) failures.push("registrar name mismatch");
    if (a.revoked) failures.push("revoked");
    if (!a.active)
      failures.push(
        "registrar reports inactive (expired, revoked, or detached hierarchy)",
      );
    if (blockTimestamp >= BigInt(a.expiry))
      failures.push("expired at snapshot block");
    if (a.active) {
      // Independently confirm the official resolution path, records and EAC grants at the same block.
      const [found, capabilitiesText, rootText, statusGrant, receiptGrant] =
        await Promise.all([
          findResolver(
            config.client,
            config.universalResolver,
            name,
            blockNumber,
          ),
          readText(
            config.client,
            a.resolver,
            name,
            TEXT_KEYS.capabilities,
            blockNumber,
          ),
          readText(
            config.client,
            a.resolver,
            name,
            TEXT_KEYS.root,
            blockNumber,
          ),
          hasTextGrant(a.resolver, STATUS_RESOURCE, a.account, blockNumber),
          hasTextGrant(a.resolver, RECEIPT_RESOURCE, a.account, blockNumber),
        ]);
      if (
        found.resolver.toLowerCase() !== a.resolver.toLowerCase() ||
        found.offset !== 0n
      ) {
        failures.push(
          "universal resolver does not resolve the agent to its resolver",
        );
      }
      if (capabilitiesText !== capabilitiesRecordValue(a.capabilities))
        failures.push("capabilities record mismatch");
      if (rootText !== a.rootId) failures.push("root record mismatch");
      if (!statusGrant || !receiptGrant)
        failures.push("agent status/receipt EAC grant missing");
    }
    return { ...base, active: failures.length === 0, failures };
  }

  /** Pinned heads plus both snapshots; retried while the latest head moves underneath the read. */
  async function consistentRead(name: string, node: Hex) {
    for (let attempt = 1; ; attempt++) {
      const [finalizedBlock, latestBlock] = await guard("block read", () =>
        Promise.all([
          config.client.getBlock({ blockTag: "finalized" }),
          config.client.getBlock({ blockTag: "latest" }),
        ]),
      );
      const [fin, lat] = await guard("authorization read", () =>
        Promise.all([
          snapshot(name, node, finalizedBlock.number, finalizedBlock.timestamp),
          snapshot(name, node, latestBlock.number, latestBlock.timestamp),
        ]),
      );
      const head = await guard("block read", () =>
        config.client.getBlock({ blockTag: "latest" }),
      );
      if (
        head.number === latestBlock.number &&
        head.hash === latestBlock.hash
      ) {
        return { finalizedBlock, latestBlock, fin, lat };
      }
      if (attempt >= attempts) {
        throw new EnsAuthorizationError(
          "UNAVAILABLE",
          "chain head kept moving during the authorization read",
        );
      }
    }
  }

  /**
   * Reads authorization from two pinned snapshots and narrows them (fail closed):
   *  - `finalized` block: grants only count once they cannot be reorged away;
   *  - `latest` block: revocations, expiries and narrowing take effect immediately.
   * The latest head must be unchanged after the reads and fresh relative to `now`. `active`
   * requires both snapshots active and the local clock before expiry. `finalized` is true only
   * when the latest snapshot equals the finalized one, i.e. nothing is pending.
   */
  async function readAgentAuthorizationDetails(
    name: string,
  ): Promise<AgentAuthorizationDetails> {
    await ensureChain();
    const parent = await getParentName();
    try {
      parseAgentName(name, parent);
    } catch (error) {
      throw new EnsAuthorizationError("INVALID_NAME", (error as Error).message);
    }
    const node = nodeOf(name);
    const { finalizedBlock, latestBlock, fin, lat } = await consistentRead(
      name,
      node,
    );
    if (!fin.exists && !lat.exists)
      throw new EnsAuthorizationError("NOT_FOUND", `no HumanOS agent ${name}`);

    const checkedAt = now();
    const failures: string[] = [];
    const headMs = Number(latestBlock.timestamp) * 1000;
    if (checkedAt.getTime() - headMs > maxAge)
      failures.push("latest head is stale");
    if (headMs - checkedAt.getTime() > maxFuture)
      failures.push("latest head is in the future");

    const source = lat.exists ? lat : fin;
    const expiry = [fin, lat]
      .filter((s) => s.exists)
      .map((s) => s.expiry)
      .reduce((m, e) => (e < m ? e : m));
    const expiresAt = new Date(Number(expiry) * 1000);
    if (checkedAt.getTime() >= expiresAt.getTime())
      failures.push("expired by local clock");
    const capabilities =
      fin.exists && lat.exists
        ? intersect(
            decodeCapabilities(fin.capabilities),
            decodeCapabilities(lat.capabilities),
          )
        : [];
    const sameState =
      fin.exists &&
      lat.exists &&
      fin.active === lat.active &&
      fin.revoked === lat.revoked &&
      fin.capabilities === lat.capabilities &&
      fin.expiry === lat.expiry &&
      fin.account === lat.account &&
      fin.resolver === lat.resolver;
    const active = fin.active && lat.active && failures.length === 0;

    const authorization = v.parse(AgentAuthorizationSchema, {
      agentEns: name,
      rootId: source.rootId,
      capabilities: active ? capabilities : [],
      active,
      revoked: fin.revoked || lat.revoked,
      expiresAt: expiresAt.toISOString(),
      checkedAt: checkedAt.toISOString(),
      blockNumber: Number(finalizedBlock.number),
      finalized: sameState,
    });
    return {
      authorization,
      node,
      account: source.account,
      resolver: source.resolver,
      finalizedSnapshot: fin,
      latestSnapshot: lat,
      failures,
    };
  }

  return {
    readAgentAuthorizationDetails,
    readAgentAuthorization: async (name: string): Promise<AgentAuthorization> =>
      (await readAgentAuthorizationDetails(name)).authorization,
    getParentName,
  };
}

export type AuthorizationReader = ReturnType<typeof createAuthorizationReader>;
