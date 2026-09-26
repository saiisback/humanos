import React from "react";
import type { JsonValue, WorkflowVersion } from "@humanos/schemas";
export const blockLabel: Record<string, string> = { "research.web": "Research trusted sources", "content.generate": "Write with DeepSeek", "content.transform": "Refine the content", "human.confirm": "Your final confirmation", "connector.call": "Send through your connected service", "human.input": "A detail is needed", "browser.navigate": "Open the approved website", "browser.extract": "Read page details", "browser.fill": "Prepare the form", "browser.submit": "Submit the reviewed form" };
export function WorkflowReview({ version, busy, onRun, startControl }: { version: WorkflowVersion; busy: boolean; onRun(): void; startControl?: React.ReactNode }) {
  const availabilityOnly = version.graph.nodes.length > 0 && version.graph.nodes.every(node => node.type === "browser.availability");
  return <section className="workflow-card" aria-label="Workflow review">
    <span className="eyebrow">Jev · deterministic blocks</span>
    <h2>Plan ready for review</h2>
    <ol className="workflow-steps">{version.graph.nodes.map(node => <li key={node.id}><span>{node.type === "browser.availability" ? "Check restaurant availability" : blockLabel[node.type] ?? node.type.replaceAll(".", " ")}</span></li>)}</ol>
    {version.requiredCapabilities.length > 0 && <p className="fine">Permissions: {version.requiredCapabilities.join(" · ")}</p>}
    <p className="fine">{availabilityOnly ? "This run checks your exact restaurant, date, time and party size through your ENS agent. It will not book a table or send your contact details. Automatic reservation submission is not enabled yet." : "No external action has been taken. Sending or submitting will pause for your exact final confirmation."}</p>
    {startControl ?? <button onClick={onRun} disabled={busy}>{version.activatedAt ? "Run again" : "Review & run"}</button>}
  </section>;
}
const record = (value: JsonValue | undefined): Record<string, JsonValue> | null =>
  value && typeof value === "object" && !Array.isArray(value) ? value : null;
/** Renders the server-prepared material exactly; unknown shapes fall back to the full JSON. */
export function ConfirmationPreview({ value }: { value: JsonValue }) {
  const prepared = record(value), payload = record(prepared?.payload), binding = record(prepared?.binding);
  const args = record(payload?.arguments) ?? record(payload?.fields) ?? null;
  if (!prepared || typeof prepared.destination !== "string" || !payload) return <OutputView value={value} />;
  return <dl className="workflow-exact">
    <dt>Destination</dt><dd className="hash">{prepared.destination}</dd>
    {typeof binding?.workspace === "string" && <><dt>Workspace</dt><dd>{binding.workspace}</dd></>}
    {typeof binding?.team === "string" && <><dt>Linear team</dt><dd>{binding.team}</dd></>}
    {typeof binding?.sender === "string" && <><dt>Sent as</dt><dd className="hash">{binding.sender}</dd></>}
    {args ? Object.entries(args).map(([key, entry]) => <React.Fragment key={key}><dt>{key}</dt><dd className="workflow-output">{typeof entry === "string" ? entry : JSON.stringify(entry)}</dd></React.Fragment>)
      : <><dt>Payload</dt><dd><OutputView value={payload} /></dd></>}
    {args && Object.entries(payload).filter(([key]) => key !== (record(payload.arguments) ? "arguments" : "fields")).map(([key, entry]) =>
      <React.Fragment key={`material:${key}`}>
        <dt>{key === "material" ? "Booking details and terms" : key === "value" ? "Price / deposit" : key}</dt>
        <dd className="workflow-output">{typeof entry === "string" ? entry : <pre>{JSON.stringify(entry, null, 2)}</pre>}</dd>
      </React.Fragment>)}
  </dl>;
}
export function OutputView({ value }: { value: JsonValue }) {
  if (value && typeof value === "object" && !Array.isArray(value)) {
    if (value.provider === "linear" && value.verified === true && typeof value.url === "string") {
      try {
        const url = new URL(value.url);
        if (url.protocol === "https:" && url.hostname === "linear.app" && !url.username && !url.password && !url.port)
          return <p>Linear issue created and verified: <a href={url.href} target="_blank" rel="noopener noreferrer">{String(value.id)}</a></p>;
      } catch { /* Untrusted output falls back to inert text. */ }
    }
    if (typeof value.text === "string") return <div className="workflow-output">{value.text}</div>;
    if (typeof value.body === "string") return <div className="workflow-output">{typeof value.subject === "string" && <h3>{value.subject}</h3>}{value.body}</div>;
    if (Array.isArray(value.sources)) return <ul className="workflow-sources">{value.sources.map((source, index) => {
      if (!source || typeof source !== "object" || Array.isArray(source)) return null;
      const url = typeof source.url === "string" && /^https?:\/\//.test(source.url) ? source.url : null;
      return <li key={index}>{url ? <a href={url} target="_blank" rel="noopener noreferrer">{String(source.title ?? url)}</a> : String(source.title ?? "Source")}<p className="fine">{String(source.excerpt ?? "")}</p></li>;
    })}</ul>;
  }
  return <pre className="workflow-output">{JSON.stringify(value, null, 2)}</pre>;
}
