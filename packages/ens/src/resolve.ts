import {
  decodeFunctionResult,
  encodeFunctionData,
  namehash,
  toHex,
  type Address,
  type Hex,
  type PublicClient,
} from "viem";
import { normalize, packetToBytes } from "viem/ens";
import {
  permissionedResolverAbi,
  textProfileAbi,
  universalResolverAbi,
} from "./abi/official.js";

const LABEL = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/;

export class InvalidAgentNameError extends Error {
  override name = "InvalidAgentNameError";
}

/** Same label rule as HumanOSRegistrar._checkLabel: already-normalized [a-z0-9-]{1,63}. */
export function isValidLabel(label: string): boolean {
  return LABEL.test(label);
}

/**
 * Accepts only `<agent>.<root>.<parentName>` names that are already ENSIP-15 normalized and use
 * the registrar's restricted label alphabet, so no two spellings can map to one identity.
 */
export function parseAgentName(
  name: string,
  parentName: string,
): { agentLabel: string; rootLabel: string } {
  let normalized: string;
  try {
    normalized = normalize(name);
  } catch {
    throw new InvalidAgentNameError("name is not ENS-normalizable");
  }
  if (normalized !== name)
    throw new InvalidAgentNameError("name is not in normalized form");
  const suffix = `.${parentName}`;
  if (!name.endsWith(suffix))
    throw new InvalidAgentNameError(`name is not under ${parentName}`);
  const labels = name.slice(0, -suffix.length).split(".");
  const [agentLabel, rootLabel] = labels;
  if (
    labels.length !== 2 ||
    agentLabel === undefined ||
    rootLabel === undefined
  ) {
    throw new InvalidAgentNameError("expected <agent>.<root>." + parentName);
  }
  if (!isValidLabel(agentLabel) || !isValidLabel(rootLabel))
    throw new InvalidAgentNameError("invalid label");
  return { agentLabel, rootLabel };
}

export const dnsEncode = (name: string): Hex => toHex(packetToBytes(name));
export const nodeOf = (name: string): Hex => namehash(name);

/** Official Universal Resolver lookup pinned to a block. offset 0 means found at the exact name. */
export async function findResolver(
  client: PublicClient,
  universalResolver: Address,
  name: string,
  blockNumber: bigint,
): Promise<{ resolver: Address; offset: bigint }> {
  const [resolver, , offset] = await client.readContract({
    address: universalResolver,
    abi: universalResolverAbi,
    functionName: "findResolver",
    args: [dnsEncode(name)],
    blockNumber,
  });
  return { resolver, offset };
}

/** Reads a text record through the resolver's official `resolve(name, data)` entry point. */
export async function readText(
  client: PublicClient,
  resolver: Address,
  name: string,
  key: string,
  blockNumber: bigint,
): Promise<string> {
  const data = encodeFunctionData({
    abi: textProfileAbi,
    functionName: "text",
    args: [nodeOf(name), key],
  });
  const result = await client.readContract({
    address: resolver,
    abi: permissionedResolverAbi,
    functionName: "resolve",
    args: [dnsEncode(name), data],
    blockNumber,
  });
  return decodeFunctionResult({
    abi: textProfileAbi,
    functionName: "text",
    data: result,
  });
}
