export interface ModelUsageAttempt {
  requestId: string;
  attemptId: string;
  attempt: number;
  provider: string;
  requestedModel: string;
  reportedModel: string | null;
  status: "started" | "completed" | "failed" | "unknown";
  inputTokens: number | null;
  outputTokens: number | null;
  cacheReadTokens: number | null;
}
const object = (value: unknown): Record<string, unknown> =>
  value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
const count = (value: unknown): number | null =>
  typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : null;
export function reportedUsage(raw: unknown) {
  const response = object(raw);
  const usage = object(response.usage);
  return {
    reportedModel: typeof response.model === "string" && response.model.length < 200 ? response.model : null,
    inputTokens: count(usage.input_tokens ?? usage.prompt_tokens),
    outputTokens: count(usage.output_tokens ?? usage.completion_tokens),
    cacheReadTokens: count(object(usage.prompt_tokens_details).cached_tokens ?? usage.cache_read_input_tokens),
  };
}
