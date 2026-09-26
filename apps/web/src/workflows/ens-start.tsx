import React, { useEffect, useRef, useState } from "react";
import { api } from "../../lib/api";
import { runGate, type WorkflowAgentBinding, type WorkflowAgentDetailResponse, type WorkflowAgentReview } from "./agent-panel";

interface StartPorts {
  review: WorkflowAgentReview;
  current(): boolean;
  enable(): Promise<void>;
  read(): Promise<WorkflowAgentDetailResponse>;
  wait(): Promise<void>;
  start(detail: WorkflowAgentDetailResponse): Promise<void>;
}
/** Consent is supplied once; polling only reads the registration already requested. */
export async function registerAndStart(ports: StartPorts): Promise<void> {
  if (!ports.current()) return;
  if (Date.parse(ports.review.reviewExpiresAt) <= Date.now()) throw new Error("Review expired. Refresh the task review.");
  await ports.enable();
  await waitForRegisteredAgent({ ...ports, identity: ports.review });
}
export async function waitForRegisteredAgent(ports: Omit<StartPorts, "review" | "enable"> & {
  identity: Pick<WorkflowAgentReview, "accountId" | "workflowId" | "versionId" | "rootId">;
}): Promise<void> {
  // Sepolia finality can lag successful inclusion by multiple epochs.
  for (let i = 0; i < 240; i++) {
    if (!ports.current()) return;
    const detail = await ports.read();
    if (!ports.current()) return;
    const binding = detail.binding;
    if (!binding || binding.accountId !== ports.identity.accountId ||
        binding.workflowId !== ports.identity.workflowId || binding.versionId !== ports.identity.versionId ||
        binding.rootId !== ports.identity.rootId)
      throw new Error("Registration identity did not match this task. Nothing ran.");
    if (runGate({ status: "ready", value: detail }, ports.identity.versionId).allowed) {
      await ports.start(detail);
      return;
    }
    if (binding.state !== "PENDING_REGISTRATION")
      throw new Error("Agent authority is not active. Nothing ran; check Identity & permissions.");
    await ports.wait();
  }
  throw new Error("Registration is still awaiting chain confirmation. Nothing ran. Check status before starting again.");
}

export function EnsStartReview({ review, busy, onStart }: {
  review: WorkflowAgentReview; busy: boolean; onStart(): void;
}) {
  return <section className="workflow-confirm" aria-label="Task identity review">
    <h3>Your task runs with an ENS agent</h3>
    <dl className="workflow-exact">
      <dt>Network</dt><dd>Sepolia testnet · {review.chainId}</dd>
      <dt>Namespace</dt><dd>{review.parentName}</dd>
      <dt>Allowed work</dt><dd>{review.capabilities.join(" · ")}</dd>
      <dt>Access expires</dt><dd>{new Date(review.expiresAt).toLocaleString()}</dd>
    </dl>
    <p className="fine">Starting registers this task's scoped agent on Sepolia using operator-funded gas,
      then waits for verified authority before running. Agent keys are backend-managed.
      This does not grant wallet spending. Sending or booking still pauses for your exact final confirmation.</p>
    <button disabled={busy || Date.parse(review.reviewExpiresAt) <= Date.now()} onClick={onStart}>
      {busy ? "Registering and checking chain confirmation…" : "Start task · register on Sepolia"}
    </button>
  </section>;
}

export function EnsTaskStart({ accountId, rootId, workflowId, versionId, busy, onStart, pending }: {
  accountId: string; rootId: string | null; workflowId: string; versionId: string; busy: boolean;
  onStart(detail: WorkflowAgentDetailResponse): Promise<void>;
  pending?: WorkflowAgentBinding | null;
}) {
  const [review, setReview] = useState<WorkflowAgentReview | null>(null);
  const [error, setError] = useState("");
  const [working, setWorking] = useState(false);
  const [refresh, setRefresh] = useState(0);
  const alive = useRef(false), inFlight = useRef(false);
  useEffect(() => {
    alive.current = true;
    let cancelled = false;
    if (rootId && !pending) void api<{ review: WorkflowAgentReview }>(
      `/workflows/${encodeURIComponent(workflowId)}/agent/review`, { versionId },
    ).then(({ review: next }) => {
      if (cancelled) return;
      if (next.accountId !== accountId || next.rootId !== rootId || next.workflowId !== workflowId ||
          next.versionId !== versionId || next.chainId !== 11155111)
        throw new Error("Task identity review did not match. Nothing was registered.");
      setReview(next); setError("");
    }).catch(cause => { if (!cancelled) setError(cause instanceof Error ? cause.message : "ENS review unavailable."); });
    return () => { cancelled = true; alive.current = false; };
  }, [accountId, rootId, workflowId, versionId, refresh, pending?.id]);
  async function start() {
    if ((!review && !pending) || !rootId || inFlight.current || busy) return;
    inFlight.current = true; setWorking(true); setError("");
    try {
      const shared = {
        current: () => alive.current,
        read: () => api<WorkflowAgentDetailResponse>(`/workflows/${encodeURIComponent(workflowId)}/agent`),
        wait: () => new Promise<void>(resolve => setTimeout(resolve, 5000)),
        start: onStart,
      };
      if (pending) await waitForRegisteredAgent({ ...shared, identity: { accountId, rootId, workflowId, versionId } });
      else await registerAndStart({ ...shared, review: review!,
        enable: async () => { await api(`/workflows/${encodeURIComponent(workflowId)}/agent/enable`,
          { reviewId: review!.id, expectedReviewHash: review!.reviewHash }); },
      });
    } catch (cause) {
      if (alive.current) setError(cause instanceof Error ? cause.message : "Registration could not complete. Check its status.");
    } finally { inFlight.current = false; if (alive.current) setWorking(false); }
  }
  if (!rootId) return <p role="status">Link your human identity in Account before starting. This task requires an ENS agent; nothing will run account-only.</p>;
  return <>{pending ? <section className="workflow-confirm" aria-label="Task registration pending">
    <h3>Agent registration is pending finality</h3>
    <p className="hash">{pending.ensName ?? "Waiting for registration evidence"}</p>
    <p>HumanOS will not run until its onchain authority is verified. Checking again does not submit another registration.</p>
    <button disabled={busy || working} onClick={() => void start()}>{working ? "Waiting for finalized authority…" : "Check registration & start task"}</button>
  </section> : review ? <EnsStartReview review={review} busy={busy || working} onStart={() => void start()} /> :
    !error && <p role="status">Preparing your task's scoped ENS identity…</p>}
    {error && <p role="alert">{error}</p>}
    {!working && !pending && <button className="secondary" onClick={() => { setReview(null); setError(""); setRefresh(x => x + 1); }}>Refresh task review</button>}
  </>;
}
