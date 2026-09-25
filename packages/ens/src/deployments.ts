import type { Address } from "viem";

/**
 * Official ENSv2 Sepolia deployment, verified on-chain against the pinned artifacts.
 * Source of truth: packages/contracts/deployments/ensv2-sepolia.json (test-enforced equality).
 */
export const ENSV2_SEPOLIA = {
  chainId: 11155111,
  sourceCommit: "71a3b7339dbc55ab47667abdfe8303bac4f4c24e",
  RootRegistry: "0x9703dbd26dab89504490994138cf2c575251a9ce",
  ETHRegistry: "0x657ea849311d3d5823348dded7c2aaafb3ede09e",
  VerifiableFactory: "0x9e726eb570beb6bceb495ab8cda7df517d4e841c",
  PermissionedResolverImpl: "0x14f09fd05d4585759e54844dc9b00147131cf243",
  UserRegistryImpl: "0xa80338aaa8d23831cea25e858d1774534abb0263",
  UniversalResolverV2: "0x5d25c1d6acbb71b7a28aa7899618a3412a8303e3",
  /** Canonical, DAO-owned Universal Resolver entry point (proxy). */
  UpgradableUniversalResolverProxy:
    "0xeEeEEEeE14D718C2B47D9923Deab1335E144EeEe",
} as const satisfies Record<string, Address | number | string>;
