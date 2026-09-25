import { createPublicClient, http, type Address, type Hex } from "viem";
import { sepolia } from "viem/chains";
import { parseSiweMessage } from "viem/siwe";

export interface SiweVerifier {
  verify(input: {
    message: string;
    signature: string;
  }): Promise<{ address: Address; chainId: number }>;
}

export class SiweVerificationError extends Error {
  constructor(public readonly reason: "invalid_signature" | "unavailable") {
    super(reason);
  }
}

export function isSiweVerificationError(
  error: unknown,
): error is SiweVerificationError {
  return (
    error instanceof Error &&
    "reason" in error &&
    (error.reason === "invalid_signature" || error.reason === "unavailable")
  );
}

export function createSepoliaSiweVerifier(rpcUrl: string): SiweVerifier {
  if (!rpcUrl) throw new Error("SEPOLIA_RPC_URL required");
  const client = createPublicClient({
    chain: sepolia,
    transport: http(rpcUrl),
  });
  return {
    async verify({ message, signature }) {
      const parsed = parseSiweMessage(message);
      if (
        !parsed.address ||
        !parsed.chainId ||
        !/^0x[0-9a-fA-F]+$/.test(signature)
      )
        throw new SiweVerificationError("invalid_signature");
      // viem verifies EOAs, ERC-1271 contracts and undeployed ERC-6492 accounts.
      let valid: boolean;
      try {
        valid = await client.verifySiweMessage({
          message,
          signature: signature as Hex,
        });
      } catch {
        throw new SiweVerificationError("unavailable");
      }
      if (!valid) throw new SiweVerificationError("invalid_signature");
      return { address: parsed.address, chainId: parsed.chainId };
    },
  };
}
