import { afterAll, beforeAll, describe, expect, it } from "vitest";
import * as v from "valibot";
import {
  createPublicClient,
  custom,
  decodeFunctionResult,
  encodeFunctionData,
  getAddress,
  http,
  keccak256,
  parseAbi,
  toHex,
  type Address,
  type EIP1193RequestFn,
  type PublicClient,
} from "viem";
import { foundry } from "viem/chains";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import {
  AgentAuthorizationSchema,
  type Capability,
  type Mission,
} from "@humanos/schemas";
import {
  humanosRegistrarAbi,
  CAPABILITY_ORDER,
  createAuthorizationReader,
  createEnsWriter,
  createHumanOSEnsAdapter,
  createPrivateKeyBackend,
  dnsEncode,
  EnsAuthorizationError,
  EnsWriteError,
  findResolver,
  nodeOf,
  readText,
  rootLabelFor,
  REGISTRY_ROLES,
  RESOLVER_ROLES,
  adminRole,
  TEXT_KEYS,
  type AuthorizationReader,
  type EnsWriter,
} from "../src/index.js";
import {
  permissionedRegistryAbi,
  permissionedResolverAbi,
} from "../src/abi/official.js";
import {
  ANVIL_KEY_0,
  startLocalEnsv2,
  type LocalDeployment,
} from "./helpers/anvil.js";

import { createMemoryJournal } from "./helpers/memory-journal.js";

const DAY = 86_400;
let env: LocalDeployment;
let client: PublicClient;
let reader: AuthorizationReader;
let writer: EnsWriter;
let adapter: ReturnType<typeof createHumanOSEnsAdapter>;
let chainNow: () => Promise<number>;
const jawOwner = privateKeyToAccount(generatePrivateKey()).address;
let operatorAddress: Address;

const rpc = (method: string, params: unknown[] = []) =>
  client.request({ method: method as never, params: params as never });
/** Keeps the reader's clock aligned with the chain head (anvil advances time per mined block). */
async function syncClock() {
  const head = await client.getBlock({ blockTag: "latest" });
  clockSkewMs = Number(head.timestamp) * 1000 - Date.now();
}
const mine = async (blocks: number) => {
  await rpc("anvil_mine", [toHex(blocks)]);
  await syncClock();
};
/** Anvil reports finalized = latest - 64. */
const finalize = () => mine(65);
const increaseTime = (seconds: number) =>
  rpc("evm_increaseTime", [toHex(seconds)]);

function mission(
  id: string,
  rootId: string,
  caps: Capability[],
  expiresInSeconds: number,
  nowSec: number,
): Mission {
  const iso = (s: number) => new Date(s * 1000).toISOString();
  return {
    id,
    rootId,
    agentEns: null,
    title: "ETHGlobal Tokyo application",
    goal: "Prepare and submit the application",
    capabilities: caps,
    approvedCapabilities: caps,
    steps: ["draft", "submit"],
    state: "AUTHORIZED",
    expiresAt: iso(nowSec + expiresInSeconds),
    createdAt: iso(nowSec),
    updatedAt: iso(nowSec),
    policyVersion: "policy-v1",
  };
}

beforeAll(async () => {
  const now = Math.floor(Date.now() / 1000);
  env = await startLocalEnsv2(BigInt(now + 2 * 365 * DAY));
  const transport = http(env.rpcUrl);
  client = createPublicClient({
    chain: foundry,
    transport,
    pollingInterval: 50,
  }) as PublicClient;
  chainNow = async () =>
    Number((await client.getBlock({ blockTag: "latest" })).timestamp);
  const operator = createPrivateKeyBackend(ANVIL_KEY_0, foundry, transport);
  operatorAddress = operator.account.address;
  reader = createAuthorizationReader({
    client,
    chainId: foundry.id,
    registrar: env.registrar,
    universalResolver: env.universalResolver,
    // The chain clock moves with evm_increaseTime; keep the reader's clock on chain time.
    now: () => new Date(Date.now() + clockSkewMs),
  });
  writer = createEnsWriter({
    client,
    registrar: env.registrar,
    operator,
    journal: createMemoryJournal(),
    receiptTimeoutMs: 2000,
  });
  adapter = createHumanOSEnsAdapter({
    reader,
    writer,
    agentKeySeed: generatePrivateKey(),
    chain: foundry,
    transport,
    agentFundingWei: 10n ** 16n,
  });
}, 600_000);

afterAll(() => env?.stop());

let clockSkewMs = 0;
async function advance(seconds: number) {
  await increaseTime(seconds);
  await mine(1);
}

async function registeredAndFinalized(
  id: string,
  caps: Capability[] = ["drafts.write", "calendar.create"],
) {
  const m = mission(id, `root-${id}`, caps, 7 * DAY, await chainNow());
  const name = await adapter.register(m, jawOwner);
  await finalize();
  return { m, name };
}

describe("readAgentAuthorization against official ENSv2 contracts", () => {
  it("does not authorize a fresh registration until it is finalized", async () => {
    const m = mission(
      "mission-fresh",
      "root_fresh",
      ["drafts.write", "application.submit"],
      7 * DAY,
      await chainNow(),
    );
    const name = await adapter.register(m, jawOwner);
    expect(name).toMatch(/^m[0-9a-f]{16}\.r[0-9a-f]{16}\.humanos\.eth$/);
    expect(jawOwner).not.toBe(operatorAddress);
    const rootLabel = name.split(".")[1]!;
    const rootName = name.slice(name.indexOf(".") + 1);
    expect(
      await client.readContract({
        address: env.humanosRegistry,
        abi: permissionedRegistryAbi,
        functionName: "getOwner",
        args: [BigInt(keccak256(toHex(rootLabel)))],
      }),
    ).toBe(jawOwner);
    const { resolver: rootResolver } = await findResolver(
      client,
      env.universalResolver,
      rootName,
      await client.getBlockNumber(),
    );
    const addressRecord = await client.readContract({
      address: rootResolver,
      abi: permissionedResolverAbi,
      functionName: "resolve",
      args: [
        dnsEncode(rootName),
        encodeFunctionData({
          abi: parseAbi(["function addr(bytes32 node) view returns (address)"]),
          functionName: "addr",
          args: [nodeOf(rootName)],
        }),
      ],
    });
    expect(
      decodeFunctionResult({
        abi: parseAbi(["function addr(bytes32 node) view returns (address)"]),
        functionName: "addr",
        data: addressRecord,
      }),
    ).toBe(jawOwner);
    const registryRolesAbi = parseAbi([
      "function roles(uint256 resource, address account) view returns (uint256)",
    ]);
    expect(
      await client.readContract({
        address: env.humanosRegistry,
        abi: registryRolesAbi,
        functionName: "roles",
        args: [0n, jawOwner],
      }),
    ).toBe(0n);
    expect(
      await client.readContract({
        address: env.humanosRegistry,
        abi: registryRolesAbi,
        functionName: "roles",
        args: [0n, env.registrar],
      }),
    ).toBe(
      REGISTRY_ROLES.REGISTRAR |
        REGISTRY_ROLES.RENEW |
        REGISTRY_ROLES.UNREGISTER,
    );
    expect(
      await client.readContract({
        address: rootResolver,
        abi: permissionedResolverAbi,
        functionName: "roles",
        args: [0n, jawOwner],
      }),
    ).toBe(0n);
    expect(
      await client.readContract({
        address: rootResolver,
        abi: permissionedResolverAbi,
        functionName: "roles",
        args: [0n, env.registrar],
      }),
    ).toBe(
      RESOLVER_ROLES.SET_TEXT |
        adminRole(RESOLVER_ROLES.SET_TEXT) |
        RESOLVER_ROLES.SET_ADDRESS,
    );

    const pending = await reader.readAgentAuthorization(name);
    expect(pending).toMatchObject({
      agentEns: name,
      rootId: "root_fresh",
      active: false,
      finalized: false,
      capabilities: [],
    });

    await finalize();
    const details = await reader.readAgentAuthorizationDetails(name);
    const a = details.authorization;
    expect(v.safeParse(AgentAuthorizationSchema, a).success).toBe(true);
    expect(a).toMatchObject({
      active: true,
      revoked: false,
      finalized: true,
      rootId: "root_fresh",
    });
    expect(a.capabilities).toEqual(
      CAPABILITY_ORDER.filter((c) =>
        ["drafts.write", "application.submit"].includes(c),
      ),
    );
    expect(a.expiresAt).toBe(
      new Date(Math.floor(Date.parse(m.expiresAt) / 1000) * 1000).toISOString(),
    );
    const finalizedBlock = await client.getBlock({ blockTag: "finalized" });
    expect(a.blockNumber).toBe(Number(finalizedBlock.number));
    expect(details.account).toBe(adapter.agentBackend(m.id).account.address);
  });

  it("registration is idempotent under retries and concurrent duplicates", async () => {
    const m = mission(
      "mission-retry",
      "root_retry",
      ["web.search"],
      3 * DAY,
      await chainNow(),
    );
    const [a, b] = await Promise.all([
      adapter.register(m, jawOwner),
      adapter.register(m, jawOwner),
    ]);
    expect(a).toBe(b);
    const before = await client.getBlockNumber({ cacheTime: 0 });
    expect(await adapter.register(m, jawOwner)).toBe(a); // no transaction on an identical retry
    expect(await client.getBlockNumber({ cacheTime: 0 })).toBe(before);
    await expect(
      adapter.register(
        m,
        getAddress("0x2222222222222222222222222222222222222222"),
      ),
    ).rejects.toMatchObject({ code: "CONFLICT" });

    await expect(
      writer.registerAgent({
        rootNode: (await writer.agentAuthorization(nodeOf(a))).rootNode,
        rootLabel: a.split(".")[1]!,
        label: a.split(".")[0]!,
        account: privateKeyToAccount(generatePrivateKey()).address,
        capabilities: ["web.search"],
        expiresAt: new Date(Date.parse(m.expiresAt)),
      }),
    ).rejects.toMatchObject({ code: "CONFLICT" });
  });

  it.each(["0x0000000000000000000000000000000000000000", "0x1234"])(
    "rejects invalid root owner %s before any chain write",
    async (invalidOwner) => {
      const m = mission(
        `mission-invalid-owner-${invalidOwner}`,
        `root-invalid-${invalidOwner}`,
        ["web.search"],
        DAY,
        await chainNow(),
      );
      const before = await client.getBlockNumber({ cacheTime: 0 });
      await expect(adapter.register(m, invalidOwner)).rejects.toMatchObject({
        code: "INVALID_INPUT",
      });
      expect(await client.getBlockNumber({ cacheTime: 0 })).toBe(before);
    },
  );

  it("does not reuse an operator-owned root for a JAW account", async () => {
    const m = mission(
      "mission-operator-root",
      "root-operator-owned",
      ["web.search"],
      DAY,
      await chainNow(),
    );
    await writer.registerRoot({
      label: rootLabelFor(m.rootId),
      rootId: m.rootId,
      owner: operatorAddress,
      expiresAt: new Date(Number(await writer.parentExpiry()) * 1000),
    });
    await expect(adapter.register(m, jawOwner)).rejects.toMatchObject({
      code: "CONFLICT",
    });
  });

  it("revocation is effective at latest immediately, before finality", async () => {
    const { m, name } = await registeredAndFinalized("mission-revoke");
    expect((await reader.readAgentAuthorization(name)).active).toBe(true);

    await adapter.revoke(m);
    const immediate = await reader.readAgentAuthorization(name);
    expect(immediate).toMatchObject({
      active: false,
      revoked: true,
      finalized: false,
      capabilities: [],
    });

    await finalize();
    expect(await reader.readAgentAuthorization(name)).toMatchObject({
      active: false,
      revoked: true,
      finalized: true,
    });
    await adapter.revoke(m); // idempotent retry
  });

  it("revocation race: concurrent reads never mix states and none after the receipt are active", async () => {
    const { m, name } = await registeredAndFinalized("mission-race");
    const node = nodeOf(name);
    const inflight = Array.from({ length: 8 }, () =>
      reader.readAgentAuthorizationDetails(name),
    );
    const revocation = writer.revokeAgent(node);
    const results = await Promise.all([
      ...inflight,
      revocation.then(() => null),
    ]);
    const revokedAt = (await revocation).blockNumber!;
    for (const r of results) {
      if (!r) continue;
      expect(r.authorization.active && r.authorization.revoked).toBe(false);
      if (r.authorization.active)
        expect(r.latestSnapshot.blockNumber).toBeLessThan(revokedAt);
    }
    const after = await Promise.all(
      Array.from({ length: 4 }, () => reader.readAgentAuthorization(name)),
    );
    for (const a of after)
      expect(a).toMatchObject({ active: false, revoked: true });
    expect(m.id).toBe("mission-race");
  });

  it("revocation landing mid-read yields a consistent block-pinned snapshot", async () => {
    const { name } = await registeredAndFinalized("mission-midread");
    const node = nodeOf(name);
    const base = http(env.rpcUrl)({ chain: foundry });
    const blockParams: unknown[] = [];
    let revokedInFlight: Promise<{ blockNumber: bigint | null }> | null = null;
    const request: EIP1193RequestFn = async (args) => {
      if (args.method === "eth_call") {
        const block = (args.params as [unknown, unknown])[1];
        blockParams.push(block);
        // Once the reader has fixed its block numbers (pinned call), land a revocation
        // before any of its state reads are served.
        if (typeof block === "string" && block.startsWith("0x")) {
          revokedInFlight ??= writer.revokeAgent(node);
          await revokedInFlight;
        }
      }
      return base.request(args as never);
    };
    const racingReader = createAuthorizationReader({
      client: createPublicClient({
        chain: foundry,
        transport: custom({ request }),
      }) as PublicClient,
      chainId: foundry.id,
      registrar: env.registrar,
      universalResolver: env.universalResolver,
      now: () => new Date(Date.now() + clockSkewMs),
    });
    const details = await racingReader.readAgentAuthorizationDetails(name);
    const revokedBlock = (await revokedInFlight!).blockNumber!;
    // Only the one-time parentName lookup is unpinned; every state read names its block.
    expect(
      blockParams.filter(
        (b) => !(typeof b === "string" && /^0x[0-9a-f]+$/.test(b)),
      ),
    ).toHaveLength(1);
    // The head moved during the first attempt, so the reader retried and saw the revocation.
    expect(details.latestSnapshot.blockNumber).toBeGreaterThanOrEqual(
      revokedBlock,
    );
    expect(details.authorization).toMatchObject({
      active: false,
      revoked: true,
    });
  });

  it("fails closed as unavailable when the head keeps moving during reads", async () => {
    const { name } = await registeredAndFinalized("mission-moving-head");
    const base = http(env.rpcUrl)({ chain: foundry });
    const request: EIP1193RequestFn = async (args) => {
      const result = await base.request(args as never);
      if (args.method === "eth_call")
        await base.request({ method: "anvil_mine", params: ["0x1"] } as never);
      return result as never;
    };
    const movingReader = createAuthorizationReader({
      client: createPublicClient({
        chain: foundry,
        transport: custom({ request }),
      }) as PublicClient,
      chainId: foundry.id,
      registrar: env.registrar,
      universalResolver: env.universalResolver,
      now: () => new Date(Date.now() + clockSkewMs),
      maxLatestHeadFutureSkewMs: 3_600_000,
    });
    await expect(
      movingReader.readAgentAuthorization(name),
    ).rejects.toMatchObject({ code: "UNAVAILABLE" });
    await syncClock();
  });

  it("fails closed on a stale or future latest head even when both snapshots are active", async () => {
    const { name } = await registeredAndFinalized("mission-stale-head");
    expect((await reader.readAgentAuthorization(name)).active).toBe(true);
    const withClock = (offsetMs: number) =>
      createAuthorizationReader({
        client,
        chainId: foundry.id,
        registrar: env.registrar,
        universalResolver: env.universalResolver,
        now: () => new Date(Date.now() + clockSkewMs + offsetMs),
      });
    // RPC stuck on an old head: local time is 5 minutes past it.
    const stale = await withClock(5 * 60_000).readAgentAuthorizationDetails(
      name,
    );
    expect(stale.finalizedSnapshot.active && stale.latestSnapshot.active).toBe(
      true,
    );
    expect(stale.authorization).toMatchObject({
      active: false,
      capabilities: [],
    });
    expect(stale.failures).toContain("latest head is stale");
    // Head claims a time well ahead of the local clock.
    const future = await withClock(-5 * 60_000).readAgentAuthorizationDetails(
      name,
    );
    expect(future.authorization.active).toBe(false);
    expect(future.failures).toContain("latest head is in the future");
  });

  it("requires the agent's official EAC status/receipt grants, independent of registrar flags", async () => {
    const { name } = await registeredAndFinalized("mission-eac");
    const details = await reader.readAgentAuthorizationDetails(name);
    expect(details.authorization.active).toBe(true);
    // Model EAC removal without touching registrar state: act as the registrar (the grant admin).
    await rpc("anvil_impersonateAccount", [env.registrar]);
    await rpc("anvil_setBalance", [env.registrar, toHex(10n ** 18n)]);
    const hash = await client.request({
      method: "eth_sendTransaction" as never,
      params: [
        {
          from: env.registrar,
          to: details.resolver,
          data: encodeFunctionData({
            abi: parseAbi([
              "function revokeRoles(uint256 resource, uint256 roleBitmap, address account)",
            ]),
            functionName: "revokeRoles",
            args: [
              BigInt(keccak256(toHex(TEXT_KEYS.receipt))),
              1n << 4n,
              details.account,
            ],
          }),
        },
      ] as never,
    });
    await client.waitForTransactionReceipt({ hash: hash as `0x${string}` });
    await rpc("anvil_stopImpersonatingAccount", [env.registrar]);
    await syncClock();
    const after = await reader.readAgentAuthorizationDetails(name);
    expect((await writer.agentAuthorization(details.node)).active).toBe(true); // registrar unaware
    expect(after.latestSnapshot.failures).toContain(
      "agent status/receipt EAC grant missing",
    );
    expect(after.authorization).toMatchObject({
      active: false,
      revoked: false,
      finalized: false,
    });
    await finalize();
    expect(await reader.readAgentAuthorization(name)).toMatchObject({
      active: false,
      finalized: true,
    });
  });

  it("expired hierarchy fails closed: root expiry deactivates its agents", async () => {
    const now = await chainNow();
    const root = await writer.registerRoot({
      label: "shortlived",
      rootId: "root_short",
      owner: privateKeyToAccount(ANVIL_KEY_0).address,
      expiresAt: new Date((now + 3600) * 1000),
    });
    const agentAccount = privateKeyToAccount(generatePrivateKey()).address;
    await writer.registerAgent({
      rootNode: root.node,
      rootLabel: "shortlived",
      label: "task",
      account: agentAccount,
      capabilities: ["documents.read"],
      expiresAt: new Date((now + 3600) * 1000),
    });
    await expect(
      writer.registerAgent({
        rootNode: root.node,
        rootLabel: "shortlived",
        label: "too-long",
        account: agentAccount,
        capabilities: ["documents.read"],
        expiresAt: new Date((now + 7200) * 1000),
      }),
    ).rejects.toMatchObject({
      code: "REVERTED",
      revertName: "ExpiryExceedsParent",
    });
    await finalize();
    const name = `task.shortlived.${await reader.getParentName()}`;
    expect((await reader.readAgentAuthorization(name)).active).toBe(true);

    await advance(3601);
    await finalize();
    const expired = await reader.readAgentAuthorization(name);
    expect(expired).toMatchObject({
      active: false,
      revoked: false,
      finalized: true,
    });
    expect(Date.parse(expired.expiresAt)).toBeLessThanOrEqual(
      Date.parse(expired.checkedAt),
    );
    await expect(
      writer.renewAgent(nodeOf(name), new Date((now + 9000) * 1000)),
    ).rejects.toMatchObject({
      code: "REVERTED",
      revertName: "AgentExpired",
    });
  });

  it("detaching the parent name from the HumanOS registry deactivates every agent", async () => {
    const { name } = await registeredAndFinalized("mission-detach");
    const operator = createPrivateKeyBackend(
      ANVIL_KEY_0,
      foundry,
      http(env.rpcUrl),
    );
    const ethRegistryAbi = parseAbi([
      "function setSubregistry(uint256 anyId, address registry)",
    ]);
    const parentId = BigInt(keccak256(toHex("humanos")));
    const detach = async (to: Address) => {
      const hash = await operator.wallet.writeContract({
        address: env.ethRegistry,
        abi: ethRegistryAbi,
        functionName: "setSubregistry",
        args: [parentId, to],
      });
      await client.waitForTransactionReceipt({ hash });
    };
    await detach("0x0000000000000000000000000000000000000000");
    expect(await reader.readAgentAuthorization(name)).toMatchObject({
      active: false,
      revoked: false,
      finalized: false,
    });
    await detach(env.humanosRegistry);
    await finalize();
    expect((await reader.readAgentAuthorization(name)).active).toBe(true);
  });

  it("local clock past expiry fails closed even while the chain still reports active", async () => {
    const { name } = await registeredAndFinalized("mission-clock");
    const a = await reader.readAgentAuthorization(name);
    expect(a.active).toBe(true);
    const lateReader = createAuthorizationReader({
      client,
      chainId: foundry.id,
      registrar: env.registrar,
      universalResolver: env.universalResolver,
      now: () => new Date(Date.parse(a.expiresAt) + 1000),
    });
    expect(await lateReader.readAgentAuthorization(name)).toMatchObject({
      active: false,
      capabilities: [],
    });
  });

  it("narrowing applies immediately and never broadens", async () => {
    const { name } = await registeredAndFinalized("mission-narrow", [
      "drafts.write",
      "email.send",
      "form.save",
    ]);
    await writer.narrowAgentCapabilities(nodeOf(name), ["drafts.write"]);
    const pending = await reader.readAgentAuthorization(name);
    expect(pending).toMatchObject({
      active: true,
      finalized: false,
      capabilities: ["drafts.write"],
    });
    await expect(
      writer.narrowAgentCapabilities(nodeOf(name), [
        "drafts.write",
        "value.transfer",
      ]),
    ).rejects.toMatchObject({
      code: "REVERTED",
      revertName: "CapabilityEscalation",
    });
  });

  it("agents write only their own status/receipt records and lose that right on revocation", async () => {
    const { m, name } = await registeredAndFinalized("mission-records");
    await adapter.writeAgentRecord(m, "status", "running");
    await adapter.writeAgentRecord(m, "receipt", "0xreceipt");
    const { resolver } = await reader.readAgentAuthorizationDetails(name);
    const latest = await client.getBlockNumber({ cacheTime: 0 });
    expect(
      await readText(client, resolver, name, TEXT_KEYS.status, latest),
    ).toBe("running");
    expect(
      await readText(client, resolver, name, TEXT_KEYS.receipt, latest),
    ).toBe("0xreceipt");

    const agentAccount = adapter.agentBackend(m.id).account;
    await expect(
      client.simulateContract({
        account: agentAccount,
        address: resolver,
        abi: permissionedResolverAbi,
        functionName: "setText",
        args: [dnsEncode(name), TEXT_KEYS.capabilities, "0x3fff"],
      }),
    ).rejects.toThrow(/EACUnauthorizedAccountRoles/);

    await adapter.revoke(m);
    await expect(
      adapter.writeAgentRecord(m, "status", "zombie"),
    ).rejects.toMatchObject({
      code: "REVERTED",
      revertName: "EACUnauthorizedAccountRoles",
    });
    expect(
      await readText(
        client,
        resolver,
        name,
        TEXT_KEYS.status,
        await client.getBlockNumber({ cacheTime: 0 }),
      ),
    ).toBe("revoked");
  });

  it("rejects malformed, foreign and unknown names", async () => {
    const parent = await reader.getParentName();
    for (const bad of [
      `Task.root.${parent}`,
      `a.b.c.${parent}`,
      `task.${parent}`,
      "task.root.other.eth",
      `-x.root.${parent}`,
    ]) {
      await expect(reader.readAgentAuthorization(bad)).rejects.toMatchObject({
        code: "INVALID_NAME",
      });
    }
    await expect(
      reader.readAgentAuthorization(`unknown.nobody.${parent}`),
    ).rejects.toMatchObject({ code: "NOT_FOUND" });
  });

  it("refuses a mismatched chain and reports an unreachable RPC as unavailable", async () => {
    const wrongChain = createAuthorizationReader({
      client,
      chainId: 11155111,
      registrar: env.registrar,
      universalResolver: env.universalResolver,
    });
    await expect(
      wrongChain.readAgentAuthorization("a.b.humanos.eth"),
    ).rejects.toMatchObject({ code: "WRONG_CHAIN" });

    const down = createAuthorizationReader({
      client: createPublicClient({
        chain: foundry,
        transport: http("http://127.0.0.1:1", { retryCount: 0 }),
      }) as PublicClient,
      chainId: foundry.id,
      registrar: env.registrar,
      universalResolver: env.universalResolver,
    });
    const error = await down
      .readAgentAuthorization("a.b.humanos.eth")
      .catch((e: unknown) => e);
    expect(error).toBeInstanceOf(EnsAuthorizationError);
    expect((error as EnsAuthorizationError).code).toBe("UNAVAILABLE");
  });

  it("non-operator keys cannot mutate HumanOS identities", async () => {
    const { name } = await registeredAndFinalized("mission-intruder");
    const intruder = createPrivateKeyBackend(
      generatePrivateKey(),
      foundry,
      http(env.rpcUrl),
    );
    const intruderWriter = createEnsWriter({
      journal: createMemoryJournal(),
      receiptTimeoutMs: 2000,
      client,
      registrar: env.registrar,
      operator: intruder,
    });
    const error = await intruderWriter
      .revokeAgent(nodeOf(name))
      .catch((e: unknown) => e);
    expect(error).toBeInstanceOf(EnsWriteError);
    expect(error).toMatchObject({
      code: "REVERTED",
      revertName: "OwnableUnauthorizedAccount",
    });
    expect((await reader.readAgentAuthorization(name)).active).toBe(true);
  });
});

describe("registration binding and nonce regression coverage", () => {
  it("root retries require exact owner/expiry and reject revoked roots", async () => {
    const owner = privateKeyToAccount(ANVIL_KEY_0).address;
    const input = {
      label: "strict-root",
      rootId: "strict-root-id",
      owner,
      expiresAt: new Date(((await chainNow()) + 3 * DAY) * 1000),
    };
    const first = await writer.registerRoot(input);
    expect((await writer.registerRoot(input)).hash).toBeNull();
    await expect(
      writer.registerRoot({
        ...input,
        owner: privateKeyToAccount(generatePrivateKey()).address,
      }),
    ).rejects.toMatchObject({ code: "CONFLICT" });
    await expect(
      writer.registerRoot({
        ...input,
        expiresAt: new Date(input.expiresAt.getTime() + 1000),
      }),
    ).rejects.toMatchObject({ code: "CONFLICT" });
    await writer.revokeRoot(first.node);
    await expect(writer.registerRoot(input)).rejects.toMatchObject({
      code: "CONFLICT",
    });
  });
  it("agent retries reject changed expiry, inconsistent root and revoked names", async () => {
    const { m, name } = await registeredAndFinalized("strict-agent");
    const a = await writer.agentAuthorization(nodeOf(name));
    const [label, rootLabel] = name.split(".");
    const input = {
      rootNode: a.rootNode,
      rootLabel: rootLabel!,
      label: label!,
      account: a.account,
      capabilities: m.approvedCapabilities,
      expiresAt: new Date(m.expiresAt),
    };
    expect((await writer.registerAgent(input)).hash).toBeNull();
    await expect(
      writer.registerAgent({
        ...input,
        expiresAt: new Date(Date.parse(m.expiresAt) + 1000),
      }),
    ).rejects.toMatchObject({ code: "CONFLICT" });
    await expect(
      writer.registerAgent({ ...input, rootLabel: "different" }),
    ).rejects.toMatchObject({ code: "INVALID_INPUT" });
    await writer.revokeAgent(nodeOf(name));
    await expect(writer.registerAgent(input)).rejects.toMatchObject({
      code: "CONFLICT",
    });
  });
  it("serializes simultaneous funding and a registration without nonce reuse", async () => {
    const destination = privateKeyToAccount(generatePrivateKey()).address;
    const amount = 10n ** 15n;
    const input = {
      label: "funding-parallel",
      rootId: "funding-parallel-root",
      owner: privateKeyToAccount(ANVIL_KEY_0).address,
      expiresAt: new Date(((await chainNow()) + DAY) * 1000),
    };
    const [one, two, root] = await Promise.all([
      writer.fundAccount(destination, amount),
      writer.fundAccount(destination, amount),
      writer.registerRoot(input),
    ]);
    expect(new Set([one.hash, two.hash].filter(Boolean)).size).toBe(1);
    expect(await client.getBalance({ address: destination })).toBe(amount);
    expect(root.hash).not.toBeNull();
    const funded = [one, two].find((x) => x.hash)!;
    const [fundTx, rootTx] = await Promise.all([
      client.getTransaction({ hash: funded.hash! }),
      client.getTransaction({ hash: root.hash! }),
    ]);
    expect(fundTx.nonce).not.toBe(rootTx.nonce);
  });
  it("two identical concurrent root registrations converge on one identity", async () => {
    const input = {
      label: "race-root",
      rootId: "race-root-id",
      owner: privateKeyToAccount(ANVIL_KEY_0).address,
      expiresAt: new Date(((await chainNow()) + DAY) * 1000),
    };
    const [a, b] = await Promise.all([
      writer.registerRoot(input),
      writer.registerRoot(input),
    ]);
    expect(a.node).toBe(b.node);
    expect(new Set([a.hash, b.hash].filter(Boolean)).size).toBe(1);
  });
  it("rejects expired root and agent retries without resurrection", async () => {
    const owner = privateKeyToAccount(ANVIL_KEY_0).address;
    const input = {
      label: "expired-retry",
      rootId: "expired-retry-id",
      owner,
      expiresAt: new Date(((await chainNow()) + 300) * 1000),
    };
    const root = await writer.registerRoot(input);
    const agent = {
      rootNode: root.node,
      rootLabel: input.label,
      label: "task",
      account: owner,
      capabilities: ["drafts.write"] as Capability[],
      expiresAt: input.expiresAt,
    };
    await writer.registerAgent(agent);
    await advance(400);
    await expect(writer.registerRoot(input)).rejects.toMatchObject({
      code: "CONFLICT",
    });
    await expect(writer.registerAgent(agent)).rejects.toMatchObject({
      code: "CONFLICT",
    });
  });
});
it("root retry refuses a detached official parent hierarchy", async () => {
  const owner = privateKeyToAccount(ANVIL_KEY_0).address;
  const input = {
    label: "detached-retry",
    rootId: "detached-retry-id",
    owner,
    expiresAt: new Date(((await chainNow()) + DAY) * 1000),
  };
  await writer.registerRoot(input);
  const [parentRegistry, parentLabel, humanRegistry] = await Promise.all([
    client.readContract({
      address: env.registrar,
      abi: humanosRegistrarAbi,
      functionName: "PARENT_REGISTRY",
    }),
    client.readContract({
      address: env.registrar,
      abi: humanosRegistrarAbi,
      functionName: "parentLabel",
    }),
    client.readContract({
      address: env.registrar,
      abi: humanosRegistrarAbi,
      functionName: "HUMANOS_REGISTRY",
    }),
  ]);
  const wallet = createPrivateKeyBackend(
    ANVIL_KEY_0,
    foundry,
    http(env.rpcUrl),
  ).wallet;
  const set = async (address: Address) => {
    const hash = await wallet.writeContract({
      address: parentRegistry,
      abi: parseAbi([
        "function setSubregistry(uint256 tokenId,address subregistry)",
      ]),
      functionName: "setSubregistry",
      args: [BigInt(keccak256(toHex(parentLabel))), address],
    });
    await client.waitForTransactionReceipt({ hash });
  };
  await set("0x0000000000000000000000000000000000000000");
  try {
    await expect(writer.registerRoot(input)).rejects.toMatchObject({
      code: "CONFLICT",
    });
  } finally {
    await set(humanRegistry);
  }
});
