import React, { useState } from "react";
import { hotelFields, hotelIntake, hotelLabels, updateHotelDetails, type HotelField } from "@humanos/schemas";

/** Answers refine the same owned workflow; this component cannot run or approve it. */
export function HotelClarification({ goal, busy, onAnswer }: { goal: string; busy: boolean; onAnswer(goal: string): void }) {
  const intake = hotelIntake(goal);
  const [editing, setEditing] = useState(false);
  const fields = editing ? [...hotelFields] : intake.missing.slice(0, 2);
  const [answers, setAnswers] = useState<Partial<Record<HotelField, string>>>({});
  const [error, setError] = useState("");
  return <section className="workflow-card hotel-intake" aria-label="Hotel follow-up">
    <span className="eyebrow">Your stay · saved in this task</span>
    <h2>{intake.missing.length ? "Let’s fill in the missing details" : "Your stay details are ready"}</h2>
    <p>{intake.question}</p>
    {Object.keys(intake.details).length > 0 && <details open={!fields.length} className="hotel-intake-saved"><summary>Saved stay details</summary><dl className="workflow-exact">{Object.entries(intake.details).map(([key, value]) =>
      <React.Fragment key={key}><dt>{hotelLabels[key as HotelField]}</dt><dd style={{ overflowWrap: "anywhere" }}>{value}</dd></React.Fragment>)}</dl></details>}
    {!editing && Object.keys(intake.details).length > 0 && <button type="button" className="secondary" disabled={busy}
      onClick={() => { setAnswers({ ...intake.details }); setEditing(true); }}>Edit stay details</button>}
    {fields.length > 0 && <form onSubmit={event => {
      event.preventDefault();
      if (busy) return;
      const next = updateHotelDetails(goal, answers);
      if (fields.some(field => hotelIntake(next).missing.includes(field))) { setError("Check these details: use valid dates, positive guest/room counts and a complete email address."); return; }
      setError(""); onAnswer(next);
    }}>
      {fields.map(field => <label className="workflow-refine" key={field}>
        <span>{hotelLabels[field]}</span>
        <input name={field} required disabled={busy} maxLength={200}
          type={field === "checkIn" || field === "checkOut" ? "date" : field === "email" ? "email" : field === "guests" || field === "rooms" ? "number" : "text"}
          min={field === "guests" || field === "rooms" ? 1 : undefined} max={field === "guests" || field === "rooms" ? 99 : undefined}
          autoComplete={field === "email" ? "email" : field === "guestName" ? "name" : "off"}
          placeholder={field === "budget" ? "e.g. JPY 15,000 per night" : undefined}
          value={answers[field] ?? ""} onChange={event => setAnswers(previous => ({ ...previous, [field]: event.target.value }))} />
      </label>)}
      {error && <p role="alert">{error}</p>}
      <button disabled={busy || fields.some(field => !answers[field]?.trim())}>{editing ? "Save stay details" : "Continue this task"}</button>
    </form>}
    <p className="fine">These answers are not booking approval. You’ll review the exact hotel, price and cancellation terms before any reservation.</p>
  </section>;
}
