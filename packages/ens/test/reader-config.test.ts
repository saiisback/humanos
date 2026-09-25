import { it, expect } from "vitest";
import { createPublicClient, http, type PublicClient } from "viem";
import { createAuthorizationReader } from "../src/authorize.js";
const config = {
  client: createPublicClient({
    transport: http("http://localhost:1"),
  }) as PublicClient,
  chainId: 1,
  registrar: "0x0000000000000000000000000000000000000001" as const,
  universalResolver: "0x0000000000000000000000000000000000000002" as const,
};
it.each([NaN, Infinity, -1])(
  "rejects unbounded freshness setting %s",
  (value) => {
    expect(() =>
      createAuthorizationReader({ ...config, maxLatestHeadAgeMs: value }),
    ).toThrow();
    expect(() =>
      createAuthorizationReader({
        ...config,
        maxLatestHeadFutureSkewMs: value,
      }),
    ).toThrow();
  },
);
it.each([NaN, Infinity, 0, -1, 1.5, 100])(
  "requires bounded integer retry budget %s",
  (value) => {
    expect(() =>
      createAuthorizationReader({ ...config, maxHeadMoveRetries: value }),
    ).toThrow();
  },
);
