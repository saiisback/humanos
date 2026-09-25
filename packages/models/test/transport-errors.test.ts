import { expect, it, vi } from "vitest";
import { requestJson } from "../src/transport.js";

it.each([
  [401, "MODEL_AUTH_FAILED"],
  [403, "MODEL_AUTH_FAILED"],
  [402, "MODEL_CREDITS_REQUIRED"],
  [429, "MODEL_RATE_LIMITED"],
  [503, "MODEL_UNAVAILABLE"],
])(
  "classifies HTTP %s without exposing provider response contents",
  async (status, code) => {
    const transport = vi.fn(
      async () => new Response("private-provider-details", { status }),
    );
    await expect(
      requestJson(
        { apiKey: "test-only", retries: 0, fetch: transport },
        "https://example.invalid",
        {},
      ),
    ).rejects.toMatchObject({ code, message: "Model integration unavailable" });
    expect(transport).toHaveBeenCalledTimes(1);
  },
);

it("reports a bounded timeout instead of leaving the request pending", async () => {
  await expect(
    requestJson(
      {
        apiKey: "test-only",
        timeoutMs: 5,
        retries: 0,
        fetch: () => new Promise(() => {}),
      },
      "https://example.invalid",
      {},
    ),
  ).rejects.toMatchObject({ code: "MODEL_TIMEOUT" });
});
