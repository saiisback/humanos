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

/** Account-scoped booking progress and handoff. Shows no credentials, cookies or raw page data. */
export function BrowserHandoff(props: { state: BrowserBookingState; accountLabel: string; preview?: BrowserBookingPreview | null; missing?: readonly string[]; reference?: string | null; message?: string | null }) {
  const copy = COPY[props.state];
  const rows: [string, string][] = props.preview ? [
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
        rows.length === 10 ? (
          <dl className="browser-handoff-preview">{rows.map(([label, value]) => <React.Fragment key={label}><dt>{label}</dt><dd style={{ overflowWrap: "anywhere" }}>{value}</dd></React.Fragment>)}</dl>
        ) : <p>Booking details are incomplete, so this can't be confirmed.</p>
      ) : null}
      {props.state === "confirmed" && props.reference ? <p>Reference: <strong>{props.reference}</strong></p> : null}
    </section>
  );
}
