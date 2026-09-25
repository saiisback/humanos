import type { Capability } from "@humanos/schemas";
import type { TranscriptItem } from "./types";
import {
  PermissionReview,
  type JawPermissionClient,
} from "../permissions/permission-review";

const label = (value: string) =>
  value.toLowerCase().replaceAll("_", " ").replaceAll(".", " ");
const date = (value: string) =>
  new Date(value).toLocaleString(undefined, {
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
const terminal = ["COMPLETED", "REJECTED", "EXPIRED", "REVOKED", "FAILED"];

export interface TranscriptActions {
  authorize(capabilities: Capability[]): void;
  run(): void;
  revoke(): void;
  requestApproval(actionId: string): void;
  confirm(actionId: string): void;
  cancel(actionId: string): void;
  execute(actionId: string): void;
}

export function Transcript({
  items,
  busy,
  capabilities,
  setCapabilities,
  actions,
  permissionClient,
  onPermissionRecorded,
}: {
  items: TranscriptItem[];
  busy: boolean;
  capabilities: Capability[];
  setCapabilities: (value: Capability[]) => void;
  actions: TranscriptActions;
  permissionClient?: JawPermissionClient | undefined;
  onPermissionRecorded?: (() => Promise<void>) | undefined;
}) {
  return (
    <ol className="transcript" aria-label="Mission conversation">
      {items.map((item) => (
        <li key={item.id} className={`transcript-item transcript-${item.kind}`}>
          {item.kind === "permission" && (
            <PermissionReview
              review={item.review}
              grant={item.grant}
              enabled={item.enabled && !busy}
              client={permissionClient}
              onRecorded={onPermissionRecorded}
            />
          )}
          {item.kind === "human" && (
            <div className="human-message">
              <p>{item.text}</p>
              <small>You{item.at ? ` · ${date(item.at)}` : ""}</small>
            </div>
          )}
          {item.kind === "agent" && (
            <p className="agent-message">{item.text}</p>
          )}
          {item.kind === "progress" && (
            <p className="event-row" role="status">
              <span aria-hidden="true" className="event-dot" />
              {item.text}
            </p>
          )}
          {item.kind === "identity" && (
            <p className="event-row" role="status">
              <span aria-hidden="true" className="event-dot trust" />
              {item.text}
            </p>
          )}
          {item.kind === "ens" && (
            <section className="event-row ens-row" aria-label="ENS identity">
              <span aria-hidden="true" className="event-dot trust" />
              <div>
                <strong>ENS agent identity</strong>
                <p className="hash">{item.name}</p>
                <small>Authority expires {date(item.expiresAt)}</small>
              </div>
            </section>
          )}
          {item.kind === "denial" && (
            <p className="event-row denial-row" role="status">
              <span aria-hidden="true" className="event-dot" />
              {item.text}
            </p>
          )}
          {item.kind === "mandate" && (
            <section className="review-block" aria-label="Agent mandate">
              <div className="review-heading">
                <div>
                  <span className="eyebrow">Agent proposal</span>
                  <h2>Agent mandate</h2>
                </div>
                <span className="state-label">{label(item.mission.state)}</span>
              </div>
              <ol className="steps">
                {item.mission.steps.map((step, index) => (
                  <li key={`${index}-${step}`}>
                    <span>{index + 1}</span>
                    {step}
                  </li>
                ))}
              </ol>
              <p className="fine">
                Authority expires {date(item.mission.expiresAt)}. Choose only
                the capabilities this mission needs.
              </p>
              <fieldset
                disabled={
                  busy || !["DRAFT", "PROPOSED"].includes(item.mission.state)
                }
              >
                <legend>Approved capabilities</legend>
                <div className="capability-list">
                  {item.mission.capabilities.map((capability) => (
                    <label key={capability}>
                      <input
                        type="checkbox"
                        checked={capabilities.includes(capability)}
                        onChange={(event) =>
                          setCapabilities(
                            event.target.checked
                              ? [...capabilities, capability]
                              : capabilities.filter(
                                  (value) => value !== capability,
                                ),
                          )
                        }
                      />
                      {label(capability)}
                    </label>
                  ))}
                </div>
              </fieldset>
              <div className="actions">
                {["DRAFT", "PROPOSED"].includes(item.mission.state) && (
                  <button
                    disabled={busy || !capabilities.length}
                    onClick={() => actions.authorize(capabilities)}
                  >
                    Authorize &amp; create agent
                  </button>
                )}
                {["AUTHORIZED", "RUNNING"].includes(item.mission.state) && (
                  <button disabled={busy} onClick={actions.run}>
                    {item.mission.state === "RUNNING"
                      ? "Resume mission"
                      : "Run mission"}
                  </button>
                )}
                {!terminal.includes(item.mission.state) && (
                  <button
                    className="secondary"
                    disabled={busy}
                    onClick={actions.revoke}
                  >
                    Revoke authority
                  </button>
                )}
              </div>
            </section>
          )}
          {item.kind === "approval" && (
            <section
              className="review-block action-review"
              aria-label={`Action review ${item.action.id}`}
            >
              <span className="eyebrow">
                Review required · {label(item.approval?.status ?? "proposed")}
              </span>
              <h2>{label(item.action.type)}</h2>
              <p className="effect">{item.effect}</p>
              <div className="review-facts">
                <div>
                  <span>Capability</span>
                  <strong>{label(item.action.capability)}</strong>
                </div>
                <div>
                  <span>Expires</span>
                  <strong>{date(item.action.expiresAt)}</strong>
                </div>
              </div>
              <details>
                <summary>Inspect exact action &amp; binding</summary>
                <pre>{JSON.stringify(item.action.payload, null, 2)}</pre>
                <dl>
                  <dt>Payload hash</dt>
                  <dd className="hash">{item.payloadHash}</dd>
                  <dt>Nonce</dt>
                  <dd className="hash">{item.action.nonce}</dd>
                  <dt>Agent</dt>
                  <dd className="hash">{item.action.agentEns}</dd>
                </dl>
              </details>
              <div className="assessment-grid">
                <div>
                  <h3>Jev assessment</h3>
                  {item.assessment ? (
                    <p>
                      {label(item.assessment.risk)} · {item.assessment.reason}
                    </p>
                  ) : (
                    <p>Awaiting assessment</p>
                  )}
                </div>
                <div>
                  <h3>HumanOS policy</h3>
                  {item.decision ? (
                    <p>
                      {item.decision.allowed
                        ? "Allowed"
                        : item.decision.requiresApproval
                          ? "Approval required"
                          : "Blocked"}{" "}
                      · {item.decision.reasons.join(" · ")}
                    </p>
                  ) : (
                    <p>Awaiting policy evaluation</p>
                  )}
                </div>
              </div>
              <div className="actions">
                <button
                  disabled={busy}
                  onClick={() => actions.requestApproval(item.action.id)}
                >
                  {item.approval?.status === "PENDING"
                    ? "Retry verification"
                    : "Verify sensitive action"}
                </button>
                <button
                  className="secondary"
                  disabled={busy}
                  onClick={() => actions.confirm(item.action.id)}
                >
                  Confirm consequential action
                </button>
                <button
                  className="secondary"
                  disabled={busy}
                  onClick={() => actions.cancel(item.action.id)}
                >
                  Cancel action
                </button>
                <button
                  className="secondary"
                  disabled={busy}
                  onClick={() => actions.execute(item.action.id)}
                >
                  Execute approved action
                </button>
              </div>
            </section>
          )}
          {item.kind === "receipt" && (
            <section
              className="event-row receipt-row"
              aria-label="Execution receipt"
            >
              <span aria-hidden="true" className="event-dot" />
              <div>
                <strong>
                  Execution receipt · {label(item.receipt.status)}
                </strong>
                <p className="hash">{item.receipt.id}</p>
                <small>{date(item.receipt.executedAt)}</small>
                {item.receipt.metadata.ensUpdateStatus === "PENDING" && (
                  <>
                    <p>
                      ENS receipt publication pending. The execution receipt
                      exists; onchain publication is not yet confirmed.
                    </p>
                    <button
                      className="secondary"
                      disabled={busy}
                      onClick={() => actions.execute(item.receipt.actionId)}
                    >
                      Retry ENS receipt publication
                    </button>
                  </>
                )}
                {item.receipt.metadata.ensUpdateStatus === "CONFIRMED" && (
                  <p>ENS receipt publication confirmed</p>
                )}
                {item.receipt.status === "RECONCILIATION_REQUIRED" && (
                  <>
                    <p>
                      The external outcome is uncertain. Check the existing
                      submission.
                    </p>
                    <button
                      className="secondary"
                      disabled={busy}
                      onClick={() => actions.execute(item.receipt.actionId)}
                    >
                      Check submission status
                    </button>
                  </>
                )}
              </div>
            </section>
          )}
        </li>
      ))}
    </ol>
  );
}
