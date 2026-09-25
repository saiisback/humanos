import {
  createPublicClient,
  getAddress,
  http,
  isAddress,
  isHex,
  type Address,
  type Chain,
  type PublicClient,
} from "viem";
import { sepolia } from "viem/chains";
import { ENSV2_SEPOLIA } from "./deployments.js";

export class EnsConfigError extends Error {
  override name = "EnsConfigError";
  constructor(readonly missing: string[]) {
    // Names only: values (RPC URLs with keys, private keys) are never echoed.
    super(`ENS integration not configured: ${missing.join(", ")}`);
  }
}

export interface EnsEnvConfig {
  chain: Chain;
  rpcUrl: string;
  registrar: Address;
  universalResolver: Address;
  operatorPrivateKey: `0x${string}` | null;
  agentKeySeed: `0x${string}` | null;
  confirmations: number;
  agentFundingWei: bigint;
}

type Env = Record<string, string | undefined>;

/**
 * Reads the Sepolia ENS configuration. Reads need SEPOLIA_RPC_URL and ENS_REGISTRAR_ADDRESS;
 * writes additionally need ENS_OPERATOR_PRIVATE_KEY and ENS_AGENT_KEY_SEED (`requireWrites`).
 */
export function loadEnsEnvConfig(
  env: Env,
  options: { requireWrites?: boolean } = {},
): EnsEnvConfig {
  const problems: string[] = [];
  const rpcUrl = env.SEPOLIA_RPC_URL?.trim() ?? "";
  if (!/^https?:\/\//.test(rpcUrl)) problems.push("SEPOLIA_RPC_URL");
  const registrar = env.ENS_REGISTRAR_ADDRESS?.trim() ?? "";
  if (!isAddress(registrar)) problems.push("ENS_REGISTRAR_ADDRESS");
  const universalResolver =
    env.ENS_UNIVERSAL_RESOLVER_ADDRESS?.trim() ||
    ENSV2_SEPOLIA.UpgradableUniversalResolverProxy;
  if (!isAddress(universalResolver))
    problems.push("ENS_UNIVERSAL_RESOLVER_ADDRESS");
  const key = (name: string) => {
    const value = env[name]?.trim();
    if (!value) return null;
    if (!isHex(value) || value.length !== 66) {
      problems.push(name);
      return null;
    }
    return value;
  };
  const operatorPrivateKey = key("ENS_OPERATOR_PRIVATE_KEY");
  const agentKeySeed = key("ENS_AGENT_KEY_SEED");
  if (options.requireWrites) {
    if (!operatorPrivateKey && !problems.includes("ENS_OPERATOR_PRIVATE_KEY"))
      problems.push("ENS_OPERATOR_PRIVATE_KEY");
    if (!agentKeySeed && !problems.includes("ENS_AGENT_KEY_SEED"))
      problems.push("ENS_AGENT_KEY_SEED");
  }
  const confirmations = Number(env.ENS_CONFIRMATIONS ?? "2");
  if (!Number.isInteger(confirmations) || confirmations < 1)
    problems.push("ENS_CONFIRMATIONS");
  let agentFundingWei = 0n;
  try {
    agentFundingWei = BigInt(env.ENS_AGENT_FUNDING_WEI ?? "0");
    if (agentFundingWei < 0n) problems.push("ENS_AGENT_FUNDING_WEI");
  } catch {
    problems.push("ENS_AGENT_FUNDING_WEI");
  }
  if (problems.length > 0) throw new EnsConfigError(problems);
  return {
    chain: sepolia,
    rpcUrl,
    registrar: getAddress(registrar),
    universalResolver: getAddress(universalResolver),
    operatorPrivateKey,
    agentKeySeed,
    confirmations,
    agentFundingWei,
  };
}

export function createEnsPublicClient(
  config: Pick<EnsEnvConfig, "chain" | "rpcUrl">,
): PublicClient {
  return createPublicClient({
    chain: config.chain,
    transport: http(config.rpcUrl),
  }) as PublicClient;
}
