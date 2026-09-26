import * as v from "valibot";
import {
  WorkflowAgentBindingSchema,
  WorkflowAgentReservationSchema,
  WORKFLOW_AGENT_CHAIN_ID,
  hashCanonical,
  normalizeWalletAddress,
  workflowAgentDerivationId,
  type Hex,
  type Workflow,
  type WorkflowAgentBinding,
  type WorkflowAgentReservation,
  type WorkflowAgentState,
  type WorkflowVersion,
} from "@humanos/schemas";
import type { Database } from "./index.js";

const json = (value: unknown) => JSON.stringify(value);
const LIVE_STATES = "('PENDING_REGISTRATION','ACTIVE','REVOKING')";
const TRANSITIONS: Record<WorkflowAgentState, readonly WorkflowAgentState[]> = {
  PENDING_REGISTRATION: [
    "PENDING_REGISTRATION",
    "ACTIVE",
    "FAILED",
    "REVOKING",
    "EXPIRED",
  ],
  ACTIVE: ["REVOKING", "EXPIRED"],
  REVOKING: ["REVOKING", "REVOKED", "EXPIRED"],
  REVOKED: [],
  FAILED: [],
  EXPIRED: [],
};

/** Evidence must come from journaled/confirmed ENS results. `registration` is required exactly
 * for ACTIVE and `revocation` exactly for REVOKED; empty hash lists record verified preexisting
 * chain state (reconciled no-ops), never a guessed transaction. */
export interface WorkflowAgentEvidence {
  at: Date;
  registration?: {
    ensName: string;
    node: Hex;
    agentAddress: string;
    txHashes: readonly Hex[];
  };
  revocation?: { txHashes: readonly Hex[] };
}

const immutable = (b: WorkflowAgentReservation | WorkflowAgentBinding) => ({
  accountId: b.accountId,
  rootId: b.rootId,
  workflowId: b.workflowId,
  versionId: b.versionId,
  graphHash: b.graphHash,
  capabilities: b.capabilities,
  expiresAt: b.expiresAt,
});

export class WorkflowAgentStore {
  constructor(private readonly db: Database) {}
  async get(id: string): Promise<WorkflowAgentBinding | null> {
    return (
      (
        await this.db.query<{ data: WorkflowAgentBinding }>(
          "SELECT data FROM workflow_agent_bindings WHERE id=$1",
          [id],
        )
      ).rows[0]?.data ?? null
    );
  }
  async listOwned(accountId: string): Promise<WorkflowAgentBinding[]> {
    return (
      await this.db.query<{ data: WorkflowAgentBinding }>(
        "SELECT data FROM workflow_agent_bindings WHERE account_id=$1 ORDER BY workflow_id,generation",
        [accountId],
      )
    ).rows.map((r) => r.data);
  }
  /** Allocates id/generation/derivation under a workflow lock; an identical pending request is reused. */
  async reserve(
    input: WorkflowAgentReservation,
  ): Promise<WorkflowAgentBinding> {
    const request = v.parse(WorkflowAgentReservationSchema, input);
    return this.db.transaction(async (tx) => {
      const workflow = (
        await tx.query<{ data: Workflow }>(
          "SELECT data FROM workflows WHERE id=$1 FOR UPDATE",
          [request.workflowId],
        )
      ).rows[0]?.data;
      if (
        !workflow ||
        workflow.accountId !== request.accountId ||
        (workflow.rootId !== null && workflow.rootId !== request.rootId)
      )
        throw new Error("WORKFLOW_NOT_FOUND");
      if (
        !(
          await tx.query(
            "SELECT 1 FROM root_bindings WHERE root_id=$1 AND account_id=$2",
            [request.rootId, request.accountId],
          )
        ).rowCount
      )
        throw new Error("ROOT_NOT_OWNED");
      const version = (
        await tx.query<{ data: WorkflowVersion }>(
          "SELECT data FROM workflow_versions WHERE id=$1 AND workflow_id=$2",
          [request.versionId, request.workflowId],
        )
      ).rows[0]?.data;
      if (!version) throw new Error("VERSION_NOT_FOUND");
      if (version.graphHash !== request.graphHash)
        throw new Error("GRAPH_CHANGED");
      const live = (
        await tx.query<{ data: WorkflowAgentBinding }>(
          `SELECT data FROM workflow_agent_bindings WHERE workflow_id=$1 AND state IN ${LIVE_STATES}`,
          [request.workflowId],
        )
      ).rows[0]?.data;
      if (live) {
        if (
          live.state === "PENDING_REGISTRATION" &&
          hashCanonical(immutable(live)) === hashCanonical(immutable(request))
        )
          return live;
        throw new Error("WORKFLOW_AGENT_CONFLICT");
      }
      const generation = Number(
        (
          await tx.query<{ generation: number }>(
            "SELECT COALESCE(MAX(generation),0)+1 AS generation FROM workflow_agent_bindings WHERE workflow_id=$1",
            [request.workflowId],
          )
        ).rows[0]!.generation,
      );
      const derivationId = workflowAgentDerivationId(
        request.workflowId,
        generation,
      );
      const binding = v.parse(WorkflowAgentBindingSchema, {
        id: hashCanonical({ kind: "workflow-agent", derivationId }),
        ...immutable(request),
        generation,
        derivationId,
        chainId: WORKFLOW_AGENT_CHAIN_ID,
        ensName: null,
        node: null,
        agentAddress: null,
        state: request.state,
        revision: 0,
        registrationTxHashes: [],
        revocationTxHashes: [],
        createdAt: request.createdAt,
        updatedAt: request.updatedAt,
      });
      await tx.query(
        "INSERT INTO workflow_agent_bindings(id,account_id,root_id,workflow_id,version_id,generation,derivation_id,state,revision,expires_at,data) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)",
        [
          binding.id,
          binding.accountId,
          binding.rootId,
          binding.workflowId,
          binding.versionId,
          binding.generation,
          binding.derivationId,
          binding.state,
          binding.revision,
          binding.expiresAt,
          json(binding),
        ],
      );
      return binding;
    });
  }
  /** Optimistic lifecycle transition; immutable fields and prior evidence are never rewritten. */
  async transition(
    id: string,
    expectedRevision: number,
    nextState: WorkflowAgentState,
    evidence: WorkflowAgentEvidence,
  ): Promise<WorkflowAgentBinding> {
    return this.db.transaction(async (tx) => {
      const current = (
        await tx.query<{ data: WorkflowAgentBinding }>(
          "SELECT data FROM workflow_agent_bindings WHERE id=$1 FOR UPDATE",
          [id],
        )
      ).rows[0]?.data;
      if (!current) throw new Error("WORKFLOW_AGENT_NOT_FOUND");
      if (current.revision !== expectedRevision)
        throw new Error("REVISION_CONFLICT");
      if (!TRANSITIONS[current.state].includes(nextState))
        throw new Error("INVALID_TRANSITION");
      const { at, registration, revocation } = evidence;
      if (
        (nextState === "ACTIVE" && !registration) ||
        (nextState === "REVOKED") !== !!revocation ||
        (registration &&
          !["PENDING_REGISTRATION", "ACTIVE", "REVOKING"].includes(nextState))
      )
        throw new Error("EVIDENCE_MISMATCH");
      if (
        nextState === "EXPIRED" &&
        at.getTime() < Date.parse(current.expiresAt)
      )
        throw new Error("NOT_EXPIRED");
      if (
        registration &&
        current.ensName !== null &&
        (registration.ensName !== current.ensName ||
          registration.node !== current.node ||
          normalizeWalletAddress(registration.agentAddress) !==
            current.agentAddress)
      )
        throw new Error("IDENTITY_IMMUTABLE");
      if (
        nextState === "ACTIVE" &&
        at.getTime() >= Date.parse(current.expiresAt)
      )
        throw new Error("AGENT_EXPIRED");
      const next = v.parse(WorkflowAgentBindingSchema, {
        ...current,
        state: nextState,
        revision: current.revision + 1,
        updatedAt: at.toISOString(),
        ...(registration && {
          ensName: registration.ensName,
          node: registration.node,
          agentAddress: normalizeWalletAddress(registration.agentAddress),
          registrationTxHashes: [
            ...new Set([
              ...current.registrationTxHashes,
              ...registration.txHashes,
            ]),
          ],
        }),
        ...(revocation && {
          revocationTxHashes: [
            ...new Set([...current.revocationTxHashes, ...revocation.txHashes]),
          ],
        }),
      });
      await tx.query(
        "UPDATE workflow_agent_bindings SET state=$2,revision=$3,data=$4 WHERE id=$1",
        [id, next.state, next.revision, json(next)],
      );
      return next;
    });
  }
}
