import type { WorkflowConnection } from "@humanos/schemas";

const statusLabel: Record<WorkflowConnection["status"], string> = {
  connected: "Connected for your account",
  setup_required: "Setup required",
  not_connected: "Not connected for your account",
  disabled: "Off",
};
export function WorkflowConnections({ connections, unavailable }: { connections: WorkflowConnection[] | null; unavailable?: boolean }) {
  return <>
    <h2>Connections</h2>
    <p className="fine">“Connected” means HumanOS can call this service for your account. It is not proof that any request succeeded. Keys stay on the server.</p>
    {connections ? connections.map(connection => <div className="connection" key={connection.id} data-status={connection.status}>
      <strong>{connection.label}</strong>
      <span>{statusLabel[connection.status]}</span>
      <small>{connection.detail}</small>
      {connection.publicIdentity && <small>Sends as <span className="hash">{connection.publicIdentity}</span></small>}
      {connection.setup && <small className="connection-setup">{connection.setup}</small>}
    </div>) : <p>{unavailable ? "Connection status is unavailable. No service is assumed connected." : "Checking connections…"}</p>}
  </>;
}
