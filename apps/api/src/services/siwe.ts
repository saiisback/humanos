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
  return {
    async verify({ message, signature }) {
      const parsed = parseSiweMessage(message);
      if (
        !parsed.address ||
        !parsed.chainId ||
        !/^0x[0-9a-fA-F]+$/.test(signature)
      )
        throw new SiweVerificationError("invalid_signature");
      let transportFailed = false;
      const client = createPublicClient({
        chain: sepolia,
        transport: http(rpcUrl, {
          fetchFn: async (input, init) => {
            try {
              const response = await fetch(input, init);
              if (!response.ok) transportFailed = true;
              return response;
            } catch (error) {
              transportFailed = true;
              throw error;
            }
          },
        }),
      });
      async function requireSepoliaRpc(): Promise<void> {
        let chainId: number;
        try {
          chainId = await client.getChainId();
        } catch {
          throw new SiweVerificationError("unavailable");
        }
        if (chainId !== sepolia.id)
          throw new SiweVerificationError("unavailable");
      }
      await requireSepoliaRpc();
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
      if (!valid) {
        if (transportFailed) throw new SiweVerificationError("unavailable");
        // viem can turn a failed ERC-6492 eth_call into false. Probe the RPC
        // again so a transport outage cannot be reported as a bad signature.
        await requireSepoliaRpc();
        if (transportFailed) throw new SiweVerificationError("unavailable");
        throw new SiweVerificationError("invalid_signature");
      }
      return { address: parsed.address, chainId: parsed.chainId };
    },
  };
}
