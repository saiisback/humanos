import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { expect, it } from "vitest";
import { UsageFooter } from "./usage-footer";
it("explains absent historical telemetry instead of drawing empty comparison bars", () => {
  const html = renderToStaticMarkup(
    <UsageFooter
      summary={{
        pricingDate: "2026-09-27",
        complete: false,
        attempts: 0,
        retries: 0,
        unknownAttempts: 0,
        knownModelCostUsd: null,
        models: [],
        comparisons: [],
      }}
    />,
  );
  expect(html).toContain("No token usage was recorded for this run");
  expect(html).not.toContain("usage-chart-track");
  expect(html).not.toContain("$0");
});
it("shows recorded tokens even when pricing is unavailable", () => {
  const html = renderToStaticMarkup(
    <UsageFooter
      summary={{
        pricingDate: "2026-09-27",
        complete: false,
        attempts: 1,
        retries: 0,
        unknownAttempts: 1,
        knownModelCostUsd: null,
        models: [
          {
            model: "unknown-model",
            inputTokens: 123,
            outputTokens: 45,
            attempts: 1,
            unknownAttempts: 0,
          },
        ],
        comparisons: [],
      }}
    />,
  );
  expect(html).toContain("123 input / 45 output tokens recorded");
  expect(html).toContain("A cost estimate is unavailable");
  expect(html).not.toContain("usage-chart-track");
});
it("does not show missing historical usage as free", () => {
  const html = renderToStaticMarkup(<UsageFooter />);
  expect(html).toContain("Usage unavailable");
  expect(html).not.toContain("$0");
});
it("renders proportional bars and keeps token detail collapsed", () => {
  const html = renderToStaticMarkup(
    <UsageFooter
      summary={{
        pricingDate: "2026-09-27",
        complete: true,
        attempts: 1,
        retries: 0,
        unknownAttempts: 0,
        knownModelCostUsd: 0.001,
        models: [],
        comparisons: [
          {
            model: "GPT-5.6 Sol",
            costUsd: 0.004,
            source: "https://developers.openai.com/api/docs/models/gpt-5.6-sol",
          },
          {
            model: "Claude Sonnet 4.6",
            costUsd: 0.003,
            source: "https://platform.claude.com/docs/en/about-claude/pricing",
          },
        ],
      }}
    />,
  );
  expect(html).toContain('aria-label="Estimated model cost comparison"');
  expect(html).toContain("width:25%");
  expect(html).toContain("width:100%");
  expect(html).toContain("width:75%");
  expect(html).toContain("HumanOS");
  expect(html).toContain("Same-token cost estimate—not a same-task benchmark.");
  expect(html).not.toContain('open=""');
});
it("shows partial costs, provider tokens and qualified comparisons", () => {
  const html = renderToStaticMarkup(
    <UsageFooter
      summary={{
        pricingDate: "2026-09-27",
        complete: false,
        attempts: 2,
        retries: 1,
        unknownAttempts: 1,
        knownModelCostUsd: 0.002,
        models: [
          {
            model: "deepseek-v4.1-flash",
            inputTokens: 50,
            outputTokens: 20,
            attempts: 2,
            unknownAttempts: 1,
          },
        ],
        comparisons: [
          {
            model: "GPT-4.1 mini",
            costUsd: null,
            source:
              "https://developers.openai.com/api/docs/models/gpt-4.1-mini",
          },
        ],
      }}
    />,
  );
  expect(html).toContain("partial");
  expect(html).toContain("50 input");
  expect(html).toContain("20 output");
  expect(html).toContain(
    "Equivalent-token API estimate, not a measured same-task run",
  );
  expect(html).toContain("1 unknown");
  expect(html).not.toContain("saved");
});
