import { describe, expect, it, vi } from "vitest";
import { http } from "viem";
import { sepolia } from "viem/chains";
import * as ens from "../src/index.js";

const owner = "0x1111111111111111111111111111111111111111";
const node = `0x${"aa".repeat(32)}` as const;
const hash = `0x${"bb".repeat(32)}` as const;
const expiry = "2030-01-02T00:00:00.000Z";
function fixture() {
  const writer = {
    getParentName: async () => "test-humanos.eth",
    parentExpiry: async () => BigInt(Date.parse(expiry) / 1000),
    rootNodeOf: async () => node,
    rootState: vi.fn(async () => ({
      node,
      used: true,
      revoked: false,
      owner,
      expiry: BigInt(Date.parse(expiry) / 1000),
      live: true,
    })),
    registerRoot: vi.fn(),
    registerAgent: vi.fn(
      async (_input: Parameters<ens.EnsWriter["registerAgent"]>[0]) => ({
        node,
        hash,
        blockNumber: 1n,
      }),
    ),
    fundAccount: vi.fn(),
    revokeAgent: vi.fn(async () => ({ node, hash, blockNumber: 1n })),
    writeAgentRecord: vi.fn(async () => ({ node, hash, blockNumber: 1n })),
  };
  const adapter = ens.createHumanOSEnsAdapter({
    writer: writer as unknown as ens.EnsWriter,
    reader: {} as ens.AuthorizationReader,
    chain: sepolia,
    transport: http(),
    agentKeySeed: `0x${"11".repeat(32)}`,
  });
  return { writer, port: (adapter as any).workflow as ens.WorkflowEnsPort };
}
describe("workflow ENS port", () => {
  it("exposes a neutral workflow lifecycle alongside legacy registration", () => {
    expect(fixture().port).toBeDefined();
  });
  it("domain-separates generations from mission keys", () => {
    expect(ens.workflowDerivationId("wf-1", 2)).toBe("workflow:wf-1:2");
    expect(() => ens.workflowDerivationId("wf-1", 0)).toThrow();
    const seed = `0x${"11".repeat(32)}`;
    expect(
      ens.deriveAgentPrivateKey(seed, ens.workflowDerivationId("wf-1", 1)),
    ).not.toBe(ens.deriveAgentPrivateKey(seed, "wf-1"));
  });
  it("reviews without writes and clips to root expiry", async () => {
    const { port, writer } = fixture();
    expect(
      await port.review({
        rootId: "root",
        rootOwner: owner,
        requestedExpiry: "2031-01-01T00:00:00.000Z",
      }),
    ).toEqual({
      parentName: "test-humanos.eth",
      effectiveExpiry: expiry,
      chainId: 11155111,
    });
    expect(writer.registerAgent).not.toHaveBeenCalled();
  });
  it("rejects changed ownership and dead roots before registration", async () => {
    const { port, writer } = fixture();
    writer.rootState.mockResolvedValueOnce({
      node,
      used: true,
      revoked: false,
      owner: "0x2222222222222222222222222222222222222222",
      expiry: 1n,
      live: true,
    });
    await expect(
      port.review({
        rootId: "root",
        rootOwner: owner,
        requestedExpiry: expiry,
      }),
    ).rejects.toThrow(/owner|identity/i);
    writer.rootState.mockResolvedValueOnce({
      node,
      used: true,
      revoked: true,
      owner,
      expiry: 1n,
      live: false,
    });
    await expect(
      port.review({
        rootId: "root",
        rootOwner: owner,
        requestedExpiry: expiry,
      }),
    ).rejects.toThrow();
  });
  it("registers only the requested content scope and returns confirmed evidence", async () => {
    const { port, writer } = fixture();
    const result = await port.register({
      derivationId: "workflow:wf-1:1",
      rootId: "root",
      rootOwner: owner,
      capabilities: ["drafts.write"],
      expiresAt: expiry,
    });
    expect(writer.registerAgent.mock.calls[0]?.[0]).toMatchObject({
      capabilities: ["drafts.write"],
    });
    expect(result.txHashes).toEqual([hash]);
    expect(result.agentAddress).toMatch(/^0x[0-9a-fA-F]{40}$/);
    expect(result.ensName).toMatch(/\.test-humanos.eth$/);
  });
  it("rejects a changed expiry instead of silently expanding/changing consent", async () => {
    await expect(
      fixture().port.register({
        derivationId: "workflow:wf-1:1",
        rootId: "root",
        rootOwner: owner,
        capabilities: ["drafts.write"],
        expiresAt: "2031-01-01T00:00:00.000Z",
      }),
    ).rejects.toThrow(/expiry/i);
  });
  it("recovers a deterministic identity without registering or trusting supplied chain fields", async () => {
    const { port, writer } = fixture();
    const recovered = await port.identity({
      derivationId: "workflow:recovery:1",
      rootId: "root",
    });
    expect(recovered.node).toBe(ens.nodeOf(recovered.ensName));
    expect(recovered.agentAddress).toMatch(/^0x[0-9a-fA-F]{40}$/);
    expect(writer.registerAgent).not.toHaveBeenCalled();
  });
});
