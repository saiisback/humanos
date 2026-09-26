import React, { useState } from "react";
import { restaurantFields, restaurantIntake, restaurantLabels, updateRestaurantDetails, type RestaurantField } from "@humanos/schemas";

const choices: Partial<Record<RestaurantField, [string, string][]>> = {
  siteId: [["tablecheck-brooklyn-parlor", "TableCheck · Brooklyn Parlor"]],
  venueId: [["brooklynparlor-shinjuku", "Brooklyn Parlor Shinjuku"]],
  timezone: [["Asia/Tokyo", "Japan time (Asia/Tokyo)"]],
  offerId: [["66c4d4411c588898fe3bb84b", "Dinner · table only (food and drinks ordered at the venue)"]],
  intent: [["prepare", "Check availability only"], ["book", "Prepare a booking for my final review"]],
};
/** Refines the same workflow. Saving this form cannot register an agent, run or submit. */
export function RestaurantClarification({ goal, busy, onAnswer }: {
  goal: string; busy: boolean; onAnswer(goal: string): void; blocker?: string | null;
}) {
  const intake = restaurantIntake(goal);
  const [editing, setEditing] = useState(false);
  const [answers, setAnswers] = useState<Partial<Record<RestaurantField, string>>>({});
  const [error, setError] = useState("");
  const fields = editing ? restaurantFields : restaurantFields.filter(key => intake.missing.includes(key) || intake.invalid.includes(key));
  const labelValue = (key: RestaurantField, value: string) => choices[key]?.find(([id]) => id === value)?.[1] ?? value;
  return <section className="workflow-card hotel-intake" aria-label="Restaurant details">
    <span className="eyebrow">Restaurant details · saved in this task</span>
    <h2>{fields.length ? "Let’s finish the reservation details" : "Your reservation details are saved"}</h2>
    {/* Persisted clarification prompts can predate these saved answers. They are not readiness evidence. */}
    <p>{fields.length ? "Fill in the missing details below. Nothing will be booked when you save." : "TableCheck submission is not ready yet. Your details are saved; you do not need to enter them again. Nothing has been booked."}</p>
    {!!Object.keys(intake.details).length && <details className="hotel-intake-saved" open={!fields.length}>
      <summary>Saved reservation details</summary><dl className="workflow-exact">{Object.entries(intake.details).map(([key, value]) =>
        <React.Fragment key={key}><dt>{restaurantLabels[key as RestaurantField]}</dt><dd style={{ overflowWrap: "anywhere" }}>{labelValue(key as RestaurantField, value)}</dd></React.Fragment>)}</dl>
    </details>}
    {!editing && !!Object.keys(intake.details).length && <button className="secondary" disabled={busy} onClick={() => { setAnswers({ ...intake.details }); setEditing(true); }}>Edit reservation details</button>}
    {!!fields.length && <form onSubmit={event => {
      event.preventDefault(); if (busy) return;
      const next = updateRestaurantDetails(goal, answers);
      const checked = restaurantIntake(next);
      if (fields.some(key => checked.missing.includes(key) || checked.invalid.includes(key))) {
        setError("Check the date, Japan time, party size, complete email and phone country code. Parties of six or more must call the venue."); return;
      }
      setError(""); onAnswer(next);
    }}>
      {fields.map(key => <label className="workflow-refine" key={key}><span>{restaurantLabels[key]}</span>
        {choices[key] ? <select name={key} required disabled={busy} value={answers[key] ?? ""} onChange={event => setAnswers(old => ({ ...old, [key]: event.target.value }))}>
          <option value="">Choose…</option>{choices[key]!.map(([value, label]) => <option key={value} value={value}>{label}</option>)}
        </select> : <input name={key} required disabled={busy} maxLength={200} value={answers[key] ?? ""}
          type={key === "date" ? "date" : key === "time" ? "time" : key === "email" ? "email" : key === "phone" ? "tel" : key === "adults" || key === "children" ? "number" : "text"}
          min={key === "adults" ? 1 : key === "children" ? 0 : undefined} max={key === "adults" || key === "children" ? 5 : undefined}
          onChange={event => setAnswers(old => ({ ...old, [key]: event.target.value }))} />}
      </label>)}
      {error && <p role="alert">{error}</p>}
      <button disabled={busy || fields.some(key => !answers[key]?.trim())}>Save reservation details</button>
    </form>}
    <p className="fine">Same-day reservations require a phone call to the venue. Online booking must run through your ENS agent in HumanOS and wait for your final review of the actual terms.</p>
  </section>;
}
