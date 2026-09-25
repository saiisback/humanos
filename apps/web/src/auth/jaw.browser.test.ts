import { afterEach, expect, it, vi } from "vitest";
import { JAW } from "@jaw.id/core";
import { createBrowserJawAuthClient } from "./jaw";

vi.mock("@jaw.id/core", () => ({ JAW: { create: vi.fn() } }));

afterEach(() => vi.useRealTimers());

it("uses each fresh JAW provider after a completed connect and logout", async () => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date("2026-09-25T10:01:00.000Z"));
  const address = "0x1111111111111111111111111111111111111111";
  const challenge = {
    challengeId: "c1",
    nonce: "abcdef1234567890",
    domain: "localhost:5173",
    uri: "http://localhost:5173",
    chainId: 11155111,
    expiresAt: "2026-09-25T10:05:00.000Z",
  };
  const message = `${challenge.domain} wants you to sign in with your Ethereum account:\n${address}\n\nSign in to HumanOS\n\nURI: ${challenge.uri}\nVersion: 1\nChain ID: 11155111\nNonce: ${challenge.nonce}\nIssued At: 2026-09-25T10:00:00.000Z\nExpiration Time: ${challenge.expiresAt}`;
  const providers: Array<{
    request: (args: unknown) => Promise<unknown>;
    disconnect: () => Promise<void>;
  }> = [];
  let current: (typeof providers)[number] | null = null;
  const wrapper = {
    get provider() {
      if (!current) {
        current = {
          request: vi.fn(async (_args: unknown) => ({
            accounts: [
              {
                address,
                capabilities: {
                  signInWithEthereum: { message, signature: "0x1234" },
                },
              },
            ],
          })),
          disconnect: vi.fn(async () => {}),
        };
        providers.push(current);
      }
      return current;
    },
    async disconnect() {
      if (current) {
        await current.disconnect();
        current = null;
      }
    },
  };
  vi.mocked(JAW.create).mockReturnValue(
    wrapper as unknown as ReturnType<typeof JAW.create>,
  );

  const client = createBrowserJawAuthClient("test-public-key");
  expect(client).not.toBeNull();
  await client!.connect(challenge);
  await client!.disconnect();
  await client!.connect(challenge);
  await client!.disconnect();

  expect(JAW.create).toHaveBeenCalledTimes(1);
  expect(providers).toHaveLength(2);
  expect(providers[0]?.request).toHaveBeenCalledTimes(1);
  expect(providers[1]?.request).toHaveBeenCalledTimes(1);
  expect(providers[0]?.disconnect).toHaveBeenCalledTimes(1);
  expect(providers[1]?.disconnect).toHaveBeenCalledTimes(1);
});
