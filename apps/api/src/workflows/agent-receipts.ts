import type { Database, WorkflowAgentStore } from "@humanos/database";
import type { WorkflowEnsPort } from "@humanos/ens";
import {
  hashCanonical,
  type Hex,
  type WorkflowReceipt,
} from "@humanos/schemas";

const HASH = /^0x[0-9a-f]{64}$/;
const COLUMNS = "id,binding_id,run_id,receipt_hash,state,attempts,tx_hashes";
export type ReceiptJobState = "PENDING" | "PUBLISHING" | "PUBLISHED" | "FAILED";
export interface WorkflowAgentReceiptJob {
  id: string;
  bindingId: string;
  runId: string;
  receiptHash: Hex;
  state: ReceiptJobState;
  attempts: number;
  txHashes: Hex[];
}
type JobRow = {
  id: string;
  binding_id: string;
  run_id: string;
  receipt_hash: Hex;
  state: ReceiptJobState;
  attempts: number;
  tx_hashes: Hex[];
};
const toJob = (row: JobRow): WorkflowAgentReceiptJob => ({
  id: row.id,
  bindingId: row.binding_id,
  runId: row.run_id,
  receiptHash: row.receipt_hash,
  state: row.state,
  attempts: row.attempts,
  txHashes: row.tx_hashes,
});

export interface WorkflowAgentReceiptDependencies {
  db: Database;
  agentStore: WorkflowAgentStore;
  ens: WorkflowEnsPort;
  clock?: () => Date;
  maxAttempts?: number;
  retryDelayMs?: number;
  leaseMs?: number;
  pollMs?: number;
}
/** Publishes opaque receipt hashes for ENS-pinned runs. Independent of execution: a retry here never
 * reruns a workflow effect, and a job is PUBLISHED only with an actual ENS write result. */
export function createWorkflowAgentReceipts(
  deps: WorkflowAgentReceiptDependencies,
) {
  const { db, agentStore, ens } = deps;
  const clock = deps.clock ?? (() => new Date());
  const maxAttempts = deps.maxAttempts ?? 8,
    retryDelayMs = deps.retryDelayMs ?? 5000;
  const leaseMs = deps.leaseMs ?? 300000,
    pollMs = deps.pollMs ?? 5000;
  if (
    !Number.isInteger(maxAttempts) ||
    maxAttempts < 1 ||
    retryDelayMs < 0 ||
    leaseMs < 1000 ||
    pollMs < 100
  )
    throw new Error("INVALID_RECEIPT_CONFIG");

  async function insert(
    bindingId: string,
    runId: string,
    receiptHash: string,
    sourceReceiptId: string | null = null,
  ): Promise<boolean> {
    if (!HASH.test(receiptHash)) throw new Error("INVALID_RECEIPT_HASH");
    // Only a run pinned to this exact binding may publish through it.
    const inserted = await db.query(
      `INSERT INTO workflow_agent_receipt_jobs(id,binding_id,run_id,receipt_hash,updated_at,source_receipt_id)
       SELECT $1,b.id,r.id,$4,$5,$6 FROM workflow_runs r
         JOIN workflow_agent_bindings b ON b.id=r.data->>'agentBindingId' AND b.workflow_id=r.workflow_id AND b.version_id=r.version_id
       WHERE r.id=$3 AND b.id=$2 AND r.data->>'authorityMode'='ens'
       ON CONFLICT DO NOTHING`,
      [
        hashCanonical({ bindingId, runId, receiptHash }),
        bindingId,
        runId,
        receiptHash,
        clock(),
        sourceReceiptId,
      ],
    );
    if (inserted.rowCount) return true;
    const existing = await db.query(
      "SELECT 1 FROM workflow_agent_receipt_jobs WHERE binding_id=$1 AND run_id=$2 AND receipt_hash=$3",
      [bindingId, runId, receiptHash],
    );
    if (!existing.rowCount) throw new Error("RECEIPT_RUN_MISMATCH");
    if (sourceReceiptId)
      await db.query(
        "UPDATE workflow_agent_receipt_jobs SET source_receipt_id=$4 WHERE binding_id=$1 AND run_id=$2 AND receipt_hash=$3 AND source_receipt_id IS NULL",
        [bindingId, runId, receiptHash, sourceReceiptId],
      );
    return false;
  }
  /** Reconciles durable receipts of ENS-pinned runs into jobs; only the canonical hash is retained. */
  async function scan(limit = 100): Promise<number> {
    const rows = await db.query<{
      binding_id: string;
      run_id: string;
      receipt_id: string;
      data: WorkflowReceipt;
    }>(
      `SELECT b.id AS binding_id, r.id AS run_id, x.id AS receipt_id, x.data FROM workflow_receipts x
         JOIN workflow_runs r ON r.id=x.run_id
         JOIN workflow_agent_bindings b ON b.id=r.data->>'agentBindingId' AND b.workflow_id=r.workflow_id AND b.version_id=r.version_id
       WHERE r.data->>'authorityMode'='ens'
         AND NOT EXISTS (SELECT 1 FROM workflow_agent_receipt_jobs j WHERE j.source_receipt_id=x.id)
       ORDER BY x.id LIMIT $1`,
      [limit],
    );
    let queued = 0;
    for (const row of rows.rows)
      if (
        await insert(
          row.binding_id,
          row.run_id,
          hashCanonical(row.data),
          row.receipt_id,
        )
      )
        queued++;
    return queued;
  }
  /** Fenced by attempt number: a reclaimed job cannot be overwritten by a stale publisher. */
  async function settle(
    job: WorkflowAgentReceiptJob,
    state: ReceiptJobState,
    txHashes: Hex[],
  ): Promise<WorkflowAgentReceiptJob | null> {
    const row = (
      await db.query<JobRow>(
        `UPDATE workflow_agent_receipt_jobs SET state=$3::text,updated_at=$5,
         tx_hashes=CASE WHEN $3::text='PUBLISHED' THEN $4::jsonb ELSE tx_hashes END
       WHERE id=$1 AND state='PUBLISHING' AND attempts=$2 RETURNING ${COLUMNS}`,
        [job.id, job.attempts, state, JSON.stringify(txHashes), clock()],
      )
    ).rows[0];
    return row ? toJob(row) : null;
  }
  async function publishNext(): Promise<WorkflowAgentReceiptJob | null> {
    const now = clock();
    // A crashed publisher at its final attempt leaves no evidence of publication.
    await db.query(
      `UPDATE workflow_agent_receipt_jobs SET state='FAILED',updated_at=$1
       WHERE state='PUBLISHING' AND attempts>=$2 AND updated_at<=$1::timestamptz-$3::double precision*interval '1 millisecond'`,
      [now, maxAttempts, leaseMs],
    );
    const claimed = (
      await db.query<JobRow>(
        `UPDATE workflow_agent_receipt_jobs SET state='PUBLISHING',attempts=attempts+1,updated_at=$1
       WHERE id=(SELECT id FROM workflow_agent_receipt_jobs
         WHERE attempts<$2 AND (
           (state='PENDING' AND updated_at<=$1::timestamptz-$3::double precision*attempts*interval '1 millisecond')
           OR (state='PUBLISHING' AND updated_at<=$1::timestamptz-$4::double precision*interval '1 millisecond'))
         ORDER BY updated_at,id LIMIT 1 FOR UPDATE SKIP LOCKED)
       RETURNING ${COLUMNS}`,
        [now, maxAttempts, retryDelayMs, leaseMs],
      )
    ).rows[0];
    if (!claimed) return null;
    const job = toJob(claimed);
    const binding = await agentStore.get(job.bindingId);
    // Receipts are written by the binding's own scoped agent; a revoked or expired agent cannot publish.
    if (
      !binding ||
      binding.state !== "ACTIVE" ||
      !binding.ensName ||
      Date.parse(binding.expiresAt) <= clock().getTime()
    )
      return settle(job, "FAILED", []);
    try {
      const { txHashes } = await ens.writeReceipt(binding, job.receiptHash);
      if (!txHashes.every((hash) => HASH.test(hash)))
        throw new Error("INVALID_TX_EVIDENCE");
      return await settle(job, "PUBLISHED", txHashes);
    } catch {
      return settle(
        job,
        job.attempts >= maxAttempts ? "FAILED" : "PENDING",
        [],
      );
    }
  }
  async function start(signal: AbortSignal): Promise<void> {
    while (!signal.aborted) {
      try {
        await scan();
        while (!signal.aborted && (await publishNext()));
      } catch {
        /* Retried next pass; workflow effects are never re-executed here. */
      }
      await new Promise<void>((resolve) => {
        const timer = setTimeout(done, pollMs);
        function done() {
          clearTimeout(timer);
          signal.removeEventListener("abort", done);
          resolve();
        }
        signal.addEventListener("abort", done, { once: true });
        if (signal.aborted) done();
      });
    }
  }
  return {
    async enqueue(
      bindingId: string,
      runId: string,
      receiptHash: string,
    ): Promise<void> {
      await insert(bindingId, runId, receiptHash);
    },
    scan,
    publishNext,
    start,
  };
}
