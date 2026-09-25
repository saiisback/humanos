import { afterEach, describe, expect, it, vi } from "vitest";
import { createJawAuthClient, createBrowserJawAuthClient } from "./jaw";

const address = "0x1111111111111111111111111111111111111111";
const challenge = {
  challengeId: "challenge-1",
  nonce: "abcdef1234567890",
  domain: "localhost:5173",
  uri: "http://localhost:5173",
  chainId: 11155111,
  expiresAt: "2026-09-25T10:05:00.000Z",
};
function message() {
  return `${challenge.domain} wants you to sign in with your Ethereum account:\n${address}\n\nSign in to HumanOS\n\nURI: ${challenge.uri}\nVersion: 1\nChain ID: 11155111\nNonce: ${challenge.nonce}\nIssued At: 2026-09-25T10:00:00.000Z\nExpiration Time: ${challenge.expiresAt}`;
}

describe("JAW SIWE adapter", () => {
  afterEach(() => vi.useRealTimers());
  it("requests exactly the backend challenge and returns the signed response", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-09-25T10:01:00.000Z"));
    const request = vi.fn().mockResolvedValue({
      accounts: [
        {
          address,
          capabilities: {
            signInWithEthereum: { message: message(), signature: "0x1234" },
          },
        },
      ],
    });
    const client = createJawAuthClient({ request }, async () => {});
    await expect(client.connect(challenge)).resolves.toEqual({
      message: message(),
      signature: "0x1234",
    });
    expect(request).toHaveBeenCalledWith({
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
  });
  it.each([
    ["missing capability", { accounts: [{ address }] }, "MISSING_CAPABILITY"],
    [
      "embedded rejection",
      {
        accounts: [
          {
            address,
            capabilities: {
              signInWithEthereum: { code: 4001, message: "cancelled" },
            },
          },
        ],
      },
      "USER_REJECTED",
    ],
    [
      "ambiguous accounts",
      { accounts: [{ address }, { address }] },
      "INVALID_RESPONSE",
    ],
    [
      "different account",
      {
        accounts: [
          {
            address: "0x2222222222222222222222222222222222222222",
            capabilities: {
              signInWithEthereum: { message: message(), signature: "0x1234" },
            },
          },
        ],
      },
      "ACCOUNT_MISMATCH",
    ],
    [
      "missing SIWE",
      {
        accounts: [
          {
            address,
            capabilities: {
              signInWithEthereum: { message: "nonsense", signature: "0x1234" },
            },
          },
        ],
      },
      "ACCOUNT_MISMATCH",
    ],
  ])("rejects %s", async (_name, response, code) => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-09-25T10:01:00.000Z"));
    const client = createJawAuthClient(
      { request: vi.fn().mockResolvedValue(response) },
      async () => {},
    );
    await expect(client.connect(challenge)).rejects.toMatchObject({ code });
  });
  it("maps a thrown RPC 4001 to user rejection", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-09-25T10:01:00.000Z"));
    const client = createJawAuthClient(
      { request: vi.fn().mockRejectedValue({ code: 4001 }) },
      async () => {},
    );
    await expect(client.connect(challenge)).rejects.toMatchObject({
      code: "USER_REJECTED",
    });
  });
  it("requests fresh SIWE for a returning connection", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-09-25T10:01:00.000Z"));
    const request = vi
      .fn()
      .mockResolvedValue({
        accounts: [
          {
            address,
            capabilities: {
              signInWithEthereum: { message: message(), signature: "0x1234" },
            },
          },
        ],
      });
    const client = createJawAuthClient({ request }, async () => {});
    await client.connect(challenge);
    await client.connect(challenge);
    expect(request).toHaveBeenCalledTimes(2);
    expect(request.mock.calls[1]?.[0].method).toBe("wallet_connect");
  });
  it("does not create JAW without a public key", () => {
    expect(createBrowserJawAuthClient("   ")).toBeNull();
  });
  it.each([
    ["nonce", { ...challenge, nonce: "other" }],
    ["domain", { ...challenge, domain: "other.example" }],
    ["URI", { ...challenge, uri: "https://other.example" }],
    ["chain", { ...challenge, chainId: 1 }],
    ["expiry", { ...challenge, expiresAt: "2026-09-25T10:00:00.000Z" }],
  ])("rejects %s context mismatch", async (_name, changed) => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-09-25T10:01:00.000Z"));
    const client = createJawAuthClient(
      {
        request: vi
          .fn()
          .mockResolvedValue({
            accounts: [
              {
                address,
                capabilities: {
                  signInWithEthereum: {
                    message: message(),
                    signature: "0x1234",
                  },
                },
              },
            ],
          }),
      },
      async () => {},
    );
    await expect(client.connect(changed)).rejects.toMatchObject({
      code: "SIWE_CONTEXT_MISMATCH",
    });
  });
});
