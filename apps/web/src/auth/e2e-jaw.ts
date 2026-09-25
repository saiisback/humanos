/** Browser-test transport only. Vite's e2e mode is never used for production builds. */
import { createSiweMessage } from "viem/siwe";
import type { JawAuthClient, RequestProvider } from "./jaw";
import { JawAuthError } from "./jaw";

declare global {
  interface Window {
    __HUMANOS_E2E__?: {
      jaw?: "success" | "reject";
      world?: "success" | "cancel";
      permission?: "success" | "reject" | "unavailable";
    };
  }
}

export function createE2EJawPermissionProvider(): RequestProvider | null {
  if (window.__HUMANOS_E2E__?.permission === "unavailable") return null;
  return {
    async request({ method, params }) {
      if (window.__HUMANOS_E2E__?.permission === "reject") throw { code: 4001 };
      const first = params?.[0] as Record<string, unknown> | undefined;
      if (method === "wallet_grantPermissions") {
        const permissions = first?.permissions as {
          calls: unknown[];
          spends: unknown[];
        };
        return {
          account: first?.address,
          chainId: first?.chainId,
          spender: first?.spender,
          start: Math.floor(Date.now() / 1000),
          end: first?.expiry,
          salt: "0x01",
          permissionId: `0x${"a".repeat(64)}`,
          calls: permissions.calls,
          spends: permissions.spends.map((spend) => ({
            ...(spend as Record<string, unknown>),
            allowance: "0x64",
          })),
        };
      }
      if (method === "wallet_revokePermissions") return { success: true };
      throw new Error(`Unsupported synthetic JAW method ${method}`);
    },
  };
}

export function createE2EJawClient(): JawAuthClient {
  return {
    async connect(challenge) {
      if (window.__HUMANOS_E2E__?.jaw === "reject")
        throw new JawAuthError("USER_REJECTED");
      return {
        message: createSiweMessage({
          address: `0x${"1".repeat(40)}`,
          chainId: challenge.chainId,
          domain: challenge.domain,
          uri: challenge.uri,
          version: "1",
          nonce: challenge.nonce,
          issuedAt: new Date(),
          expirationTime: new Date(challenge.expiresAt),
          statement: "Sign in to HumanOS",
        }),
        signature: `0x${"a".repeat(130)}`,
      };
    },
    async disconnect() {},
  };
}
