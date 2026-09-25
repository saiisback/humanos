import { afterEach, expect, it, vi } from "vitest";
import { api } from "../lib/api";
afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
});
it("ends a stalled request without retrying a potentially completed mutation", async () => {
  vi.useFakeTimers();
  const transport = vi.fn(
    (_url: unknown, options: RequestInit) =>
      new Promise((_resolve, reject) => {
        options.signal?.addEventListener("abort", () =>
          reject(new DOMException("aborted", "AbortError")),
        );
      }),
  );
  vi.stubGlobal("fetch", transport);
  const result = api("/missions", { goal: "Draft" });
  const assertion = expect(result).rejects.toMatchObject({
    code: "REQUEST_TIMEOUT",
  });
  await vi.advanceTimersByTimeAsync(60000);
  await assertion;
  expect(transport).toHaveBeenCalledTimes(1);
});
it("reports a timeout while reading the response body instead of returning empty success", async () => {
  vi.useFakeTimers();
  vi.stubGlobal(
    "fetch",
    vi.fn(async (_url: unknown, options: RequestInit) => ({
      ok: true,
      json: () =>
        new Promise((_resolve, reject) => {
          options.signal?.addEventListener("abort", () =>
            reject(new DOMException("aborted", "AbortError")),
          );
        }),
    })),
  );
  const assertion = expect(api("/missions")).rejects.toMatchObject({
    code: "REQUEST_TIMEOUT",
  });
  await vi.advanceTimersByTimeAsync(60000);
  await assertion;
});
