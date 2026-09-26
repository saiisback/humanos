import React from "react";

export type BrowserBookingState =
  | "unavailable" | "disconnected" | "needs_details" | "preparing" | "needs_login"
  | "awaiting_confirmation" | "submitted" | "confirmed" | "uncertain";

export interface BrowserBookingPreview {
  venue: string;
  origin: string;
  date: string;
  time: string;
  timezone: string;
  guests: string;
  name: string;
  contact: string;
  offer: string;
  price: string;
  terms: string;
}

const COPY: Record<BrowserBookingState, { title: string; body: string }> = {
  unavailable: { title: "Booking browser unavailable", body: "The HumanOS browser worker isn't running on this server. Nothing was opened or booked." },
  disconnected: { title: "Booking site not connected", body: "No inspected booking site is installed for this request. Nothing was opened or booked." },
  needs_details: { title: "More details needed", body: "Add the missing booking details. HumanOS never guesses them." },
  preparing: { title: "Preparing booking", body: "Checking availability and filling the form. Nothing is submitted until you confirm." },
  needs_login: { title: "Your turn in the HumanOS browser", body: "Sign in or complete the check in the HumanOS browser window on this computer, then resume. HumanOS never sees your password or codes." },
  awaiting_confirmation: { title: "Confirm this exact booking", body: "Check every detail below. Confirming submits this booking once." },
  submitted: { title: "Booking sent", body: "Waiting for the site's confirmation." },
  confirmed: { title: "Booked", body: "The site confirmed the booking." },
  uncertain: { title: "Outcome not confirmed", body: "The booking may or may not have gone through. HumanOS will not retry. Check the site or your email before doing anything else." },
};

/** Rows of the server-prepared booking exactly as bound into the confirmation. */
export type PreparedBookingRows = readonly (readonly [string, string])[];

/** Account-scoped booking progress and handoff. Shows no credentials, cookies or raw page data. */
export function BrowserHandoff(props: { state: BrowserBookingState; accountLabel: string; preview?: BrowserBookingPreview | null; prepared?: PreparedBookingRows | null; missing?: readonly string[]; reference?: string | null; message?: string | null }) {
  const copy = COPY[props.state];
  const rows: (readonly [string, string])[] = props.prepared?.length ? [...props.prepared] : props.preview ? [
    ["Venue", props.preview.venue], ["Site", props.preview.origin], ["Date", props.preview.date],
    ["Time", `${props.preview.time} (${props.preview.timezone})`], ["Guests", props.preview.guests], ["Name", props.preview.name],
    ["Contact", props.preview.contact], ["Offer", props.preview.offer], ["Price / deposit", props.preview.price], ["Cancellation terms", props.preview.terms],
  ] : [];
  return (
    <section className="browser-handoff" aria-live="polite" data-state={props.state}>
      <h3>{copy.title}</h3>
      <p>{copy.body}</p>
      <p className="browser-handoff-scope">For {props.accountLabel} only.</p>
      {props.message ? <p className="browser-handoff-message">{props.message}</p> : null}
      {props.state === "needs_details" && props.missing?.length ? <ul>{props.missing.map(item => <li key={item}>{item}</li>)}</ul> : null}
      {props.state === "awaiting_confirmation" ? (
        rows.length === 10 || props.prepared?.length ? (
          <dl className="browser-handoff-preview">{rows.map(([label, value]) => <React.Fragment key={label}><dt>{label}</dt><dd style={{ overflowWrap: "anywhere" }}>{value}</dd></React.Fragment>)}</dl>
        ) : <p>Booking details are incomplete, so this can't be confirmed.</p>
      ) : null}
      {props.state === "confirmed" && props.reference ? <p>Reference: <strong>{props.reference}</strong></p> : null}
    </section>
  );
}

type RunDetail = import("@humanos/schemas").WorkflowRunDetailResponse;
type Version = import("@humanos/schemas").WorkflowVersion;
type Json = import("@humanos/schemas").JsonValue;
const isRecord = (value: unknown): value is Record<string, Json> => !!value && typeof value === "object" && !Array.isArray(value);

/** True only for runs whose pinned graph books through a Browser Use site policy. */
export function isBrowserUseRun(version: Version | null | undefined): boolean {
  return !!version?.graph.nodes.some(node => node.type === "browser.submit" && /^browser-use:[a-z][a-z0-9-]{0,63}$/.test(String(node.input.destination)));
}

/** The server-prepared preview, only when it is bound to the Browser Use executor. */
export function preparedRows(preview: Json | null): PreparedBookingRows | null {
  if (!isRecord(preview) || !isRecord(preview.binding) || preview.binding.executor !== "browser-use" || !isRecord(preview.payload)) return null;
  const { payload, binding } = preview;
  const rows: [string, string][] = [["Site", `${String(binding.site ?? "")} (${String(binding.origin ?? "")})`], ["Submits to", String(preview.destination ?? "")]];
  if (isRecord(payload.fields)) for (const [name, value] of Object.entries(payload.fields)) rows.push([name.replaceAll("_", " "), String(value)]);
  if (Array.isArray(payload.material)) payload.material.forEach((line, index) => rows.push([`Detail ${index + 1}`, String(line)]));
  rows.push(["Price / deposit", isRecord(payload.value) ? `${String(payload.value.currency)} ${String(payload.value.amount)}` : "None shown"]);
  return rows;
}

/** Maps durable run state to the handoff view. Returns null for runs that are not Browser Use bookings. */
export function browserBookingView(run: RunDetail, version: Version | null | undefined, preview: Json | null):
  { state: BrowserBookingState; message: string | null; reference: string | null; prepared: PreparedBookingRows | null } | null {
  if (!isBrowserUseRun(version)) return null;
  const reason = run.run.pauseReason ?? null;
  const receipt = run.receipts.find(r => isRecord(r.metadata) && r.metadata.executor === "browser-use");
  const view = (state: BrowserBookingState, extra: Partial<{ reference: string | null; prepared: PreparedBookingRows | null }> = {}) =>
    ({ state, message: reason, reference: extra.reference ?? null, prepared: extra.prepared ?? null });
  switch (run.run.status) {
    case "COMPLETED": return receipt ? view("confirmed", { reference: receipt.providerReference ?? null }) : null;
    case "RECONCILIATION_REQUIRED": return view("uncertain");
    case "CONFIRMATION_REQUIRED": return view("awaiting_confirmation", { prepared: preparedRows(preview) });
    case "INPUT_REQUIRED": return view("needs_details");
    case "CONNECTION_REQUIRED":
      // Never point the user at a window when the server runs the browser without one.
      if (/no visible browser window/i.test(reason ?? "")) return view("unavailable");
      if (/sign in|captcha|site's check|another booking/i.test(reason ?? "")) return view("needs_login");
      if (/no inspected site policy/i.test(reason ?? "")) return view("disconnected");
      return view("unavailable");
    case "QUEUED": case "RUNNING": case "WAITING": case "RETRY_SCHEDULED": return view("preparing");
    default: return null;
  }
}

export function RunBrowserHandoff(props: { run: RunDetail; version: Version | null | undefined; preview: Json | null; accountLabel: string }) {
  const view = browserBookingView(props.run, props.version, props.preview);
  if (!view) return null;
  return <BrowserHandoff state={view.state} accountLabel={props.accountLabel} prepared={view.prepared} reference={view.reference} message={view.message} />;
}
