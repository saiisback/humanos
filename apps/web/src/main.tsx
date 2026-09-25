import React, { useEffect, useState, useRef } from "react";
import { createRoot } from "react-dom/client";
import {
  IDKitRequestWidget,
  proofOfHuman,
  type RpContext,
} from "@worldcoin/idkit";
import type {
  ApprovalRequestResponse,
  Capability,
  Mission,
  MissionDetailResponse,
  MissionListResponse,
  Readiness,
  WorldProofRequest,
} from "@humanos/schemas";
import { api } from "../lib/api";
import { useAuth } from "./auth/use-auth";
import "@fontsource/dm-sans/400.css";
import "@fontsource/dm-sans/500.css";
import "@fontsource/dm-sans/600.css";
import "@fontsource/instrument-serif/400.css";
import "./style.css";
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
function Mark() {
  return (
    <svg
      width="30"
      height="30"
      viewBox="0 0 30 30"
      fill="none"
      aria-hidden="true"
    >
      <path
        d="M5 5v20M25 5v20M5 15h20M15 5v20"
        stroke="currentColor"
        strokeWidth="2.5"
      />
      <circle cx="15" cy="15" r="5" fill="currentColor" />
    </svg>
  );
}
function App() {
  const verifiedRequest = useRef<string | null>(null);
  const auth = useAuth();
  const session = auth;
  const activeRoot = useRef<string | null>(null);
  activeRoot.current =
    auth.status === "signing-out" ? null : (auth.root?.id ?? null);
  const [ready, setReady] = useState<Readiness | null>(null),
    [missions, setMissions] = useState<Mission[]>([]),
    [detail, setDetail] = useState<MissionDetailResponse | null>(null);
  const [goal, setGoal] = useState(""),
    [caps, setCaps] = useState<Capability[]>([]),
    [busy, setBusy] = useState(false),
    [error, setError] = useState(""),
    [loading, setLoading] = useState(true),
    [proof, setProof] = useState<{
      request: WorldProofRequest;
      actionId?: string;
    } | null>(null);
  async function refresh() {
    setReady(await api<Readiness>("/ready"));
    if (auth.root) {
      const rootId = auth.root.id;
      const list = await api<MissionListResponse>("/missions");
      if (activeRoot.current !== rootId) return;
      setMissions(list.missions);
      const id = new URLSearchParams(location.search).get("mission");
      if (id) await select(id);
    }
  }
  async function select(id: string) {
    const rootId = activeRoot.current;
    if (!rootId) return;
    const d = await api<MissionDetailResponse>(
      `/missions/${encodeURIComponent(id)}`,
    );
    if (activeRoot.current !== rootId) return;
    setDetail(d);
    setCaps(
      d.mission.approvedCapabilities.length
        ? d.mission.approvedCapabilities
        : d.mission.capabilities,
    );
    history.replaceState(null, "", `?mission=${encodeURIComponent(id)}`);
  }
  async function perform(fn: () => Promise<void>) {
    setBusy(true);
    setError("");
    try {
      await fn();
    } catch (e) {
      setError(
        e instanceof Error
          ? e.message
          : "The request could not complete. Please retry.",
      );
    } finally {
      setBusy(false);
    }
  }
  useEffect(() => {
    void perform(refresh).finally(() => setLoading(false));
  }, []);
  useEffect(() => {
    if (!auth.root) {
      setMissions([]);
      setDetail(null);
      setProof(null);
      setCaps([]);
      return;
    }
    void perform(refresh);
  }, [auth.root?.id]);
  useEffect(() => {
    if (!detail || terminal.includes(detail.mission.state)) return;
    const id = detail.mission.id;
    const interval = setInterval(() => {
      void api<MissionDetailResponse>(`/missions/${encodeURIComponent(id)}`)
        .then((d) =>
          setDetail((current) => (current?.mission.id === id ? d : current)),
        )
        .catch((e) => setError(e.message));
    }, 3000);
    return () => clearInterval(interval);
  }, [detail?.mission.id, detail?.mission.state]);
  async function missionAction(action: string, body: unknown = {}) {
    if (!detail) return;
    const d = await api<MissionDetailResponse>(
      `/missions/${encodeURIComponent(detail.mission.id)}/${action}`,
      body,
    );
    setDetail(d);
    setMissions((await api<MissionListResponse>("/missions")).missions);
  }
  const m = detail?.mission;
  return (
    <div className="shell">
      <a className="skip" href="#main">
        Skip to workspace
      </a>
      <aside className="rail">
        <a className="brand" href="/" aria-label="HumanOS home">
          <Mark />
          Human<span>OS</span>
        </a>
        <p className="rail-note">
          Your agents.
          <br />
          Your authority.
        </p>
        <nav aria-label="Workspace">
          <a href="#main" className="nav-active">
            Mission control{" "}
            <span>{missions.length.toString().padStart(2, "0")}</span>
          </a>
          <a href="#identity">Human identity</a>
          <a href="#services">Connections</a>
        </nav>
        <div className="rail-bottom">
          <span className="status-dot" />
          Human-owned by design
          <p>
            Authority is scoped.
            <br />
            Every action is accountable.
          </p>
        </div>
      </aside>
      <div className="workspace">
        <header className="topbar">
          <span>
            Workspace <span className="slash">/</span> Mission control
          </span>
          <span className="session-status">
            <span className="status-dot" />
            {session.root
              ? "Human verified"
              : session.account
                ? "Account connected"
                : "Sign in required"}
          </span>
        </header>
        <main id="main">
          <div className="heading">
            <div>
              <h1>Make room for being human.</h1>
              <p>Delegate the work. Keep the final say.</p>
            </div>
            <span className="network">ENSv2 · Sepolia</span>
          </div>
          {error && (
            <div role="alert" className="error">
              {error}
              <button
                className="text-button"
                onClick={() => void perform(refresh)}
                disabled={busy}
              >
                Retry connection
              </button>
            </div>
          )}
          {loading || auth.status === "loading" ? (
            <p role="status">Connecting to your workspace…</p>
          ) : !auth.account ? (
            <section className="onboarding" id="identity">
              <div>
                <span className="seal">
                  <Mark />
                </span>
                <h2>Start with your passkey.</h2>
                <p>
                  Sign in with a JAW smart account to begin your HumanOS
                  workspace.
                </p>
                <button
                  disabled={
                    busy || auth.status === "signing-in" || !auth.jawConfigured
                  }
                  onClick={() => void perform(auth.signIn)}
                >
                  {auth.status === "signing-in"
                    ? "Signing in…"
                    : "Sign in with JAW"}
                </button>
                {!auth.jawConfigured && (
                  <p role="status" className="fine">
                    JAW account sign-in is unavailable. Configure the public JAW
                    key and backend Sepolia verification.
                  </p>
                )}
              </div>
            </section>
          ) : !session.root ? (
            <section className="onboarding" id="identity">
              <div>
                <span className="seal">
                  <Mark />
                </span>
                <h2>It begins with you.</h2>
                <p>
                  Prove you’re a unique human to establish your root identity.
                  Every task agent belongs to this root, with authority you can
                  revoke.
                </p>
                <button
                  disabled={busy}
                  onClick={() =>
                    void perform(async () =>
                      setProof({
                        request: await api<WorldProofRequest>(
                          "/world/root/request",
                          {},
                        ),
                      }),
                    )
                  }
                >
                  {busy ? "Preparing verification…" : "Verify with World ID"}
                </button>
                <p className="fine">
                  Proof of Human via World ID 4 establishes your root after JAW
                  sign-in.
                </p>
              </div>
              <ol className="onboarding-steps">
                <li>
                  <strong>Establish your identity</strong>
                  <span>One human. One root.</span>
                </li>
                <li>
                  <strong>Define a mission</strong>
                  <span>Review the plan and its boundaries.</span>
                </li>
                <li>
                  <strong>Stay in control</strong>
                  <span>Approve sensitive actions. Revoke anytime.</span>
                </li>
              </ol>
            </section>
          ) : (
            <>
              <section className="identity-strip" id="identity">
                <span className="identity-icon">
                  <Mark />
                </span>
                <div>
                  <strong>{session.root.ensName ?? "Your human root"}</strong>
                  <small>
                    World ID verified · {session.root.verificationEnvironment}
                  </small>
                </div>
                <span className="identity-id">{session.root.id}</span>
              </section>
              <div className="mission-grid">
                <section className="mission-list">
                  <div className="section-title">
                    <h2>Your missions</h2>
                    <span>{missions.length}</span>
                  </div>
                  {missions.length === 0 ? (
                    <p className="empty">
                      A clear goal is a good beginning. Create your first
                      mission below.
                    </p>
                  ) : (
                    missions.map((x) => (
                      <button
                        className={`mission-item ${m?.id === x.id ? "selected" : ""}`}
                        key={x.id}
                        onClick={() => void perform(() => select(x.id))}
                      >
                        <strong>{x.title}</strong>
                        <span>
                          {label(x.state)} · {date(x.createdAt)}
                        </span>
                      </button>
                    ))
                  )}
                  <form
                    onSubmit={(e) => {
                      e.preventDefault();
                      void perform(async () => {
                        const d = await api<MissionDetailResponse>(
                          "/missions",
                          { goal },
                        );
                        setDetail(d);
                        setCaps(d.mission.capabilities);
                        setGoal("");
                        history.replaceState(
                          null,
                          "",
                          `?mission=${encodeURIComponent(d.mission.id)}`,
                        );
                        setMissions(
                          (await api<MissionListResponse>("/missions"))
                            .missions,
                        );
                      });
                    }}
                  >
                    <label htmlFor="goal">
                      What would you like to get done?
                    </label>
                    <textarea
                      id="goal"
                      value={goal}
                      onChange={(e) => setGoal(e.target.value)}
                      required
                      maxLength={10000}
                      rows={5}
                      placeholder="Prepare my Tokyo participant application and add the event to my calendar."
                    />
                    <button disabled={busy || !goal.trim()} type="submit">
                      Create mission <span aria-hidden="true">→</span>
                    </button>
                  </form>
                </section>
                <section
                  className="mission-detail"
                  aria-label="Mission workspace"
                >
                  {!detail || !m ? (
                    <div className="empty-workspace">
                      <Mark />
                      <h2>A little less on your plate.</h2>
                      <p>
                        Your mission plan, agent identity, approvals and
                        receipts will appear here.
                      </p>
                    </div>
                  ) : (
                    <>
                      <div className="section-title">
                        <h2>{m.title}</h2>
                        <span
                          className={`badge ${terminal.includes(m.state) ? "muted" : ""}`}
                        >
                          {label(m.state)}
                        </span>
                      </div>
                      <p className="goal-copy">{m.goal}</p>
                      <dl className="agent-facts">
                        <div>
                          <dt>Task agent</dt>
                          <dd>{m.agentEns ?? "ENS identity not created"}</dd>
                        </div>
                        <div>
                          <dt>Authority expires</dt>
                          <dd>{date(m.expiresAt)}</dd>
                        </div>
                      </dl>
                      {["REVOKED", "EXPIRED", "REJECTED", "FAILED"].includes(
                        m.state,
                      ) && (
                        <p className="notice" role="status">
                          This mission is {label(m.state)}. Further execution is
                          blocked by the server.
                        </p>
                      )}
                      <h3>Mission plan</h3>
                      <ol className="plan">
                        {m.steps.map((s, i) => (
                          <li key={i}>{s}</li>
                        ))}
                      </ol>
                      <h3>Authority boundaries</h3>
                      <p className="fine">
                        Approve only what this mission needs. ENS creation
                        happens on authorization.
                      </p>
                      <fieldset
                        disabled={
                          busy || !["DRAFT", "PROPOSED"].includes(m.state)
                        }
                      >
                        <legend className="sr-only">
                          Approved capabilities
                        </legend>
                        {m.capabilities.map((c) => (
                          <label className="capability" key={c}>
                            <input
                              type="checkbox"
                              checked={caps.includes(c)}
                              onChange={(e) =>
                                setCaps(
                                  e.target.checked
                                    ? [...caps, c]
                                    : caps.filter((v) => v !== c),
                                )
                              }
                            />
                            {label(c)}
                          </label>
                        ))}
                      </fieldset>
                      <div className="actions">
                        {["DRAFT", "PROPOSED"].includes(m.state) && (
                          <button
                            disabled={busy || !caps.length}
                            onClick={() =>
                              void perform(() =>
                                missionAction("authorize", {
                                  approvedCapabilities: caps,
                                }),
                              )
                            }
                          >
                            Authorize & create agent
                          </button>
                        )}
                        {["AUTHORIZED", "RUNNING"].includes(m.state) && (
                          <button
                            disabled={busy}
                            onClick={() =>
                              void perform(() => missionAction("run"))
                            }
                          >
                            {m.state === "RUNNING"
                              ? "Resume mission"
                              : "Run mission"}
                          </button>
                        )}
                        {!terminal.includes(m.state) && (
                          <button
                            className="secondary danger"
                            disabled={busy}
                            onClick={() =>
                              void perform(() => missionAction("revoke"))
                            }
                          >
                            Revoke authority
                          </button>
                        )}
                      </div>
                      <div className="assessments">
                        <section>
                          <h3>Jev assessment</h3>
                          <span className="fine">
                            Model advice · cannot grant authority
                          </span>
                          {detail.assessment ? (
                            <>
                              <p>
                                <strong>{label(detail.assessment.risk)}</strong>{" "}
                                ·{" "}
                                {Math.round(detail.assessment.confidence * 100)}
                                % confidence
                              </p>
                              <p>{detail.assessment.reason}</p>
                            </>
                          ) : (
                            <p className="fine">Awaiting assessment</p>
                          )}
                        </section>
                        <section>
                          <h3>HumanOS policy</h3>
                          <span className="fine">
                            Deterministic server decision
                          </span>
                          {detail.decision ? (
                            <>
                              <p>
                                <strong>
                                  {detail.decision.allowed
                                    ? "Allowed"
                                    : detail.decision.requiresApproval
                                      ? "Approval required"
                                      : "Blocked"}
                                </strong>{" "}
                                · {label(detail.decision.risk)}
                              </p>
                              <ul>
                                {detail.decision.reasons.map((r, i) => (
                                  <li key={i}>{r}</li>
                                ))}
                              </ul>
                            </>
                          ) : (
                            <p className="fine">Awaiting policy evaluation</p>
                          )}
                        </section>
                      </div>
                      {detail.actions.map((a) => {
                        const approval = [...detail.approvals]
                          .reverse()
                          .find((p) => p.actionId === a.id);
                        const receipt = detail.receipts.find(
                          (r) => r.actionId === a.id,
                        );
                        return (
                          <section key={a.id} className="action-review">
                            <div className="section-title">
                              <h3>{label(a.type)}</h3>
                              <span className="badge">
                                {receipt
                                  ? label(receipt.status)
                                  : approval
                                    ? label(approval.status)
                                    : "Proposed"}
                              </span>
                            </div>
                            <p>{a.reason}</p>
                            <details>
                              <summary>Inspect exact action & binding</summary>
                              <pre>{JSON.stringify(a.payload, null, 2)}</pre>
                              <dl>
                                <dt>Payload hash</dt>
                                <dd className="hash">{a.payloadHash}</dd>
                                <dt>Nonce</dt>
                                <dd>{a.nonce}</dd>
                                <dt>Expires</dt>
                                <dd>{date(a.expiresAt)}</dd>
                              </dl>
                            </details>
                            {!receipt && !terminal.includes(m.state) && (
                              <div className="actions">
                                <button
                                  disabled={busy}
                                  onClick={() =>
                                    void perform(async () => {
                                      const response =
                                        await api<ApprovalRequestResponse>(
                                          `/actions/${encodeURIComponent(a.id)}/approval/request`,
                                          {},
                                        );
                                      setProof({
                                        request: response.request,
                                        actionId: a.id,
                                      });
                                    })
                                  }
                                >
                                  {approval?.status === "PENDING"
                                    ? "Retry verification"
                                    : "Verify sensitive action"}
                                </button>
                                <button
                                  className="secondary"
                                  disabled={busy}
                                  onClick={() =>
                                    void perform(async () =>
                                      setDetail(
                                        await api<MissionDetailResponse>(
                                          `/actions/${encodeURIComponent(a.id)}/confirm`,
                                          {},
                                        ),
                                      ),
                                    )
                                  }
                                >
                                  Confirm consequential action
                                </button>
                                <button
                                  className="secondary"
                                  disabled={busy}
                                  onClick={() =>
                                    void perform(async () =>
                                      setDetail(
                                        await api<MissionDetailResponse>(
                                          `/actions/${encodeURIComponent(a.id)}/approval/cancel`,
                                          {},
                                        ),
                                      ),
                                    )
                                  }
                                >
                                  Cancel action
                                </button>
                                <button
                                  className="secondary"
                                  disabled={busy}
                                  onClick={() =>
                                    void perform(async () => {
                                      await api(
                                        `/actions/${encodeURIComponent(a.id)}/execute`,
                                        {},
                                      );
                                      await select(m.id);
                                    })
                                  }
                                >
                                  Execute approved action
                                </button>
                              </div>
                            )}
                            {receipt && (
                              <div className="receipt">
                                <strong>
                                  Execution receipt · {label(receipt.status)}
                                </strong>
                                <p>{date(receipt.executedAt)}</p>
                                <code>{receipt.id}</code>
                                {receipt.metadata.ensUpdateStatus ===
                                  "PENDING" && (
                                  <>
                                    <p>
                                      ENS receipt publication pending. Execution
                                      has its own receipt above; onchain
                                      publication is not yet confirmed.
                                    </p>
                                    <button
                                      className="secondary"
                                      disabled={busy}
                                      onClick={() =>
                                        void perform(async () => {
                                          await api(
                                            `/actions/${encodeURIComponent(a.id)}/execute`,
                                            {},
                                          );
                                          await select(m.id);
                                        })
                                      }
                                    >
                                      Retry ENS receipt publication
                                    </button>
                                  </>
                                )}
                                {receipt.metadata.ensUpdateStatus ===
                                  "CONFIRMED" && (
                                  <p>ENS receipt publication confirmed</p>
                                )}
                                {receipt.status ===
                                  "RECONCILIATION_REQUIRED" && (
                                  <>
                                    <p>
                                      The external outcome is uncertain. Check
                                      the existing submission to confirm its
                                      result.
                                    </p>
                                    <button
                                      className="secondary"
                                      disabled={busy}
                                      onClick={() =>
                                        void perform(async () => {
                                          await api(
                                            `/actions/${encodeURIComponent(a.id)}/execute`,
                                            {},
                                          );
                                          await select(m.id);
                                        })
                                      }
                                    >
                                      {busy
                                        ? "Checking submission…"
                                        : "Check submission status"}
                                    </button>
                                    <p className="fine">
                                      This checks the original operation; it
                                      does not send a new submission.
                                    </p>
                                  </>
                                )}
                              </div>
                            )}
                          </section>
                        );
                      })}
                      <section className="timeline">
                        <h3>Activity & evidence</h3>
                        {detail.events.length ? (
                          <ol>
                            {detail.events.map((e) => (
                              <li key={e.id}>
                                <span className="timeline-dot" />
                                <div>
                                  <strong>{label(e.type)}</strong>
                                  <p>
                                    {e.nextState
                                      ? label(e.nextState)
                                      : "Audit recorded"}{" "}
                                    · {e.actor}
                                  </p>
                                </div>
                                <time dateTime={e.createdAt}>
                                  {date(e.createdAt)}
                                </time>
                              </li>
                            ))}
                          </ol>
                        ) : (
                          <p className="fine">No audit events yet.</p>
                        )}
                      </section>
                    </>
                  )}
                </section>
              </div>
            </>
          )}
          {auth.account && (
            <section className="wallet-section">
              <h2>JAW account</h2>
              <p className="hash">{auth.account.address}</p>
              <button
                className="secondary"
                disabled={busy || auth.status === "signing-out"}
                onClick={() => void perform(auth.signOut)}
              >
                {auth.status === "signing-out" ? "Signing out…" : "Sign out"}
              </button>
            </section>
          )}
          <section className="connections" id="services">
            <h2>Connection status</h2>
            <p className="fine">
              Live backend configuration. Availability is not proof of a
              successful provider operation.
            </p>
            <div>
              {ready?.services.map((s) => (
                <div className="connection" key={s.name}>
                  <strong>{s.name}</strong>
                  <span className={s.ready ? "available" : "unavailable"}>
                    {s.ready ? "Configured" : "Unavailable"}
                  </span>
                  {s.reason && <small>{s.reason}</small>}
                </div>
              )) ?? <p>Service status unavailable.</p>}
            </div>
          </section>
          <footer>
            HumanOS <span>Human authority, at every step.</span>
          </footer>
        </main>
      </div>
      {proof && (
        <IDKitRequestWidget
          open
          onOpenChange={(open) => {
            if (!open) {
              const pending = proof;
              setProof(null);
              if (
                pending.actionId &&
                verifiedRequest.current !== pending.request.requestId
              ) {
                void perform(async () =>
                  setDetail(
                    await api<MissionDetailResponse>(
                      `/actions/${encodeURIComponent(pending.actionId!)}/approval/cancel`,
                      {},
                    ),
                  ),
                );
              }
            }
          }}
          app_id={proof.request.appId as `app_${string}`}
          action={proof.request.action}
          rp_context={proof.request.rpContext as unknown as RpContext}
          environment={proof.request.environment}
          allow_legacy_proofs={false}
          preset={proofOfHuman({ signal: proof.request.signal })}
          handleVerify={async (result) => {
            const p = proof;
            await api(
              p.actionId
                ? `/actions/${encodeURIComponent(p.actionId)}/approval/verify`
                : "/world/root/verify",
              { requestId: p.request.requestId, proof: result },
            );
            verifiedRequest.current = p.request.requestId;
          }}
          onSuccess={() => {
            setProof(null);
            void perform(auth.refresh);
          }}
          onError={(e) =>
            setError(`World verification did not complete: ${String(e)}`)
          }
        />
      )}
    </div>
  );
}
createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
);
