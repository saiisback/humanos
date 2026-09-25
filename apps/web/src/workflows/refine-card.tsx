import { useEffect, useState } from "react";
import type { JsonValue, WorkflowVersion } from "@humanos/schemas";

const checkText: Record<string, string> = {
  needs_review: "Jev flagged the request for human review.",
  confidence: "Jev wasn’t confident which audited step fits.",
  alignment: "The proposed step might not match what you asked for.",
  risk: "The proposed step looked too risky for this request.",
  injection: "Part of the request looked like instructions aimed at the planner.",
};
/** What the audited catalog can do today; kept honest rather than aspirational. */
export const supportedScope = [
  "Write or rewrite text: drafts, summaries, plans (DeepSeek writes, nothing is sent).",
  "Sourced research, then a written result (needs Brave Search connected).",
  "Email to exactly one recipient you name, sent only after your exact final confirmation (needs Resend connected).",
  "Bookings, purchases, and site submissions: only on an audited site, and none is installed yet.",
];
const record = (value: JsonValue | undefined) => value && typeof value === "object" && !Array.isArray(value) ? value : null;

export interface PlanStatus {
  kind: "unprepared" | "review" | "no_candidates" | "clarify";
  checks: string[];
  reasonCodes: string[];
  prompt: string | null;
}
export function planStatus(version: WorkflowVersion): PlanStatus | null {
  const nodes = version.graph.nodes;
  if (nodes.length === 1 && nodes[0]!.type === "human.input")
    return { kind: "clarify", checks: [], reasonCodes: [], prompt: typeof nodes[0]!.input.prompt === "string" ? nodes[0]!.input.prompt : null };
  if (nodes.length) return null;
  const assembly = record(record(version.normalizedIntent as JsonValue)?.assembly);
  const strings = (value: JsonValue | undefined) => Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : [];
  if (assembly?.outcome === "REVIEW_REQUIRED")
    return { kind: "review", checks: strings(assembly.failedChecks).filter(check => check in checkText), reasonCodes: strings(assembly.reasonCodes).slice(0, 8), prompt: null };
  if (assembly?.outcome === "NO_CANDIDATES") return { kind: "no_candidates", checks: [], reasonCodes: [], prompt: null };
  return { kind: "unprepared", checks: [], reasonCodes: [], prompt: null };
}

export function RefineCard({ version, busy, onRefine, onRetry }: { version: WorkflowVersion; busy: boolean; onRefine(goal: string): void; onRetry(): void }) {
  const status = planStatus(version);
  const [text, setText] = useState(version.goal);
  useEffect(() => { setText(version.goal); }, [version.id]);
  if (!status) return null;
  const changed = text.trim() && text.trim() !== version.goal.trim();
  return <section className="workflow-card" aria-label="Refine request">
    <span className="eyebrow">Saved · nothing has run</span>
    <h2>{status.kind === "review" ? "Jev asked for a clearer request" : status.kind === "no_candidates" ? "No audited step fits yet" : status.kind === "clarify" ? "One more detail is needed" : "Request saved"}</h2>
    {status.kind === "clarify" && status.prompt && <p>{status.prompt}</p>}
    {status.kind === "unprepared" && <p>Create a plan from the registered, audited steps.</p>}
    {status.checks.length > 0 && <ul className="workflow-diagnostics">{status.checks.map(check => <li key={check}>{checkText[check]}</li>)}</ul>}
    {status.reasonCodes.length > 0 && <p className="fine">Jev’s notes: {status.reasonCodes.map(code => <code key={code}>{code}</code>)}</p>}
    <label className="workflow-refine">
      <span>Your request</span>
      <textarea value={text} maxLength={10000} rows={3} onChange={event => setText(event.target.value)} disabled={busy} />
    </label>
    <div className="workflow-actions">
      <button disabled={busy || !changed} onClick={() => onRefine(text.trim())}>Update & prepare</button>
      {status.kind !== "clarify" && <button className="secondary" disabled={busy} onClick={onRetry}>{status.kind === "unprepared" ? "Prepare workflow" : "Try again as is"}</button>}
    </div>
    <details className="workflow-scope"><summary>What HumanOS can do today</summary><ul>{supportedScope.map(item => <li key={item}>{item}</li>)}</ul></details>
  </section>;
}
