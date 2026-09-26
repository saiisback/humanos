import type { WorkflowUsageSummary } from "@humanos/schemas";
export const PRICING_DATE = "2026-09-27";
// Immutable snapshot, USD/million tokens; official sources in docs/model-pricing-sources.md.
const prices: Record<string, { input: number; output: number; cache?: number }> = {
  "deepseek-v4.1-flash": { input: 0.30, output: 1.20, cache: 0.006 },
  "jev-1.13": { input: 0.042, output: 0 },
};
const count = (x: unknown): x is number => typeof x === "number" && Number.isSafeInteger(x) && x >= 0;
export function estimateUsage(events: Record<string, unknown>[]): WorkflowUsageSummary {
  const models = new Map<string, WorkflowUsageSummary["models"][number]>();
  let unknownAttempts = 0, subtotal = 0, priced = 0, retries = 0, input = 0, output = 0, gptCost = 0;
  for (const e of events) {
    const model = typeof e.requestedModel === "string" ? e.requestedModel : "unknown";
    const row = models.get(model) ?? { model, inputTokens: null, outputTokens: null, attempts: 0, unknownAttempts: 0 };
    row.attempts++;
    if (typeof e.attempt === "number" && e.attempt > 1) retries++;
    const tokensKnown = e.status === "completed" && count(e.inputTokens) && count(e.outputTokens);
    if (tokensKnown) {
      const longContext = (e.inputTokens as number) > 272000;
      gptCost += ((e.inputTokens as number) * (longContext ? 8 : 4) + (e.outputTokens as number) * (longContext ? 30 : 20)) / 1e6;
    }
    if (count(e.inputTokens)) { row.inputTokens = (row.inputTokens ?? 0) + e.inputTokens; input += e.inputTokens; }
    if (count(e.outputTokens)) { row.outputTokens = (row.outputTokens ?? 0) + e.outputTokens; output += e.outputTokens; }
    if (!tokensKnown) row.unknownAttempts++;
    // This snapshot is immutable. Unknown future versions must not be repriced.
    const rate = e.provider === "opencode" && e.pricingDate === PRICING_DATE ? prices[model] : undefined;
    const cache = e.cacheReadTokens;
    const cacheKnown = rate?.cache === undefined || count(cache) && count(e.inputTokens) && cache <= e.inputTokens;
    if (tokensKnown && rate && cacheKnown) {
      const cached = rate.cache === undefined ? 0 : cache as number;
      subtotal += (((e.inputTokens as number) - cached) * rate.input + cached * (rate.cache ?? 0) + (e.outputTokens as number) * rate.output) / 1e6;
      priced++;
    } else unknownAttempts++;
    models.set(model, row);
  }
  const complete = events.length > 0 && unknownAttempts === 0;
  return { pricingDate: PRICING_DATE, complete, attempts: events.length, retries, unknownAttempts, knownModelCostUsd: priced ? subtotal : null,
    models: [...models.values()], comparisons: [
      { model: "GPT-5.6 Sol", costUsd: complete ? gptCost : null, source: "https://developers.openai.com/api/docs/models/gpt-5.6-sol" },
      { model: "Claude Sonnet 4.6", costUsd: complete ? (input * 3 + output * 15) / 1e6 : null, source: "https://platform.claude.com/docs/en/about-claude/pricing" },
    ] };
}
