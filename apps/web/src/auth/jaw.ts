import { JAW } from "@jaw.id/core";
import type { CreateSiweChallengeResponse } from "@humanos/schemas";
import { normalizeWalletAddress } from "@humanos/schemas";
import { parseSiweMessage } from "viem/siwe";

export type JawAuthErrorCode =
  | "UNAVAILABLE"
  | "USER_REJECTED"
  | "MISSING_CAPABILITY"
  | "INVALID_RESPONSE"
  | "ACCOUNT_MISMATCH"
  | "SIWE_CONTEXT_MISMATCH";

export class JawAuthError extends Error {
  constructor(public readonly code: JawAuthErrorCode) {
    super(
      {
        UNAVAILABLE: "JAW account sign-in is unavailable.",
        USER_REJECTED: "Passkey sign-in was cancelled.",
        MISSING_CAPABILITY: "JAW did not return a SIWE signature.",
        INVALID_RESPONSE: "JAW returned an invalid sign-in response.",
        ACCOUNT_MISMATCH: "JAW returned a different account than the signer.",
        SIWE_CONTEXT_MISMATCH:
          "The signed challenge does not match this session.",
      }[code],
    );
    this.name = "JawAuthError";
  }
}

export interface JawAuthClient {
  connect(
    challenge: CreateSiweChallengeResponse,
  ): Promise<{ message: string; signature: string }>;
  disconnect(): Promise<void>;
}

interface RequestProvider {
  request(args: { method: string; params?: unknown[] }): Promise<unknown>;
}

function record(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function rejected(value: unknown): boolean {
  const error = record(value);
  return (
    error?.code === 4001 ||
    error?.code === "4001" ||
    record(error?.error)?.code === 4001
  );
}

function normalized(address: unknown): string | null {
  if (typeof address !== "string") return null;
  try {
    return normalizeWalletAddress(address);
  } catch {
    return null;
  }
}

export function createJawAuthClient(
  provider: RequestProvider,
  disconnect: () => Promise<void>,
): JawAuthClient {
  return {
    async connect(challenge) {
      if (
        challenge.chainId !== 11155111 ||
        !challenge.nonce ||
        !challenge.domain ||
        !challenge.uri ||
        !Number.isFinite(Date.parse(challenge.expiresAt)) ||
        Date.parse(challenge.expiresAt) <= Date.now()
      )
        throw new JawAuthError("SIWE_CONTEXT_MISMATCH");
      let response: unknown;
      try {
        response = await provider.request({
          method: "wallet_connect",
          params: [
            {
              capabilities: {
                signInWithEthereum: {
                  nonce: challenge.nonce,
                  chainId: "0xaa36a7",
                  domain: challenge.domain,
                  uri: challenge.uri,
                  statement: "Sign in to HumanOS",
                  expirationTime: challenge.expiresAt,
                },
              },
            },
          ],
        });
      } catch (error) {
        if (rejected(error)) throw new JawAuthError("USER_REJECTED");
        throw error;
      }
      const accounts = record(response)?.accounts;
      if (
        !Array.isArray(accounts) ||
        accounts.length !== 1 ||
        !record(accounts[0])
      )
        throw new JawAuthError("INVALID_RESPONSE");
      const account = record(accounts[0])!;
      const capability = record(
        record(account.capabilities)?.signInWithEthereum,
      );
      if (!capability) throw new JawAuthError("MISSING_CAPABILITY");
      if (rejected(capability)) throw new JawAuthError("USER_REJECTED");
      const { message, signature } = capability;
      if (
        typeof message !== "string" ||
        typeof signature !== "string" ||
        !/^0x(?:[\da-fA-F]{2})+$/.test(signature)
      )
        throw new JawAuthError("INVALID_RESPONSE");
      let parsed: ReturnType<typeof parseSiweMessage>;
      try {
        parsed = parseSiweMessage(message);
      } catch {
        throw new JawAuthError("INVALID_RESPONSE");
      }
      const returnedAddress = normalized(account.address);
      const signedAddress = normalized(parsed.address);
      if (
        !returnedAddress ||
        !signedAddress ||
        returnedAddress !== signedAddress
      )
        throw new JawAuthError("ACCOUNT_MISMATCH");
      if (
        !parsed.issuedAt ||
        !Number.isFinite(parsed.issuedAt.getTime()) ||
        parsed.issuedAt.getTime() > Date.now() ||
        parsed.version !== "1" ||
        parsed.nonce !== challenge.nonce ||
        parsed.domain !== challenge.domain ||
        parsed.uri !== challenge.uri ||
        parsed.chainId !== challenge.chainId ||
        parsed.statement !== "Sign in to HumanOS" ||
        parsed.expirationTime?.getTime() !== Date.parse(challenge.expiresAt) ||
        parsed.expirationTime.getTime() <= Date.now() ||
        (parsed.notBefore && parsed.notBefore.getTime() > Date.now()) ||
        (parsed.scheme &&
          parsed.scheme !== new URL(challenge.uri).protocol.slice(0, -1))
      )
        throw new JawAuthError("SIWE_CONTEXT_MISMATCH");
      return { message, signature };
    },
    disconnect,
  };
}

let browserClient: JawAuthClient | null = null;
export function createBrowserJawAuthClient(
  apiKey: string,
  logoUrl?: string,
): JawAuthClient | null {
  if (!apiKey.trim()) return null;
  if (!browserClient) {
    const options: Parameters<typeof JAW.create>[0] = {
      apiKey: apiKey.trim(),
      appName: "HumanOS",
      defaultChainId: 11155111,
      preference: { showTestnets: true, transportMode: "auto" },
    };
    if (logoUrl?.trim()) {
      try {
        const url = new URL(logoUrl.trim());
        if (url.protocol === "https:") options.appLogoUrl = url.href;
      } catch {
        /* No logo. */
      }
    }
    const jaw = JAW.create(options);
    browserClient = createJawAuthClient(jaw.provider, () => jaw.disconnect());
  }
  return browserClient;
}
