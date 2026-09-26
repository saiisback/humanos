import { expect, it } from "vitest";
import { createUsageContext } from "../src/workflows/usage.js";
it("keeps parallel workflow model callbacks isolated and rejects unscoped events", async () => {
  const saved: string[] = [];
  const usage = createUsageContext(async (context) => { saved.push(context.workflowId); });
  const event = { requestId: "r", attemptId: "a", attempt: 1, provider: "opencode", requestedModel: "jev-1.13", reportedModel: null, status: "started" as const, inputTokens: null, outputTokens: null, cacheReadTokens: null };
  await expect(usage.onAttempt(event)).rejects.toThrow("USAGE_CONTEXT_REQUIRED");
  await Promise.all(["one", "two"].map(workflowId => usage.run({ accountId: "a", workflowId, versionId: "v", runId: null, stepId: null, phase: "planning" }, async () => { await Promise.resolve(); await usage.onAttempt(event); })));
  expect(saved.sort()).toEqual(["one", "two"]);
});
