import { afterEach, expect, it, vi } from "vitest";
import { api } from "./api";

afterEach(() => vi.unstubAllGlobals());

it("preserves backend status and error code", async () => {
  vi.stubGlobal(
    "fetch",
    vi.fn().mockResolvedValue({
      ok: false,
      status: 503,
      json: async () => ({
        error: {
          code: "INTEGRATION_UNAVAILABLE",
          message: "Verifier unavailable",
        },
      }),
    }),
  );
  await expect(api("/auth/siwe/nonce", {})).rejects.toMatchObject({
    status: 503,
    code: "INTEGRATION_UNAVAILABLE",
    message: "Verifier unavailable",
  });
});
