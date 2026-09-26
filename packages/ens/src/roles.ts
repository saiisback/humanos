import * as v from "valibot";
import { CapabilitySchema, type Capability } from "@humanos/schemas";

/**
 * Capability bit i is the i-th entry of the frozen CapabilitySchema picklist. The on-chain
 * Updated HumanOSRegistrar enforces the same 15-bit mask. Original bits 0..13
 * never move; old deployed registrars reject bit 14 until explicitly migrated.
 */
export const CAPABILITY_ORDER: readonly Capability[] = CapabilitySchema.options;
export const CAPABILITY_MASK = (1n << BigInt(CAPABILITY_ORDER.length)) - 1n;

export class CapabilityEncodingError extends Error {
  override name = "CapabilityEncodingError";
}

export function encodeCapabilities(capabilities: readonly unknown[]): bigint {
  let bitmap = 0n;
  for (const capability of capabilities) {
    const parsed = v.safeParse(CapabilitySchema, capability);
    if (!parsed.success)
      throw new CapabilityEncodingError(
        `unknown capability: ${String(capability)}`,
      );
    bitmap |= 1n << BigInt(CAPABILITY_ORDER.indexOf(parsed.output));
  }
  return bitmap;
}

export function decodeCapabilities(bitmap: bigint): Capability[] {
  if (bitmap < 0n || (bitmap & ~CAPABILITY_MASK) !== 0n) {
    throw new CapabilityEncodingError(
      `capability bitmap outside closed set: 0x${bitmap.toString(16)}`,
    );
  }
  return CAPABILITY_ORDER.filter((_, i) => (bitmap >> BigInt(i)) & 1n);
}

/** Matches OpenZeppelin Strings.toHexString(uint256): 0x-prefixed, byte-aligned, lowercase. */
export function capabilitiesRecordValue(bitmap: bigint): string {
  const hex = bitmap.toString(16);
  return `0x${hex.length % 2 === 0 ? hex : `0${hex}`}`;
}

/** Resolver text keys written by HumanOSRegistrar. Agents may write only STATUS and RECEIPT. */
export const TEXT_KEYS = {
  status: "humanos.status",
  receipt: "humanos.receipt",
  capabilities: "humanos.capabilities",
  root: "humanos.root",
} as const;
export type AgentWritableKey = "status" | "receipt";

/** Official ENSv2 PermissionedRegistry roles (docs.ens.domains/ensv2/permissioned-registry#roles). */
export const REGISTRY_ROLES = {
  REGISTRAR: 1n << 0n,
  REGISTER_RESERVED: 1n << 4n,
  SET_PARENT: 1n << 8n,
  UNREGISTER: 1n << 12n,
  RENEW: 1n << 16n,
  SET_SUBREGISTRY: 1n << 20n,
  SET_RESOLVER: 1n << 24n,
  CAN_TRANSFER_ADMIN: (1n << 28n) << 128n,
  SET_URI: 1n << 36n,
  UPGRADE: 1n << 124n,
} as const;

/** Official ENSv2 PermissionedResolver roles (docs.ens.domains/ensv2/permissioned-resolver#roles). */
export const RESOLVER_ROLES = {
  SET_ADDRESS: 1n << 0n,
  SET_TEXT: 1n << 4n,
  SET_CONTENTHASH: 1n << 8n,
  SET_ABI: 1n << 12n,
  SET_INTERFACE: 1n << 16n,
  SET_NAME: 1n << 20n,
  SET_DATA: 1n << 24n,
  LINK: 1n << 28n,
  CAN_NAME: 1n << 120n,
  UPGRADE: 1n << 124n,
} as const;

export const adminRole = (role: bigint): bigint => role << 128n;
