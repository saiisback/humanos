import { useEffect, useRef, useState } from "react";
import type { Workflow, WorkflowDetailResponse, WorkflowRun, WorkflowRunDetailResponse, JsonValue, WorkflowConnection, WorkflowConnectionsResponse } from "@humanos/schemas";
import { hotelIntake, hotelRequestText } from "@humanos/schemas";
import { WorkflowConnections } from "./connections";
import { EnsTaskStart } from "./ens-start";
import { CompletedTask } from "./completed-task";
import { RunBrowserHandoff } from "./browser-handoff";
import { WorkflowAgentPanel, identityNavigation, ownedDetail, runGate, workflowSearch, type Load, type WorkflowAgentDetailResponse } from "./agent-panel";
import { api, ApiError } from "../../lib/api";
import { RefineCard, planStatus } from "./refine-card";
import { useAuth } from "../auth/use-auth";
import { Composer } from "../chat/composer";
import { AppShell } from "../shell/app-shell";
import { WorkflowReview, OutputView, ConfirmationPreview, blockLabel } from "./workflow-review";
import { ScheduleEditor } from "./schedule-editor";
import { selectionStillCurrent, runSelectionAction } from "./selection-fence";

const terminal = new Set(["COMPLETED", "FAILED", "CANCELLED", "REVOKED", "RECONCILIATION_REQUIRED"]);
export function WorkflowWorkspace() {
  const auth = useAuth();
  const account = useRef(auth.account?.id); account.current = auth.account?.id;
  const [workflows, setWorkflows] = useState<Workflow[]>([]);
  const [detail, setDetail] = useState<WorkflowDetailResponse | null>(null);
  const [run, setRun] = useState<WorkflowRunDetailResponse | null>(null);
  const [outputs, setOutputs] = useState<Array<{ stepRunId: string; output: JsonValue }>>([]);
  const [preview, setPreview] = useState<{ confirmation: { id: string; payloadHash: string }; preview: JsonValue } | null>(null);
  const [goal, setGoal] = useState("");
  const [busy, setBusy] = useState(false), [error, setError] = useState("");
  const [connections, setConnections] = useState<WorkflowConnection[] | null>(null);
  const [connectionsUnavailable, setConnectionsUnavailable] = useState(false);
  const [agent, setAgent] = useState<Load<WorkflowAgentDetailResponse>>({ status: "loading" });
  const [identityOpen, setIdentityOpen] = useState(() => new URLSearchParams(location.search).has("identity"));
  const requestKey = useRef<string | null>(null);
  const selectedId = useRef<string | null>(null);
  const generation = useRef(0);
  const current = (actor: string | undefined, selected: string | null, stamp: number) => selectionStillCurrent(
    { account: actor, selected, generation: stamp },
    { account: account.current, selected: selectedId.current, generation: generation.current },
  );
  const status = run?.run.status;
  const pendingAgent = agent.status === "ready" && agent.value.binding?.state === "PENDING_REGISTRATION";
  async function perform(fn: () => Promise<void>) {
    setBusy(true); setError("");
    try { await fn(); } catch (cause) { setError(cause instanceof Error ? cause.message : "The request could not complete."); }
    finally { setBusy(false); }
  }
  async function refreshList() {
    const actor = account.current;
    if (!actor) return;
    const response = await api<{ workflows: Workflow[] }>("/workflows");
    if (actor === account.current) setWorkflows(response.workflows);
  }
  async function loadRun(id: string) {
    const actor = account.current, selected = selectedId.current, stamp = generation.current;
    const response = await api<WorkflowRunDetailResponse>(`/workflow-runs/${encodeURIComponent(id)}`);
    const values = await api<{ outputs: Array<{ stepRunId: string; output: JsonValue }> }>(`/workflow-runs/${encodeURIComponent(id)}/outputs`);
    const confirmation = response.confirmations.filter(c => c.status === "PENDING" && Date.parse(c.expiresAt) > Date.now()).at(-1);
    const prepared = confirmation ? await api<typeof preview>(`/workflow-confirmations/${encodeURIComponent(confirmation.id)}`) : null;
    if (!current(actor, selected, stamp)) return;
    setRun(response); setOutputs(values.outputs); setPreview(prepared);
  }
  async function select(id: string) {
    selectedId.current = id; generation.current++; requestKey.current = null; setRun(null); setOutputs([]); setPreview(null); setAgent({ status: "loading" });
    const actor = account.current, stamp = generation.current;
    const response = await api<WorkflowDetailResponse>(`/workflows/${encodeURIComponent(id)}`);
    if (!current(actor, id, stamp)) return;
    setDetail(response);
    history.replaceState(history.state, "", workflowSearch(id, new URLSearchParams(location.search).has("identity")));
    void refreshAgent(id);
    const runs = await api<{ runs: WorkflowRun[] }>(`/workflows/${encodeURIComponent(id)}/runs`);
    if (runs.runs[0] && current(actor, id, stamp)) await loadRun(runs.runs[0].id);
  }
  async function refreshConnections() {
    const actor = account.current;
    if (!actor) return;
    try {
      const response = await api<WorkflowConnectionsResponse>("/workflow-connections");
      if (actor === account.current && response.accountId === actor) { setConnections(response.connections); setConnectionsUnavailable(false); }
    } catch { if (actor === account.current) { setConnections(null); setConnectionsUnavailable(true); } }
  }
  async function refreshAgent(id: string) {
    const actor = account.current, stamp = generation.current;
    try {
      const response = await api<WorkflowAgentDetailResponse>(`/workflows/${encodeURIComponent(id)}/agent`);
      if (!current(actor, id, stamp)) return;
      const owned = actor ? ownedDetail(response, actor, id) : null;
      setAgent(owned ? { status: "ready", value: owned } : { status: "unavailable", message: "Agent records did not match this account and workflow." });
    } catch (cause) {
      if (current(actor, id, stamp)) setAgent({ status: "unavailable", message: cause instanceof Error ? cause.message : "ENS agent status is unavailable." });
    }
  }
  useEffect(() => {
    generation.current++; selectedId.current = null; setDetail(null); setRun(null); setOutputs([]); setPreview(null); setWorkflows([]); setAgent({ status: "loading" });
    setConnections(null); setConnectionsUnavailable(false);
    if (auth.account) void refreshConnections();
    if (auth.account) void perform(async () => { await refreshList(); const id = new URLSearchParams(location.search).get("workflow"); if (id) await select(id); });
  }, [auth.account?.id]);
  useEffect(() => {
    if (!run || terminal.has(run.run.status)) return;
    let active = true, pending = false;
    const timer = setInterval(() => {
      if (!active || pending) return;
      pending = true;
      void loadRun(run.run.id).catch(cause => { if (active) setError(cause instanceof Error ? cause.message : String(cause)); }).finally(() => { pending = false; });
    }, 1800);
    return () => { active = false; clearInterval(timer); };
  }, [run?.run.id, status]);
  useEffect(() => {
    const sync = () => setIdentityOpen(new URLSearchParams(location.search).has("identity"));
    addEventListener("popstate", sync);
    return () => removeEventListener("popstate", sync);
  }, []);
  // Refresh authority independently from execution. A namespace reset must never rerun a task.
  useEffect(() => {
    const id = detail?.workflow.id;
    if (!id || !pendingAgent) return;
    let loading = false;
    const timer = setInterval(() => {
      if (loading) return;
      loading = true;
      void refreshAgent(id).finally(() => { loading = false; });
    }, 5000);
    return () => clearInterval(timer);
  }, [detail?.workflow.id, auth.account?.id, pendingAgent]);
  function setIdentity(open: boolean) {
    const next = identityNavigation(location.search, history.state, open);
    if (next.kind === "back") { history.back(); return; }
    if (next.kind === "push") history.pushState({ humanosIdentity: true }, "", next.url);
    if (next.kind === "replace") history.replaceState(null, "", next.url || location.pathname);
    setIdentityOpen(open);
  }
  const latest = detail?.versions.at(-1);
  const completedLatest = status === "COMPLETED" && run?.run.workflowVersionId === latest?.id;
  const hotelFollowup = !!latest && !!planStatus(latest) && hotelIntake(latest.goal).isHotel;
  const gate = latest ? runGate(agent, latest.id, Date.now(), detail?.workflow.authorityRequirement === "ens") : null;
  const needsEnsStart = detail?.workflow.authorityRequirement === "ens" &&
    agent.status === "ready" && (!agent.value.bindings.length || agent.value.binding?.state === "PENDING_REGISTRATION");
  async function actOnRun(action: "confirm" | "resume" | "cancel", body: unknown = {}) {
    if (!run || !detail) return;
    const id = run.run.id;
    const captured = { account: auth.account?.id, selected: detail.workflow.id, generation: generation.current };
    await runSelectionAction(captured,
      () => ({ account: account.current, selected: selectedId.current, generation: generation.current }),
      () => api(`/workflow-runs/${id}/${action}`, body),
      () => loadRun(id));
  }
  async function assemble(id: string) {
    const actor = account.current, stamp = generation.current;
    let response: WorkflowDetailResponse;
    try { response = await api<WorkflowDetailResponse>(`/workflows/${id}/assemble`, {}); }
    catch (cause) {
      // A planner stop is recorded on the saved request; show its diagnostics and edit box.
      if (cause instanceof ApiError && ["REVIEW_REQUIRED", "NO_CANDIDATES"].includes(cause.code)) {
        const saved = await api<WorkflowDetailResponse>(`/workflows/${encodeURIComponent(id)}`).catch(() => null);
        if (saved && current(actor, id, stamp)) setDetail(saved);
      }
      throw cause;
    }
    if (!current(actor, id, stamp)) return;
    setDetail(response);
    await refreshList();
  }
  async function refine(id: string, text: string) {
    const actor = account.current, stamp = generation.current;
    const response = await api<WorkflowDetailResponse>(`/workflows/${encodeURIComponent(id)}/refine`, { goal: text });
    if (!current(actor, id, stamp)) return;
    requestKey.current = null;
    setDetail(response);
    await assemble(id);
  }
  async function create() {
    // A hotel reply belongs to the saved task. Use its field-bound follow-up
    // controls, never accidentally POST a second unrelated workflow.
    if (hotelFollowup) return;
    const actor = account.current, stamp = generation.current;
    const response = await api<WorkflowDetailResponse>("/workflows", { goal: goal.trim() });
    if (actor !== account.current || stamp !== generation.current) return;
    generation.current++; selectedId.current = response.workflow.id; requestKey.current = null;
    setDetail(response); setRun(null); setOutputs([]); setPreview(null); setGoal(""); setAgent({ status: "loading" });
    history.replaceState(null, "", `?workflow=${response.workflow.id}`);
    void refreshAgent(response.workflow.id);
    await refreshList(); await assemble(response.workflow.id);
  }
  async function startRun(registered?: WorkflowAgentDetailResponse) {
    if (!detail || !latest) return;
    const actor = account.current, selected = detail.workflow.id, stamp = generation.current;
    if (!current(actor, selected, stamp)) return;
    const authority = registered ? { status: "ready" as const, value: registered } : agent;
    const executionGate = runGate(authority, latest.id);
    if (!executionGate.allowed) return;
    if (detail.workflow.authorityRequirement === "ens" && executionGate.mode !== "ens") return;
    if (registered) setAgent(authority);
    if (!latest.activatedAt) {
      const activated = await api<WorkflowDetailResponse>(`/workflows/${selected}/activate`, { versionId: latest.id, expectedGraphHash: latest.graphHash });
      if (!current(actor, selected, stamp)) return;
      setDetail(activated);
    }
    requestKey.current ??= crypto.randomUUID();
    const key = requestKey.current;
    const result = await api<WorkflowRunDetailResponse>(`/workflows/${selected}/runs`, { input: {} }, { idempotencyKey: key });
    if (!current(actor, selected, stamp) || requestKey.current !== key) return;
    setRun(result); setOutputs([]); setPreview(null); await refreshList();
    requestKey.current = null;
  }
  const labels: Record<string, string> = { QUEUED: "Queued", RUNNING: "Working on it", COMPLETED: "Run complete", CONNECTION_REQUIRED: "Connect a service to continue", CONFIRMATION_REQUIRED: "Your final confirmation", INPUT_REQUIRED: "One detail is missing", RECONCILIATION_REQUIRED: "Outcome needs checking — not retried", WAITING: "Waiting", RETRY_SCHEDULED: "Retry scheduled", CANCELLED: "Cancelled", FAILED: "Run stopped", REVOKED: "Permission no longer available" };
  return <AppShell missions={[]} workflows={workflows} onSelectWorkflow={id => void perform(() => select(id))} selectedId={detail?.workflow.id ?? null} onSelect={() => {}} onNew={() => { generation.current++; selectedId.current = null; setDetail(null); setRun(null); setOutputs([]); setPreview(null); setAgent({ status: "loading" }); setError(""); history.replaceState(null, "", "/"); }} root={auth.root} account={auth.account} readiness={null} connectionsPanel={<WorkflowConnections connections={auth.account ? connections : null} unavailable={!auth.account || connectionsUnavailable} />}
    identityPanel={<WorkflowAgentPanel planReady={!!latest?.graph.nodes.length} workflowId={detail?.workflow.id ?? null} versionId={latest?.id ?? null} versions={detail?.versions.map(version => ({ id: version.id, version: version.version })) ?? []} account={auth.account} root={auth.root} onClose={() => setIdentity(false)} onChanged={async () => { const id = selectedId.current; if (id) await refreshAgent(id); }} />}
    identityOpen={identityOpen} onIdentityOpenChange={setIdentity}
    onSignOut={() => { generation.current++; void perform(auth.signOut); }} busy={busy} error={error} onRetry={() => void perform(async () => { await auth.refresh(); await refreshList(); await refreshConnections(); if (detail) await select(detail.workflow.id); })}
    composer={hotelFollowup ? <p className="fine" role="status">Answer the hotel questions above to continue this task. Choose New task in the sidebar to start something else.</p> : <Composer value={goal} onChange={setGoal} onSubmit={() => void perform(create)} disabled={busy || !auth.account} canSubmit={!!auth.account} preparing={busy && !!goal} providerNote="Jev selects audited steps · DeepSeek writes the content" />}>
    {!auth.account ? <section className="welcome"><div className="welcome-mark" aria-hidden="true">✳</div><h1>Make room for being human.</h1><p>Delegate the work. Keep the final say.</p><button disabled={busy || auth.status === "signing-in" || !auth.jawConfigured} onClick={() => void perform(auth.signIn)}>{auth.status === "signing-in" ? "Signing in…" : "Sign in with JAW"}</button>{!auth.jawConfigured && <button className="secondary" disabled={busy} onClick={() => void perform(auth.refresh)}>Retry connection</button>}</section> : !detail ? <section className="welcome"><div className="welcome-mark" aria-hidden="true">✳</div><h1>What can I take off your plate?</h1><p>One request. A saved workflow. You keep the final say.</p><div className="workflow-suggestions">{["Write a friendly introduction email draft", "Research a three-day Japan itinerary", "Send an email to someone"].map(text => <button key={text} className="secondary" onClick={() => setGoal(text)}>{text} ↗</button>)}</div><p className="fine">Drafts work with your model connection. Research and sending need their respective services.</p></section> : <div className="workflow-conversation">
      <div className="workflow-prompt">{latest && hotelRequestText(latest.goal)}</div>
      {busy && <p role="status" className="fine">Saving and preparing your workflow…</p>}
      {completedLatest && run && <CompletedTask outputs={outputs} pending={pendingAgent} canRun={!!gate?.allowed} busy={busy}
        transactionHash={agent.status === "ready" ? agent.value.binding?.registrationTxHashes.at(-1) : undefined}
        onRun={() => void perform(() => startRun())} onIdentity={() => setIdentity(true)}>
        <ol className="workflow-steps">{run.steps.map(step => <li key={step.id}><span>{blockLabel[step.blockType] ?? step.blockType}</span><small>{step.status.toLowerCase().replaceAll("_", " ")}</small></li>)}</ol>
        {run.receipts.map(receipt => <div className="workflow-receipt" key={receipt.id}><strong>{receipt.summary}</strong><p>{receipt.destination}</p><small>Provider reference: {receipt.providerReference ?? "Recorded receipt"}</small></div>)}
        {latest?.activatedAt && <ScheduleEditor workflowId={detail.workflow.id} versionId={latest.id} schedules={detail.schedules} onChanged={async () => { if (account.current && selectedId.current === detail.workflow.id) await select(detail.workflow.id); }} />}
      </CompletedTask>}
      {!completedLatest && <>
      {latest && planStatus(latest) ? <RefineCard version={latest} busy={busy} onRefine={text => void perform(() => refine(detail.workflow.id, text))} onRetry={() => void perform(() => assemble(detail.workflow.id))} />
        : latest && <WorkflowReview version={latest} busy={busy || !gate?.allowed || !!run && !terminal.has(run.run.status)} onRun={() => void perform(() => startRun())} startControl={needsEnsStart && auth.account ? <EnsTaskStart key={`${auth.account.id}:${auth.root?.id}:${detail.workflow.id}:${latest.id}`} pending={agent.status === "ready" ? agent.value.binding : null} accountId={auth.account.id} rootId={auth.root?.id ?? null} workflowId={detail.workflow.id} versionId={latest.id} busy={busy} onStart={registered => startRun(registered)} /> : undefined} />}
      {detail.workflow.authorityRequirement !== "ens" && !!latest?.graph.nodes.length && !planStatus(latest) && agent.status === "ready" && !agent.value.bindings.length && <p className="fine"><button className="agent-link" onClick={() => setIdentity(true)}>Enable ENS agent</button> to review this version’s scope and expiry before running with delegated authority. Until then, runs are account-only.</p>}
      {latest?.activatedAt && <ScheduleEditor workflowId={detail.workflow.id} versionId={latest.id} schedules={detail.schedules} onChanged={async () => { if (account.current && selectedId.current === detail.workflow.id) await select(detail.workflow.id); }} />}
      {run && <section className="workflow-card" aria-label="Run timeline"><h2 role="status">{labels[run.run.status] ?? run.run.status}</h2>{run.run.pauseReason && <p>{run.run.pauseReason}</p>}<RunBrowserHandoff run={run} version={detail?.versions.find(v => v.id === run.run.workflowVersionId)} preview={preview?.preview ?? null} accountLabel={auth.account?.id ?? "this account"} /><ol className="workflow-steps">{run.steps.map(step => <li key={step.id}><span>{blockLabel[step.blockType] ?? step.blockType}</span><small>{step.status.toLowerCase().replaceAll("_", " ")}</small></li>)}</ol>
        {outputs.map(output => <OutputView key={output.stepRunId} value={output.output} />)}
        {preview && status === "CONFIRMATION_REQUIRED" && <section className="workflow-confirm" aria-label="Exact action confirmation"><h3>Review exactly what will happen</h3><ConfirmationPreview value={preview.preview} /><button disabled={busy} onClick={() => void perform(() => actOnRun("confirm", { confirmationId: preview.confirmation.id, expectedPayloadHash: preview.confirmation.payloadHash }))}>Confirm this exact action</button></section>}
        {!preview && status === "CONFIRMATION_REQUIRED" && <section className="workflow-confirm" aria-label="Refresh confirmation"><p>The confirmation expired or is unavailable. Refresh it to review the current details. Refreshing does not send or submit anything.</p><button disabled={busy} onClick={() => void perform(() => actOnRun("resume"))}>Refresh confirmation</button></section>}
        {run.receipts.map(receipt => <div className="workflow-receipt" key={receipt.id}><strong>{receipt.summary}</strong><p>{receipt.destination}</p><small>Provider reference: {receipt.providerReference ?? "Recorded receipt"}</small></div>)}
        <div className="workflow-actions">{["CONNECTION_REQUIRED", "WAITING", "RETRY_SCHEDULED"].includes(status ?? "") && <button className="secondary" disabled={busy} onClick={() => void perform(() => actOnRun("resume"))}>Retry after resolving</button>}{!terminal.has(run.run.status) && <button className="secondary" disabled={busy} onClick={() => void perform(() => actOnRun("cancel"))}>Cancel run</button>}</div>
      </section>}
      <p className="fine agent-summary" role={gate && !gate.allowed ? "status" : undefined}>{gate?.note} <button className="agent-link" onClick={() => setIdentity(true)}>Identity & permissions</button></p>
      </>}
    </div>}
  </AppShell>;
}
