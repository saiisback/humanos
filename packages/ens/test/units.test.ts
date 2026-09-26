import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { CapabilitySchema } from "@humanos/schemas";
import {
  CAPABILITY_ORDER,
  capabilitiesRecordValue,
  CapabilityEncodingError,
  decodeCapabilities,
  deriveAgentPrivateKey,
  EnsConfigError,
  encodeCapabilities,
  ENSV2_SEPOLIA,
  humanosRegistrarAbi,
  InvalidAgentNameError,
  loadEnsEnvConfig,
  parseAgentName,
  agentLabelFor,
  rootLabelFor,
  isValidLabel,
} from "../src/index.js";

const CONTRACTS = resolve(import.meta.dirname, "../../contracts");

describe("capability bitmap", () => {
  it("appends Linear without changing the original capability bits", () => {
    expect(CAPABILITY_ORDER).toEqual(CapabilitySchema.options);
    expect(CAPABILITY_ORDER).toHaveLength(15);
    expect(encodeCapabilities(["linear.issue.create"])).toBe(0x4000n);
    expect(encodeCapabilities(["permissions.change"])).toBe(0x2000n);
    expect(encodeCapabilities(CAPABILITY_ORDER)).toBe((1n << 15n) - 1n);
  });

  it("round-trips and matches the registrar's record encoding", () => {
    const caps = [
      "drafts.write",
      "calendar.create",
      "application.submit",
    ] as const;
    const bitmap = encodeCapabilities(caps);
    expect(bitmap).toBe(0x224n); // same bits as the Foundry tests
    expect(capabilitiesRecordValue(bitmap)).toBe("0x0224"); // OpenZeppelin Strings.toHexString
    expect(capabilitiesRecordValue(0x4n)).toBe("0x04");
    expect(decodeCapabilities(bitmap)).toEqual(caps);
  });

  it("fails closed on unknown capabilities and out-of-range bits", () => {
    expect(() =>
      encodeCapabilities(["documents.read", "wallet.drain"]),
    ).toThrow(CapabilityEncodingError);
    expect(() => decodeCapabilities(1n << 15n)).toThrow(
      CapabilityEncodingError,
    );
    expect(() => decodeCapabilities(-1n)).toThrow(CapabilityEncodingError);
  });
});

describe("agent names", () => {
  it("accepts only normalized <agent>.<root>.<parent> names with the registrar label alphabet", () => {
    expect(parseAgentName("task.alice.humanos.eth", "humanos.eth")).toEqual({
      agentLabel: "task",
      rootLabel: "alice",
    });
    for (const bad of [
      "Task.alice.humanos.eth",
      "task.alice.other.eth",
      "a.task.alice.humanos.eth",
      "alice.humanos.eth",
      "ta_sk.alice.humanos.eth",
      "-task.alice.humanos.eth",
      "tаsk.alice.humanos.eth", // Cyrillic a
    ]) {
      expect(() => parseAgentName(bad, "humanos.eth"), bad).toThrow(
        InvalidAgentNameError,
      );
    }
  });

  it("derives opaque, valid, deterministic labels from server IDs", () => {
    expect(rootLabelFor("root id with spaces/✓")).toMatch(/^r[0-9a-f]{16}$/);
    expect(agentLabelFor("m1")).toBe(agentLabelFor("m1"));
    expect(agentLabelFor("m1")).not.toBe(agentLabelFor("m2"));
    expect(isValidLabel(agentLabelFor("x"))).toBe(true);
    expect(isValidLabel("a".repeat(64))).toBe(false);
  });

  it("derives distinct agent keys per mission from the seed", () => {
    const seed = `0x${"11".repeat(32)}`;
    const a = deriveAgentPrivateKey(seed, "mission-a");
    expect(a).toMatch(/^0x[0-9a-f]{64}$/);
    expect(deriveAgentPrivateKey(seed, "mission-a")).toBe(a);
    expect(deriveAgentPrivateKey(seed, "mission-b")).not.toBe(a);
    expect(() => deriveAgentPrivateKey("0x1234", "m")).toThrow();
  });
});

describe("configuration", () => {
  const secret = `0x${"ab".repeat(32)}`;
  const base = {
    SEPOLIA_RPC_URL: "https://sepolia.example/v3/secret-token",
    ENS_REGISTRAR_ADDRESS: "0x0000000000000000000000000000000000000001",
  };

  it("refuses to configure without required settings and never echoes values", () => {
    const error = (() => {
      try {
        loadEnsEnvConfig(
          { ENS_OPERATOR_PRIVATE_KEY: "0xnot-a-key", SEPOLIA_RPC_URL: "" },
          { requireWrites: true },
        );
      } catch (e) {
        return e as EnsConfigError;
      }
      throw new Error("expected failure");
    })();
    expect(error).toBeInstanceOf(EnsConfigError);
    expect(error.missing).toEqual(
      expect.arrayContaining([
        "SEPOLIA_RPC_URL",
        "ENS_REGISTRAR_ADDRESS",
        "ENS_OPERATOR_PRIVATE_KEY",
        "ENS_AGENT_KEY_SEED",
      ]),
    );
    expect(error.message).not.toContain("0xnot-a-key");
  });

  it("reads config for reads only, and requires keys for writes", () => {
    const readOnly = loadEnsEnvConfig(base);
    expect(readOnly.chain.id).toBe(11155111);
    expect(readOnly.universalResolver).toBe(
      ENSV2_SEPOLIA.UpgradableUniversalResolverProxy,
    );
    expect(readOnly.operatorPrivateKey).toBeNull();
    expect(() => loadEnsEnvConfig(base, { requireWrites: true })).toThrow(
      EnsConfigError,
    );
    const full = loadEnsEnvConfig(
      {
        ...base,
        ENS_OPERATOR_PRIVATE_KEY: secret,
        ENS_AGENT_KEY_SEED: secret,
        ENS_CONFIRMATIONS: "3",
      },
      { requireWrites: true },
    );
    expect(full.confirmations).toBe(3);
    try {
      loadEnsEnvConfig({
        ...base,
        ENS_CONFIRMATIONS: "0",
        ENS_OPERATOR_PRIVATE_KEY: secret,
      });
    } catch (e) {
      expect((e as Error).message).not.toContain(secret);
      expect((e as Error).message).not.toContain("secret-token");
    }
  });
});

describe("pinned artifacts", () => {
  it("TS deployment constants equal the verified contracts metadata", () => {
    const meta = JSON.parse(
      readFileSync(
        resolve(CONTRACTS, "deployments/ensv2-sepolia.json"),
        "utf8",
      ),
    );
    expect(meta.chainId).toBe(ENSV2_SEPOLIA.chainId);
    expect(meta.source.commit).toBe(ENSV2_SEPOLIA.sourceCommit);
    for (const name of [
      "RootRegistry",
      "ETHRegistry",
      "VerifiableFactory",
      "PermissionedResolverImpl",
      "UserRegistryImpl",
      "UniversalResolverV2",
      "UpgradableUniversalResolverProxy",
    ] as const) {
      expect(meta.contracts[name].address.toLowerCase(), name).toBe(
        ENSV2_SEPOLIA[name].toLowerCase(),
      );
    }
  });

  it("committed registrar ABI matches the forge build output when present", () => {
    const artifact = resolve(
      CONTRACTS,
      "out/HumanOSRegistrar.sol/HumanOSRegistrar.json",
    );
    if (!existsSync(artifact)) return; // CI without a forge build: the integration suite compiles it
    expect(JSON.parse(JSON.stringify(humanosRegistrarAbi))).toEqual(
      JSON.parse(readFileSync(artifact, "utf8")).abi,
    );
  });
});
