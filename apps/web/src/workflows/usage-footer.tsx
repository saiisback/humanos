import React from "react";
import type { WorkflowUsageSummary } from "@humanos/schemas";

const dollars = (value: number) =>
  value > 0 && value < 0.000001 ? "<$0.000001" : `$${value.toFixed(6)}`;
export function UsageFooter({
  summary,
}: {
  summary?: WorkflowUsageSummary | undefined;
}) {
  if (!summary)
    return <p className="fine">Usage unavailable for this response.</p>;
  if (summary.attempts === 0)
    return (
      <section className="usage-footer" aria-label="Model usage">
        <h3>Token usage</h3>
        <p>No token usage was recorded for this run.</p>
        <p className="fine">
          This may be an older run or a run with no model calls. Missing records
          cannot be reconstructed from the answer, so no cost or savings
          estimate is shown. Do not repeat an external action just to obtain
          usage numbers.
        </p>
      </section>
    );
  const rows = [
    { model: "HumanOS", costUsd: summary.knownModelCostUsd, source: null },
    ...summary.comparisons,
  ];
  const maximum = Math.max(0, ...rows.map((row) => row.costUsd ?? 0));
  const input = summary.models.reduce<number | null>(
    (total, model) =>
      model.inputTokens === null ? total : (total ?? 0) + model.inputTokens,
    null,
  );
  const output = summary.models.reduce<number | null>(
    (total, model) =>
      model.outputTokens === null ? total : (total ?? 0) + model.outputTokens,
    null,
  );
  const partial = summary.models.some((model) => model.unknownAttempts > 0);
  const priced = rows.some((row) => row.costUsd !== null);
  return (
    <section className="usage-footer" aria-label="Model usage">
      <h3>Cost at a glance</h3>
      <p>{`${input ?? "Unknown"} input / ${output ?? "unknown"} output tokens recorded${partial ? " (partial)" : ""}`}</p>
      {!priced && (
        <p className="fine">
          A cost estimate is unavailable.{" "}
          {input !== null || output !== null
            ? "Reported token counts are retained, but pricing or usage details are incomplete."
            : "The model attempts were recorded, but the provider did not return usable token counts."}
        </p>
      )}
      {priced && (
        <div
          className="usage-chart"
          role="group"
          aria-label="Estimated model cost comparison"
        >
          {rows.map((row, index) => (
            <div className="usage-chart-row" key={row.model}>
              <div className="usage-chart-label">
                <span>{row.model}</span>
                <span>
                  {row.costUsd === null ? "Unavailable" : dollars(row.costUsd)}
                  {index === 0 && !summary.complete && row.costUsd !== null
                    ? " (partial)"
                    : ""}
                </span>
              </div>
              <div className="usage-chart-track" aria-hidden="true">
                {row.costUsd !== null && (
                  <div
                    className={`usage-chart-bar${index === 0 ? " usage-chart-bar-own" : ""}`}
                    style={{
                      width: `${maximum > 0 ? (row.costUsd / maximum) * 100 : 0}%`,
                    }}
                  />
                )}
              </div>
            </div>
          ))}
        </div>
      )}
      {priced && (
        <p className="fine usage-chart-note">
          Same-token cost estimate—not a same-task benchmark. USD · model
          charges only.
        </p>
      )}
      <details className="task-details">
        <summary>Tokens, rates &amp; details</summary>
        <p className="fine">
          {summary.attempts} attempts · {summary.retries} transport retries ·{" "}
          {summary.unknownAttempts} unknown costs. Rates dated{" "}
          {summary.pricingDate}. Content-recovery calls count as separate
          attempts.
        </p>
        {summary.models.map((model) => (
          <p className="fine" key={model.model}>
            {model.model}: {model.inputTokens ?? "unavailable"} input ·{" "}
            {model.outputTokens ?? "unavailable"} output tokens reported ·{" "}
            {model.unknownAttempts} attempts without complete usage. Reported
            totals may be partial.
          </p>
        ))}
        <p className="fine">
          Equivalent-token API estimate, not a measured same-task run. API
          prices are not ChatGPT or Claude subscription prices.
        </p>
        {summary.comparisons.map((model) => (
          <p className="fine" key={model.model}>
            <a href={model.source} target="_blank" rel="noopener noreferrer">
              {model.model} pricing source
            </a>
          </p>
        ))}
        <p className="fine">
          Search, email, browser and network fees are not included; their costs
          are unavailable here. This is not a provider invoice.
        </p>
      </details>
    </section>
  );
}
