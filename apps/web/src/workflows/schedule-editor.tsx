import { useState } from "react";
import type { WorkflowSchedule } from "@humanos/schemas";
import { api } from "../../lib/api";
export function scheduleDefinition(kind: "once" | "recurring", value: string, timezone: string, weekdays: boolean): WorkflowSchedule["definition"] {
  if (kind === "once") {
    const date = new Date(value);
    if (!Number.isFinite(date.getTime()) || date.getTime() <= Date.now()) throw new Error("Choose a future date and time.");
    return { kind, fireAt: date.toISOString(), timezone: Intl.DateTimeFormat().resolvedOptions().timeZone };
  }
  const match = /^(\d{2}):(\d{2})$/.exec(value);
  if (!match || Number(match[1]) > 23 || Number(match[2]) > 59) throw new Error("Choose a valid time.");
  new Intl.DateTimeFormat("en", { timeZone: timezone }).format();
  return { kind, expression: `${Number(match[2])} ${Number(match[1])} * * ${weekdays ? "1-5" : "*"}`, timezone };
}
export function ScheduleEditor({ workflowId, versionId, schedules, onChanged }: { workflowId: string; versionId: string; schedules: WorkflowSchedule[]; onChanged(): Promise<void> }) {
  const [kind, setKind] = useState<"once" | "recurring">("once");
  const [value, setValue] = useState(""), [zone, setZone] = useState(Intl.DateTimeFormat().resolvedOptions().timeZone);
  const [weekdays, setWeekdays] = useState(false), [busy, setBusy] = useState(false), [error, setError] = useState("");
  async function perform(fn: () => Promise<unknown>) { setBusy(true); setError(""); try { await fn(); await onChanged(); } catch (cause) { setError(cause instanceof Error ? cause.message : "Could not save schedule."); } finally { setBusy(false); } }
  return <details className="workflow-card"><summary>Schedule this workflow</summary><p className="fine">Local runs need HumanOS running and valid account authorization. Overlapping runs are skipped. Every new send or submission still needs your final confirmation.</p>
    <form className="workflow-schedule" onSubmit={event => { event.preventDefault(); void perform(() => api(`/workflows/${workflowId}/schedules`, { versionId, definition: scheduleDefinition(kind, value, zone, weekdays) })); }}>
      <label>Frequency<select value={kind} onChange={event => { setKind(event.target.value as "once" | "recurring"); setValue(""); }}><option value="once">Once</option><option value="recurring">Every day</option></select></label>
      <label>{kind === "once" ? "Date and time (this device's timezone)" : "Time"}<input required type={kind === "once" ? "datetime-local" : "time"} value={value} onChange={event => setValue(event.target.value)} /></label>
      {kind === "recurring" && <><label>Timezone<input required value={zone} onChange={event => setZone(event.target.value)} placeholder="Asia/Tokyo" /></label><label><input type="checkbox" checked={weekdays} onChange={event => setWeekdays(event.target.checked)} /> Weekdays only</label></>}
      <button className="secondary" disabled={busy}>Save schedule</button>
    </form>
    {error && <p role="alert">{error}</p>}
    {schedules.map(schedule => <div className="workflow-receipt" key={schedule.id}><strong>{schedule.definition.kind === "once" ? "One-time run" : "Recurring run"} · {schedule.status.toLowerCase()}</strong><p>{schedule.nextFireAt ? `Next: ${new Date(schedule.nextFireAt).toLocaleString()} · ${schedule.definition.timezone}` : "No upcoming run"}</p>{["ACTIVE", "PAUSED"].includes(schedule.status) && <div className="workflow-actions"><button className="secondary" disabled={busy} onClick={() => void perform(() => api(`/workflow-schedules/${schedule.id}`, { status: schedule.status === "ACTIVE" ? "PAUSED" : "ACTIVE" }))}>{schedule.status === "ACTIVE" ? "Pause schedule" : "Resume schedule"}</button><button className="secondary" disabled={busy} onClick={() => void perform(() => api(`/workflow-schedules/${schedule.id}`, { status: "CANCELLED" }))}>Stop schedule</button></div>}</div>)}
  </details>;
}
