import { useEffect, useRef, useState } from "react";
import type { RootIdentity, WalletAccount } from "@humanos/schemas";
import { api } from "../../lib/api";

// Public DTO projection; the server validates persisted bindings before returning them.
export type WorkflowAgentState =
  | "PENDING_REGISTRATION"
  | "ACTIVE"
  | "REVOKING"
  | "REVOKED"
  | "FAILED"
  | "EXPIRED";
export interface WorkflowAgentBinding {
  id: string;
  accountId: string;
  rootId: string;
  workflowId: string;
  versionId: string;
  graphHash: string;
  capabilities: string[];
  expiresAt: string;
  generation: number;
  derivationId: string;
  chainId: 11155111;
  ensName: string | null;
  node: string | null;
  agentAddress: string | null;
  state: WorkflowAgentState;
  revision: number;
  registrationTxHashes: string[];
  revocationTxHashes: string[];
  createdAt: string;
  updatedAt: string;
}
export interface WorkflowAgentReview {
  id: string;
  reviewHash: string;
  workflowId: string;
  versionId: string;
  capabilities: string[];
  expiresAt: string;
  reviewExpiresAt: string;
  chainId: 11155111;
  parentName: string;
  rootId: string;
  accountId: string;
}
export interface WorkflowAgentListResponse {
  bindings: WorkflowAgentBinding[];
  available: boolean;
}
export interface WorkflowAgentDetailResponse {
  binding: WorkflowAgentBinding | null;
  bindings: WorkflowAgentBinding[];
  available: boolean;
  receiptPublications?: Array<{
    runId: string;
    receiptHash: string;
    state: string;
    txHashes: string[];
  }>;
}

export type Load<T> =
  | { status: "loading" }
  | { status: "unavailable"; message: string }
  | { status: "ready"; value: T };
export interface AgentScope {
  accountId: string | null;
  workflowId: string | null;
  generation: number;
}
export type RunGate =
  | { allowed: true; mode: "account" | "ens"; note: string }
  | { allowed: false; note: string };

const SEPOLIA = 11155111;
const terminalStates = new Set<WorkflowAgentState>([
  "REVOKED",
  "FAILED",
  "EXPIRED",
]);
const pendingStates = new Set<WorkflowAgentState>([
  "PENDING_REGISTRATION",
  "REVOKING",
]);
const txPattern = /^0x[0-9a-fA-F]{64}$/;
const custody =
  "HumanOS's backend operator derives and holds this agent's signing key; it is not in your JAW wallet. The agent can act only within the listed scope and write status and receipt records — no spending or name administration.";
const mismatch =
  "The server returned agent records that do not belong to this account and workflow, so they were not shown.";
const describe = (cause: unknown) =>
  cause instanceof Error ? cause.message : "The request could not complete.";
const when = (value: string) => {
  const time = Date.parse(value);
  return Number.isFinite(time)
    ? new Date(time).toLocaleString(undefined, {
        dateStyle: "medium",
        timeStyle: "short",
      })
    : "Unknown time";
};
const nameOf = (binding: WorkflowAgentBinding) =>
  binding.ensName ??
  (binding.state === "PENDING_REGISTRATION"
    ? "Name pending"
    : "Name never assigned");

/** `?identity=1` now opens the workspace panel; only explicit legacy/mission links (or the e2e default) mount the mission app. */
export function usesLegacyApp(search: string, mode: string): boolean {
  const params = new URLSearchParams(search);
  if (params.has("legacy") || params.has("mission")) return true;
  return mode === "e2e" && !params.has("workflow") && !params.has("identity");
}
export function workflowSearch(workflowId: string, identity: boolean): string {
  const params = new URLSearchParams({ workflow: workflowId });
  if (identity) params.set("identity", "1");
  return `?${params}`;
}
/** Opening pushes a history entry so Back closes the panel; a panel opened from a deep link closes in place. */
export function identityNavigation(
  search: string,
  state: unknown,
  open: boolean,
):
  | { kind: "push" | "replace"; url: string }
  | { kind: "back" }
  | { kind: "none" } {
  const params = new URLSearchParams(search);
  if (open === params.has("identity")) return { kind: "none" };
  if (open) {
    params.set("identity", "1");
    return { kind: "push", url: `?${params}` };
  }
  if (
    state &&
    typeof state === "object" &&
    (state as { humanosIdentity?: unknown }).humanosIdentity === true
  )
    return { kind: "back" };
  params.delete("identity");
  const rest = params.toString();
  return { kind: "replace", url: rest ? `?${rest}` : "" };
}

export function sameScope(a: AgentScope, b: AgentScope): boolean {
  return (
    a.accountId === b.accountId &&
    a.workflowId === b.workflowId &&
    a.generation === b.generation
  );
}
export async function fenced<T>(
  request: () => Promise<T>,
  captured: AgentScope,
  current: () => AgentScope,
): Promise<T | null> {
  if (!sameScope(captured, current())) return null;
  const value = await request();
  return sameScope(captured, current()) ? value : null;
}
export function ownedDetail(
  response: WorkflowAgentDetailResponse,
  accountId: string,
  workflowId: string,
): WorkflowAgentDetailResponse | null {
  const owned = (item: WorkflowAgentBinding) =>
    item.accountId === accountId &&
    item.workflowId === workflowId &&
    item.chainId === SEPOLIA;
  if (response.binding && !owned(response.binding)) return null;
  return response.bindings.every(owned) ? response : null;
}
export function ownedList(
  response: WorkflowAgentListResponse,
  accountId: string,
): WorkflowAgentListResponse | null {
  return response.bindings.every(
    (item) => item.accountId === accountId && item.chainId === SEPOLIA,
  )
    ? response
    : null;
}
export function ownedReview(
  review: WorkflowAgentReview,
  accountId: string,
  workflowId: string,
  versionId: string,
): boolean {
  return (
    review.accountId === accountId &&
    review.workflowId === workflowId &&
    review.versionId === versionId &&
    review.chainId === SEPOLIA
  );
}

export function agentStatus(
  binding: WorkflowAgentBinding,
  available: boolean,
  now = Date.now(),
): {
  label: string;
  tone: "active" | "pending" | "stopped" | "unavailable";
  active: boolean;
} {
  switch (binding.state) {
    case "ACTIVE":
      if (Date.parse(binding.expiresAt) <= now)
        return {
          label: "Expired · no automatic renewal",
          tone: "stopped",
          active: false,
        };
      if (!available)
        return {
          label: "Chain check unavailable · not treated as active",
          tone: "unavailable",
          active: false,
        };
      if (!binding.ensName || !binding.agentAddress || !binding.node)
        return {
          label: "Registration evidence missing · not treated as active",
          tone: "unavailable",
          active: false,
        };
      return { label: "Active on Sepolia", tone: "active", active: true };
    case "PENDING_REGISTRATION":
      return {
        label: "Registration pending onchain",
        tone: "pending",
        active: false,
      };
    case "REVOKING":
      return {
        label: "Revoking · new actions blocked, onchain revocation pending",
        tone: "pending",
        active: false,
      };
    case "REVOKED":
      return { label: "Revoked", tone: "stopped", active: false };
    case "FAILED":
      return {
        label: "Registration failed · not registered",
        tone: "stopped",
        active: false,
      };
    case "EXPIRED":
      return {
        label: "Expired · no automatic renewal",
        tone: "stopped",
        active: false,
      };
  }
}

/** Account-only runs are offered only when the server confirms the workflow was never bound. */
export function runGate(
  load: Load<WorkflowAgentDetailResponse>,
  versionId: string,
  now = Date.now(),
  requireEns = false,
): RunGate {
  if (load.status === "loading")
    return { allowed: false, note: "Checking this workflow's ENS agent…" };
  if (load.status === "unavailable")
    return {
      allowed: false,
      note: "ENS agent status is unavailable, so runs stay paused. Nothing falls back to account-only mode.",
    };
  const { binding, bindings, available } = load.value;
  if (!binding && !bindings.length && requireEns)
    return { allowed: false, note: "ENS registration is included in task start. Nothing runs without verified agent authority." };
  if (!binding && bindings.length === 0)
    return {
      allowed: true,
      mode: "account",
      note: "Account-owned workflow · No ENS agent registered.",
    };
  if (!binding)
    return {
      allowed: false,
      note: "This workflow's earlier ENS agent is no longer active. Enable a replacement to run; it will not fall back to account-only mode.",
    };
  if (binding.versionId !== versionId)
    return {
      allowed: false,
      note: "The ENS agent is bound to an earlier version. Revoke it and enable a replacement to run this version.",
    };
  const status = agentStatus(binding, available, now);
  if (status.active)
    return {
      allowed: true,
      mode: "ens",
      note: `Runs as ${binding.ensName} on Sepolia.`,
    };
  return {
    allowed: false,
    note: `ENS agent: ${status.label}. Runs stay paused and will not fall back to account-only mode.`,
  };
}

export interface AgentActions {
  review(): void;
  enable(): void;
  cancelReview(): void;
  askRevoke(): void;
  revoke(): void;
  keepAgent(): void;
  retry(): void;
  close(): void;
}
export interface AgentViewProps {
  planReady?: boolean;
  account: WalletAccount | null;
  root: RootIdentity | null;
  workflowId: string | null;
  versionId: string | null;
  versions: Array<{ id: string; version: number }>;
  load: Load<WorkflowAgentDetailResponse>;
  list: Load<WorkflowAgentListResponse>;
  review: WorkflowAgentReview | null;
  confirmingRevoke: boolean;
  busy: boolean;
  error: string;
  now: number;
  actions: AgentActions;
}

function TxList({ hashes }: { hashes: string[] }) {
  if (!hashes.length) return <span className="fine">None recorded</span>;
  return (
    <ul className="agent-txs">
      {hashes.map((hash) => (
        <li key={hash}>
          {txPattern.test(hash) ? (
            <a
              className="hash"
              href={`https://sepolia.etherscan.io/tx/${hash}`}
              target="_blank"
              rel="noopener noreferrer"
            >
              {hash}
            </a>
          ) : (
            <span className="hash">{hash}</span>
          )}
        </li>
      ))}
    </ul>
  );
}
function Scope({ capabilities }: { capabilities: string[] }) {
  return capabilities.length ? (
    <ul className="agent-scope">
      {capabilities.map((capability) => (
        <li key={capability} className="hash">
          {capability}
        </li>
      ))}
    </ul>
  ) : (
    <span className="fine">No capabilities</span>
  );
}
function BindingCard({
  binding,
  available,
  now,
  version,
}: {
  binding: WorkflowAgentBinding;
  available: boolean;
  now: number;
  version: string;
}) {
  const status = agentStatus(binding, available, now);
  const unassigned = "Assigned after registration confirms";
  return (
    <div className="agent-state" data-tone={status.tone}>
      <strong role="status">{status.label}</strong>
      <dl className="workflow-exact">
        <dt>Agent name</dt>
        <dd className="hash">{binding.ensName ?? unassigned}</dd>
        <dt>Controller</dt>
        <dd className="hash">{binding.agentAddress ?? unassigned}</dd>
        <dt>Network</dt>
        <dd>{`Sepolia testnet · chain ${binding.chainId}`}</dd>
        <dt>Scope</dt>
        <dd>
          <Scope capabilities={binding.capabilities} />
        </dd>
        <dt>Expires</dt>
        <dd>{`${when(binding.expiresAt)} · no automatic renewal`}</dd>
        <dt>Bound to</dt>
        <dd>
          {version}
          <br />
          <small>{`Generation ${binding.generation}`}</small>
          <br />
          <small className="hash">{binding.graphHash}</small>
        </dd>
        <dt>Registration</dt>
        <dd>
          <TxList hashes={binding.registrationTxHashes} />
        </dd>
        {(binding.revocationTxHashes.length > 0 ||
          binding.state === "REVOKING" ||
          binding.state === "REVOKED") && (
          <>
            <dt>Revocation</dt>
            <dd>
              <TxList hashes={binding.revocationTxHashes} />
            </dd>
          </>
        )}
      </dl>
      <p className="fine">Custody: {custody}</p>
      {binding.state === "REVOKING" && (
        <p className="fine">
          New actions are blocked. Cancelling a pending registration may first
          settle its original journaled transactions, using Sepolia gas, before
          revocation is confirmed.
        </p>
      )}
    </div>
  );
}
function ReviewBlock({
  review,
  version,
  busy,
  now,
  actions,
}: {
  review: WorkflowAgentReview;
  version: string;
  busy: boolean;
  now: number;
  actions: AgentActions;
}) {
  const expired = Date.parse(review.reviewExpiresAt) <= now;
  return (
    <section
      className="workflow-confirm"
      aria-label="ENS agent registration review"
    >
      <h3>{`Register an ENS agent for ${version}`}</h3>
      <dl className="workflow-exact">
        <dt>Under</dt>
        <dd className="hash">{review.parentName}</dd>
        <dt>Network</dt>
        <dd>{`Sepolia testnet · chain ${review.chainId}`}</dd>
        <dt>Scope</dt>
        <dd>
          <Scope capabilities={review.capabilities} />
        </dd>
        <dt>Agent expires</dt>
        <dd>{`${when(review.expiresAt)} · no automatic renewal`}</dd>
        <dt>Review valid until</dt>
        <dd>{when(review.reviewExpiresAt)}</dd>
      </dl>
      <p className="fine">Custody: {custody}</p>
      <p className="fine">
        Registering creates one agent for exactly this scope. Registration and
        agent funding can require several operator-funded Sepolia transactions.
        It does not start a run; sends and submissions still need your exact
        final confirmation.
      </p>
      {expired && (
        <p role="alert">This review expired. Cancel and review again.</p>
      )}
      <div className="workflow-actions">
        <button disabled={busy || expired} onClick={actions.enable}>
          Register ENS agent
        </button>
        <button
          className="secondary"
          disabled={busy}
          onClick={actions.cancelReview}
        >
          Cancel
        </button>
      </div>
    </section>
  );
}
function AgentDetail({
  planReady = true,
  root,
  versionId,
  versions,
  load,
  review,
  confirmingRevoke,
  busy,
  now,
  actions,
}: AgentViewProps) {
  if (load.status === "loading")
    return (
      <p role="status" className="fine">
        Checking this workflow's ENS agent…
      </p>
    );
  if (load.status === "unavailable")
    return (
      <div className="agent-state" data-tone="unavailable" role="status">
        <strong>ENS agent status unavailable</strong>
        <p className="fine">
          {load.message} No agent is assumed active and runs stay paused.
        </p>
        <button className="secondary" disabled={busy} onClick={actions.retry}>
          Check again
        </button>
      </div>
    );
  const { binding, bindings, available } = load.value;
  const earlier = bindings.filter((item) => item.id !== binding?.id);
  const label = (id: string) => {
    const match = versions.find((item) => item.id === id);
    return match
      ? `Version ${match.version}${id === versionId ? " (current)" : ""}`
      : "Earlier version";
  };
  const replacing = bindings.length > 0;
  const canReview =
    planReady &&
    available &&
    !!root &&
    !!versionId &&
    !review &&
    (!binding || terminalStates.has(binding.state));
  return (
    <>
      {!planReady && <p role="status" className="fine">Prepare an executable workflow before enabling an ENS agent. Missing connectors must be installed first; ENS permissions do not add booking support.</p>}
      {!available && (
        <p role="status" className="fine">
          ENS is unavailable right now. Stored records are shown, nothing is
          treated as active and no registration can start.
        </p>
      )}
      {binding ? (
        <BindingCard
          binding={binding}
          available={available}
          now={now}
          version={label(binding.versionId)}
        />
      ) : (
        <div className="agent-state" data-tone="none">
          <strong>
            {replacing ? "No current ENS agent" : "No ENS agent registered"}
          </strong>
          <p className="fine">
            {replacing
              ? "Earlier agents are listed below. This workflow will not fall back to account-only runs."
              : "Runs use your account only. Enabling an ENS agent registers a scoped Sepolia name for this exact version."}
          </p>
        </div>
      )}
      {binding?.state === "FAILED" && (
        <p className="fine">
          Registration did not complete, so nothing runs as this agent. Review a
          new registration to recover.
        </p>
      )}
      {!!load.value.receiptPublications?.length && (
        <section aria-label="ENS receipt publications">
          <h3>ENS receipt publications</h3>
          <p className="fine">
            Latest 20 publications. Only receipt hashes are written onchain.
          </p>
          <ul className="agent-txs">
            {load.value.receiptPublications.map((item) => (
              <li key={`${item.runId}:${item.receiptHash}`}>
                <span>{item.state}</span>
                <p className="hash">{item.receiptHash}</p>
                <TxList hashes={item.txHashes} />
              </li>
            ))}
          </ul>
        </section>
      )}
      {binding?.state === "ACTIVE" &&
        versionId &&
        binding.versionId !== versionId && (
          <p className="fine">
            This agent is bound to an earlier version. Revoke it, then enable a
            replacement for the current version.
          </p>
        )}
      {!root && (!binding || terminalStates.has(binding.state)) && (
        <p className="fine">
          Verify your World root before enabling an ENS agent.
        </p>
      )}
      {review ? (
        <ReviewBlock
          review={review}
          version={label(review.versionId)}
          busy={busy}
          now={now}
          actions={actions}
        />
      ) : (
        canReview && (
          <div className="workflow-actions">
            <button disabled={busy} onClick={actions.review}>
              {replacing ? "Review replacement agent" : "Enable ENS agent"}
            </button>
          </div>
        )
      )}
      {binding &&
        ["ACTIVE", "PENDING_REGISTRATION"].includes(binding.state) &&
        (confirmingRevoke ? (
          <div
            className="workflow-confirm"
            role="group"
            aria-label="Confirm revocation"
          >
            <p>
              <strong>{`Revoke ${binding.ensName ?? "this agent"}?`}</strong>
            </p>
            <p className="fine">
              New and scheduled actions stop first and schedules pause, then
              HumanOS submits the onchain revocation. Actions already completed
              cannot be undone.
            </p>
            <div className="workflow-actions">
              <button disabled={busy} onClick={actions.revoke}>
                Revoke agent
              </button>
              <button
                className="secondary"
                disabled={busy}
                onClick={actions.keepAgent}
              >
                Keep agent
              </button>
            </div>
          </div>
        ) : (
          <div className="workflow-actions">
            <button
              className="secondary"
              disabled={busy}
              onClick={actions.askRevoke}
            >
              Revoke agent…
            </button>
          </div>
        ))}
      {earlier.length > 0 && (
        <details>
          <summary>{`Earlier agents (${earlier.length})`}</summary>
          <ul className="agent-list">
            {earlier.map((item) => (
              <li key={item.id}>
                <div>
                  <strong className="hash">{nameOf(item)}</strong>
                  <small>{`${agentStatus(item, available, now).label} · generation ${item.generation} · ${label(item.versionId)}`}</small>
                  <TxList
                    hashes={[
                      ...item.registrationTxHashes,
                      ...item.revocationTxHashes,
                    ]}
                  />
                </div>
              </li>
            ))}
          </ul>
        </details>
      )}
    </>
  );
}
function AgentList({
  load,
  now,
}: {
  load: Load<WorkflowAgentListResponse>;
  now: number;
}) {
  if (load.status === "loading")
    return (
      <p role="status" className="fine">
        Loading your ENS agents…
      </p>
    );
  if (load.status === "unavailable")
    return (
      <p
        role="status"
        className="fine"
      >{`ENS agent status is unavailable. ${load.message} No agent is assumed active.`}</p>
    );
  const { bindings, available } = load.value;
  return (
    <>
      <h3>Workflow agents</h3>
      {!available && (
        <p role="status" className="fine">
          ENS is unavailable right now; stored records are shown and none is
          treated as active.
        </p>
      )}
      {bindings.length ? (
        <ul className="agent-list">
          {bindings.map((item) => (
            <li key={item.id}>
              <a href={workflowSearch(item.workflowId, true)}>
                <strong className="hash">{nameOf(item)}</strong>
                <small>{`${agentStatus(item, available, now).label} · expires ${when(item.expiresAt)}`}</small>
              </a>
            </li>
          ))}
        </ul>
      ) : (
        <p className="fine">
          No ENS agents yet. Open a workflow to enable one for its approved
          version.
        </p>
      )}
    </>
  );
}

export function WorkflowAgentView(props: AgentViewProps) {
  const { account, root, workflowId, error, actions } = props;
  return (
    <section className="agent-panel" aria-labelledby="agent-panel-title">
      <h2 id="agent-panel-title">Identity & permissions</h2>
      <dl className="workflow-exact">
        <dt>JAW account</dt>
        <dd className="hash">{account?.address ?? "Not signed in"}</dd>
        <dt>World root</dt>
        <dd>
          {root ? (
            <>
              <span className="hash">{root.ensName ?? root.id}</span>
              <br />
              <small>
                {root.verificationEnvironment === "staging"
                  ? "Staging World ID · not production assurance"
                  : "Production World ID"}
              </small>
            </>
          ) : (
            "Not verified"
          )}
        </dd>
      </dl>
      {!account ? (
        <p className="fine">Sign in to manage ENS agents.</p>
      ) : workflowId ? (
        <AgentDetail {...props} />
      ) : (
        <AgentList load={props.list} now={props.now} />
      )}
      {error && <p role="alert">{error}</p>}
      <div className="workflow-actions">
        {workflowId && (
          <button className="secondary" onClick={actions.close}>
            Back to workflow
          </button>
        )}
        <a href="/?legacy=1">World ID & legacy missions</a>
      </div>
    </section>
  );
}

export function WorkflowAgentPanel({
  planReady = true,
  workflowId,
  versionId = null,
  versions = [],
  account = null,
  root = null,
  onClose,
  onChanged,
}: {
  planReady?: boolean;
  workflowId: string | null;
  versionId?: string | null;
  versions?: Array<{ id: string; version: number }>;
  account?: WalletAccount | null;
  root?: RootIdentity | null;
  onClose: () => void;
  onChanged: () => Promise<void>;
}) {
  const accountId = account?.id ?? null;
  const accountRef = useRef(accountId);
  accountRef.current = accountId;
  const workflowRef = useRef(workflowId);
  workflowRef.current = workflowId;
  const generation = useRef(0);
  const inflight = useRef(false);
  const observed = useRef<string | null>(null);
  const [load, setLoad] = useState<Load<WorkflowAgentDetailResponse>>({
    status: "loading",
  });
  const [list, setList] = useState<Load<WorkflowAgentListResponse>>({
    status: "loading",
  });
  const [review, setReview] = useState<WorkflowAgentReview | null>(null);
  const [confirmingRevoke, setConfirmingRevoke] = useState(false);
  const [busy, setBusy] = useState(false),
    [error, setError] = useState("");
  const scope = (): AgentScope => ({
    accountId: accountRef.current,
    workflowId: workflowRef.current,
    generation: generation.current,
  });

  async function refresh(captured: AgentScope) {
    const { accountId: actor, workflowId: selected } = captured;
    if (!actor) return;
    try {
      if (selected) {
        const response = await fenced(
          () =>
            api<WorkflowAgentDetailResponse>(
              `/workflows/${encodeURIComponent(selected)}/agent`,
            ),
          captured,
          scope,
        );
        if (!response) return;
        const owned = ownedDetail(response, actor, selected);
        setLoad(
          owned
            ? { status: "ready", value: owned }
            : { status: "unavailable", message: mismatch },
        );
        const state = owned?.binding
          ? `${owned.binding.id}:${owned.binding.state}:${owned.binding.revision}`
          : "none";
        if (observed.current !== null && observed.current !== state)
          void onChanged().catch(() => undefined);
        observed.current = state;
      } else {
        const response = await fenced(
          () => api<WorkflowAgentListResponse>("/workflow-agents"),
          captured,
          scope,
        );
        if (!response) return;
        const owned = ownedList(response, actor);
        setList(
          owned
            ? { status: "ready", value: owned }
            : { status: "unavailable", message: mismatch },
        );
      }
    } catch (cause) {
      if (!sameScope(captured, scope())) return;
      const next = { status: "unavailable" as const, message: describe(cause) };
      if (selected) setLoad(next);
      else setList(next);
    }
  }
  useEffect(() => {
    generation.current++;
    inflight.current = false;
    observed.current = null;
    setLoad({ status: "loading" });
    setList({ status: "loading" });
    setReview(null);
    setConfirmingRevoke(false);
    setBusy(false);
    setError("");
    void refresh(scope());
  }, [accountId, workflowId]);
  // Pending registration/revocation and unavailable chain state are re-read only while the panel is open.
  const polling =
    !!workflowId &&
    (load.status === "unavailable" ||
      (load.status === "ready" &&
        load.value.bindings
          .concat(load.value.binding ?? [])
          .some((item) => pendingStates.has(item.state))));
  useEffect(() => {
    if (!polling) return;
    let active = true,
      running = false;
    const timer = setInterval(() => {
      if (!active || running) return;
      running = true;
      void refresh(scope()).finally(() => {
        running = false;
      });
    }, 3000);
    return () => {
      active = false;
      clearInterval(timer);
    };
  }, [polling, accountId, workflowId]);

  async function act(work: (captured: AgentScope) => Promise<void>) {
    if (inflight.current) return;
    const captured = scope();
    inflight.current = true;
    setBusy(true);
    setError("");
    try {
      await work(captured);
    } catch (cause) {
      if (sameScope(captured, scope())) setError(describe(cause));
    } finally {
      if (sameScope(captured, scope())) {
        inflight.current = false;
        setBusy(false);
      }
    }
  }
  const actions: AgentActions = {
    review: () =>
      void act(async (captured) => {
        const { accountId: actor, workflowId: selected } = captured;
        if (!actor || !selected || !versionId || !planReady) return;
        const response = await fenced(
          () =>
            api<{ review: WorkflowAgentReview }>(
              `/workflows/${encodeURIComponent(selected)}/agent/review`,
              { versionId },
            ),
          captured,
          scope,
        );
        if (!response) return;
        if (!ownedReview(response.review, actor, selected, versionId))
          throw new Error(
            "The registration review did not match this account, workflow and version. Nothing was registered.",
          );
        setReview(response.review);
      }),
    // One consent: the reviewed hash is sent once; an identical retry returns the same binding server-side.
    enable: () =>
      void act(async (captured) => {
        const consented = review,
          { accountId: actor, workflowId: selected } = captured;
        if (!consented || !actor || !selected) return;
        const response = await fenced(
          () =>
            api<{ binding: WorkflowAgentBinding }>(
              `/workflows/${encodeURIComponent(selected)}/agent/enable`,
              {
                reviewId: consented.id,
                expectedReviewHash: consented.reviewHash,
              },
            ),
          captured,
          scope,
        );
        if (!response) return;
        setReview(null);
        if (
          response.binding.accountId !== actor ||
          response.binding.workflowId !== selected
        )
          throw new Error(mismatch);
        await refresh(captured);
        await onChanged();
      }),
    cancelReview: () => setReview(null),
    askRevoke: () => setConfirmingRevoke(true),
    keepAgent: () => setConfirmingRevoke(false),
    revoke: () =>
      void act(async (captured) => {
        const target = load.status === "ready" ? load.value.binding : null;
        if (
          !target ||
          !["ACTIVE", "PENDING_REGISTRATION"].includes(target.state) ||
          !captured.accountId
        )
          return;
        const response = await fenced(
          () =>
            api<{ binding: WorkflowAgentBinding }>(
              `/workflow-agents/${encodeURIComponent(target.id)}/revoke`,
              {},
            ),
          captured,
          scope,
        );
        if (!response) return;
        setConfirmingRevoke(false);
        await refresh(captured);
        await onChanged();
      }),
    retry: () => void refresh(scope()),
    close: onClose,
  };
  return (
    <WorkflowAgentView
      planReady={planReady}
      account={account}
      root={root}
      workflowId={workflowId}
      versionId={versionId}
      versions={versions}
      load={load}
      list={list}
      review={review}
      confirmingRevoke={confirmingRevoke}
      busy={busy}
      error={error}
      now={Date.now()}
      actions={actions}
    />
  );
}
