import { createPublicClient, http, type Address, type Hex } from "viem";
import { sepolia } from "viem/chains";
import { parseSiweMessage } from "viem/siwe";

export interface SiweVerifier {
  verify(input: {
    message: string;
    signature: string;
  }): Promise<{ address: Address; chainId: number }>;
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
        throw new Error("INVALID_SIWE_MESSAGE");
      // viem verifies EOAs, ERC-1271 contracts and undeployed ERC-6492 accounts.
      if (
        !(await client.verifySiweMessage({
          message,
          signature: signature as Hex,
        }))
      )
        throw new Error("INVALID_SIGNATURE");
      return { address: parsed.address, chainId: parsed.chainId };
    },
  };
}
