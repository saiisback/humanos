import { parseAbi } from "viem";

/**
 * Minimal fragments of the official ENSv2 contracts (ensdomains/contracts-v2 @ 71a3b733),
 * matching the signatures documented at docs.ens.domains/ensv2.
 */
export const universalResolverAbi = parseAbi([
  "function findResolver(bytes name) view returns (address resolver, bytes32 node, uint256 offset)",
]);

export const permissionedResolverAbi = parseAbi([
  "function resolve(bytes name, bytes data) view returns (bytes)",
  "function setText(bytes name, string key, string value)",
  "function hasRoles(uint256 resource, uint256 roleBitmap, address account) view returns (bool)",
  "function roles(uint256 resource, address account) view returns (uint256)",
  "error EACUnauthorizedAccountRoles(uint256 resource, uint256 roleBitmap, address account)",
]);

export const textProfileAbi = parseAbi([
  "function text(bytes32 node, string key) view returns (string)",
]);

export const permissionedRegistryAbi = parseAbi([
  "function getSubregistry(string label) view returns (address)",
  "function getExpiry(uint256 anyId) view returns (uint64)",
  "function getOwner(uint256 anyId) view returns (address)",
]);
