import { expect, it } from "vitest";
import { estimateUsage } from "../src/workflows/usage-pricing.js";
it("preserves one-sided reported counts and refuses unknown pricing snapshots", () => {
  const partial = estimateUsage([{ requestedModel: "test", status: "completed", inputTokens: 100, outputTokens: null }]);
  expect(partial.models[0]).toMatchObject({ inputTokens: 100, outputTokens: null });
  expect(estimateUsage([{ provider: "opencode", requestedModel: "jev-1.13", status: "completed", inputTokens: 100, outputTokens: 0, pricingDate: "unknown" }]).knownModelCostUsd).toBeNull();
});
it("prices reported tokens while missing attempts make totals partial", () => {
  const summary = estimateUsage([{ pricingDate: "2026-09-27", provider: "opencode", requestedModel: "deepseek-v4.1-flash", status: "completed", inputTokens: 1000000, outputTokens: 500000, cacheReadTokens: 0, attempt: 1 }, { status: "unknown", requestedModel: "jev-1.13", inputTokens: null, outputTokens: null, attempt: 2 }]);
  expect(summary.knownModelCostUsd).toBeCloseTo(0.9);
  expect(summary.complete).toBe(false);
  expect(summary.unknownAttempts).toBe(1);
  expect(summary.retries).toBe(1);
  expect(summary.comparisons[0]?.costUsd).toBeNull();
});
it("does not reconstruct historical usage or treat missing cache data as full billing evidence", () => {
  expect(estimateUsage([]).knownModelCostUsd).toBeNull();
  expect(estimateUsage([{ provider: "opencode", requestedModel: "deepseek-v4.1-flash", status: "completed", inputTokens: 5, outputTokens: 2, cacheReadTokens: null }]).complete).toBe(false);
});
it("discounts cached input once and compares uncached API token equivalents", () => {
  const s = estimateUsage([{ pricingDate: "2026-09-27", provider: "opencode", requestedModel: "deepseek-v4.1-flash", status: "completed", inputTokens: 1000000, outputTokens: 0, cacheReadTokens: 1000000 }]);
  expect(s.knownModelCostUsd).toBe(0.006);
  expect(s.comparisons[0]?.costUsd).toBe(8);
  expect(s.comparisons[1]?.costUsd).toBe(3);
});
it("compares short requests with GPT-5.6 Sol and Sonnet using reported token volume", () => {
  const s = estimateUsage([{ pricingDate: "2026-09-27", provider: "opencode", requestedModel: "deepseek-v4.1-flash", status: "completed", inputTokens: 262, outputTokens: 240, cacheReadTokens: 0 }]);
  expect(s.comparisons[0]).toMatchObject({ model: "GPT-5.6 Sol", costUsd: 0.005848 });
  expect(s.comparisons[1]?.costUsd).toBe(0.004386);
});
