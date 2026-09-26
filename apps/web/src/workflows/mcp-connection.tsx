import React, { useState } from "react";
import { api } from "../../lib/api";
type Destinations = { workspace: { id: string; name: string }; teams: Array<{id: string; name: string}> };
export function LinearConnection({ connected, onChanged }: { connected: boolean; onChanged(): void }) {
  const [data, setData] = useState<Destinations | null>(null);
  const [selected, setSelected] = useState("");
  const [busy, setBusy] = useState(false), [error, setError] = useState("");
  async function perform(work: () => Promise<void>) {
    setBusy(true); setError("");
    try { await work(); } catch { setError("Linear could not connect. Check your server key and account access, then try again. No issue was created."); }
    finally { setBusy(false); }
  }
  return <div>
    <button className="secondary" disabled={busy} onClick={() => void perform(async () => {
      setData(await api<Destinations>("/workflow-linear/destinations")); setSelected("");
    })}>{busy ? "Checking Linear…" : connected ? "Change Linear team" : "Choose Linear team"}</button>
    {data && <div>
      <p>Workspace: {data.workspace.name}</p>
      <label>Linear team <select value={selected} disabled={busy} onChange={event => setSelected(event.target.value)}>
        <option value="">Select a team</option>
        {data.teams.map(team => <option key={team.id} value={team.id}>{team.name}</option>)}
      </select></label>
      {!data.teams.length && <p>No accessible teams. Check the key’s team permissions.</p>}
      <p className="fine">Allows issue creation in this team only after your final confirmation.</p>
      <button disabled={busy || !selected} onClick={() => void perform(async () => {
        await api("/workflow-linear/select", { destinationId: selected }); setData(null); onChanged();
      })}>Connect selected team</button>
    </div>}
    {connected && <button className="secondary" disabled={busy} onClick={() => void perform(async () => {
      await api("/workflow-linear/disconnect", {}); setData(null); onChanged();
    })}>Disconnect Linear</button>}
    {error && <p role="alert">{error}</p>}
  </div>;
}
