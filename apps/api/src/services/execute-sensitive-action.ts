import { randomUUID } from "node:crypto";
import * as v from "valibot";
import { Database } from "@humanos/database";
import { authorize, POLICY_VERSION, transition } from "@humanos/policy";
import { JEV_MODEL, JEV_QUESTION_VERSION } from "@humanos/models";
import {
  hashCanonical,
  JevAssessmentSchema,
  type PolicyDecision,
  type ActionProposal,
  type AgentAuthorization,
  type Approval,
  type AuditEvent,
  type ExecutionReceipt,
  type JevAssessment,
  type Mission,
} from "@humanos/schemas";
import { validateEffectResult, type EffectResult } from "@humanos/tools";
export interface ExecutionDependencies {
  db: Database;
  readAuthorization: (agentEns: string) => Promise<AgentAuthorization>;
  evaluate: (state: {
    mission: Mission;
    action: ActionProposal;
  }) => Promise<JevAssessment>;
  /** Backend-private authenticated transport. Never expose it as an agent tool. */
  effect: {
    execute: (action: ActionProposal) => Promise<EffectResult>;
    reconcile: (action: ActionProposal) => Promise<EffectResult>;
  };
  /** Must be idempotent by receiptHash and resolve only after a real finalized write. */
  updateEnsReceipt?: (input: {
    agentEns: string;
    receiptHash: string;
    receipt: ExecutionReceipt;
  }) => Promise<void>;
  clock?: () => number;
}
class ExecutionDenied extends Error {
  constructor(
    readonly event: AuditEvent,
    reason: string,
  ) {
    super(reason);
  }
}
export function createExecutor(deps: ExecutionDependencies) {
  const now = deps.clock ?? Date.now;
  const stamp = () => new Date(now()).toISOString();
  const audit = (
    mission: Mission,
    action: ActionProposal,
    type: string,
    nextState: Mission["state"],
    metadata: AuditEvent["metadata"],
  ): AuditEvent => ({
    id: randomUUID(),
    missionId: mission.id,
    actionId: action.id,
    type,
    actor: "policy-executor",
    previousState: mission.state,
    nextState,
    policyVersion: POLICY_VERSION,
    modelVersions: { jev: JEV_MODEL },
    metadata,
    createdAt: stamp(),
  });
  function decisionAudit(
    mission: Mission,
    action: ActionProposal,
    assessment: unknown,
    decision: PolicyDecision,
    phase: string,
  ): AuditEvent {
    const parsed = v.safeParse(JevAssessmentSchema, assessment);
    const summary: AuditEvent["metadata"] = parsed.success
      ? {
          stateHash: parsed.output.stateHash,
          evaluatedAt: parsed.output.evaluatedAt,
          risk: parsed.output.risk,
          confidence: parsed.output.confidence,
          missionAligned: parsed.output.missionAligned,
          missionAlignmentScore: parsed.output.missionAlignmentScore,
          injectionDetected: parsed.output.injectionDetected,
          injectionScore: parsed.output.injectionScore,
          requiresReview: parsed.output.requiresReview,
          modelVersionMatches: parsed.output.modelVersion === JEV_MODEL,
          questionVersionMatches:
            parsed.output.questionVersion === JEV_QUESTION_VERSION,
        }
      : { valid: false };
    return audit(
      mission,
      action,
      decision.allowed ? "EXECUTION_AUTHORIZED" : "EXECUTION_DENIED",
      mission.state,
      {
        phase,
        payloadHash: action.payloadHash,
        assessment: summary,
        decision: {
          allowed: decision.allowed,
          risk: decision.risk,
          requiresApproval: decision.requiresApproval,
          reasons: decision.reasons,
        },
      },
    );
  }
  function withEnsCommitment(receipt: ExecutionReceipt): ExecutionReceipt {
    if (!deps.updateEnsReceipt) return receipt;
    const receiptHash = hashCanonical({
      id: receipt.id,
      actionId: receipt.actionId,
      missionId: receipt.missionId,
      payloadHash: receipt.payloadHash,
      externalId: receipt.externalId,
      status: receipt.status,
    });
    return {
      ...receipt,
      metadata: {
        ...receipt.metadata,
        ensUpdateStatus: "PENDING",
        ensReceiptHash: receiptHash,
      },
    };
  }
  async function updateEns(actionId: string): Promise<ExecutionReceipt> {
    // This transaction starts only after the external effect receipt is durably committed.
    // Failure/retry can repeat the idempotent ENS commitment, never the original effect.
    return deps.db.withLockedAction(actionId, async (tx, action) => {
      const receipt = await tx.getReceiptForAction(actionId);
      if (!receipt) throw new Error("RECEIPT_NOT_FOUND");
      if (
        !deps.updateEnsReceipt ||
        receipt.status !== "SUCCEEDED" ||
        receipt.metadata.ensUpdateStatus !== "PENDING"
      )
        return receipt;
      const mission = await tx.get<Mission>("missions", action.missionId);
      if (!mission) throw new Error("MISSION_NOT_FOUND");
      const receiptHash = receipt.metadata.ensReceiptHash;
      if (typeof receiptHash !== "string")
        throw new Error("INVALID_RECEIPT_COMMITMENT");
      try {
        await deps.updateEnsReceipt({
          agentEns: action.agentEns,
          receiptHash,
          receipt,
        });
      } catch {
        await tx.insert(
          "audit",
          audit(mission, action, "ENS_UPDATE_PENDING", mission.state, {
            receiptId: receipt.id,
            receiptHash,
          }),
        );
        return receipt;
      }
      const next = {
        ...receipt,
        metadata: { ...receipt.metadata, ensUpdateStatus: "CONFIRMED" },
      };
      await tx.query("UPDATE receipts SET data=$2::jsonb WHERE id=$1", [
        next.id,
        JSON.stringify(next),
      ]);
      await tx.insert(
        "audit",
        audit(mission, action, "ENS_UPDATE_CONFIRMED", mission.state, {
          receiptId: receipt.id,
          receiptHash,
        }),
      );
      return next;
    });
  }
  return async (actionId: string): Promise<ExecutionReceipt> => {
    let receipt: ExecutionReceipt;
    try {
      receipt = await deps.db.withLockedAction(actionId, async (tx, action) => {
        const prior = await tx.getReceiptForAction(actionId);
        if (prior?.status === "SUCCEEDED") return prior;
        const mission = await tx.get<Mission>("missions", action.missionId);
        if (!mission) throw new Error("MISSION_NOT_FOUND");
        if (prior) {
          if (prior.status !== "RECONCILIATION_REQUIRED")
            throw new Error("ACTION_FAILED");
          if (
            prior.payloadHash !== action.payloadHash ||
            hashCanonical(action.payload) !== action.payloadHash
          )
            throw new Error("RECONCILIATION_REQUIRED");
          const result = validateEffectResult(
            action,
            await deps.effect.reconcile(action),
          );
          const reconciled = withEnsCommitment({
            ...prior,
            status: "SUCCEEDED",
            externalId: result.externalId,
            executedAt: stamp(),
          });
          await tx.query("UPDATE receipts SET data=$2::jsonb WHERE id=$1", [
            reconciled.id,
            JSON.stringify(reconciled),
          ]);
          // A revoked/expired mission can acknowledge an existing effect without regaining authority.
          const nextState =
            mission.state === "EXECUTING"
              ? transition(
                  mission.state,
                  action.type === "CREATE_CALENDAR_EVENT"
                    ? "COMPLETE"
                    : "RESUME",
                )
              : mission.state;
          if (nextState !== mission.state)
            await tx.put("missions", {
              ...mission,
              state: nextState,
              updatedAt: stamp(),
            });
          await tx.insert(
            "audit",
            audit(mission, action, "RECONCILED", nextState, {
              receiptId: reconciled.id,
              payloadHash: action.payloadHash,
            }),
          );
          return reconciled;
        }
        const approvals = (await tx.list<Approval>("approvals")).filter(
          (p) => p.actionId === action.id,
        );
        const approval = approvals.find((p) => p.status === "VERIFIED");
        const assessment = await deps.evaluate({ mission, action });
        const authorization = await deps.readAuthorization(action.agentEns);
        const policyInput = {
          mission,
          action,
          assessment,
          approval: approval ?? null,
          pinnedJevModelVersion: JEV_MODEL,
          questionVersion: JEV_QUESTION_VERSION,
        };
        const decision = authorize({
          ...policyInput,
          authorization,
          now: new Date(now()),
        });
        if (!decision.allowed)
          throw new ExecutionDenied(
            decisionAudit(
              mission,
              action,
              assessment,
              decision,
              "INITIAL_CHECK",
            ),
            decision.reasons.join(","),
          );
        if (
          !["SUBMIT_APPLICATION", "CREATE_CALENDAR_EVENT"].includes(action.type)
        )
          throw new Error("UNSUPPORTED_EXECUTOR");
        if (decision.requiresApproval) {
          if (!approval) throw new Error("APPROVAL_REQUIRED");
          await tx.consumeApproval(approval.id, new Date(now()));
        }
        const current = await deps.readAuthorization(action.agentEns);
        const recheck = authorize({
          ...policyInput,
          authorization: current,
          now: new Date(now()),
        });
        if (!recheck.allowed)
          throw new ExecutionDenied(
            decisionAudit(
              mission,
              action,
              assessment,
              recheck,
              "FINAL_RECHECK",
            ),
            recheck.reasons.join(","),
          );
        await tx.insert(
          "audit",
          decisionAudit(mission, action, assessment, recheck, "FINAL_RECHECK"),
        );
        const executing = {
          ...mission,
          state: transition(mission.state, "EXECUTE"),
          updatedAt: stamp(),
        };
        await tx.put("missions", executing);
        let result: EffectResult | null = null;
        try {
          result = validateEffectResult(
            action,
            await deps.effect.execute(action),
          );
        } catch {
          /* Outcome is unknown: reconciliation only. */
        }
        let receipt: ExecutionReceipt = {
          id: randomUUID(),
          actionId,
          missionId: mission.id,
          idempotencyKey: actionId,
          payloadHash: action.payloadHash,
          status: result ? "SUCCEEDED" : "RECONCILIATION_REQUIRED",
          externalId: result?.externalId ?? null,
          executedAt: stamp(),
          metadata: { kind: action.type },
        };
        if (result) receipt = withEnsCommitment(receipt);
        await tx.insert("receipts", receipt);
        const next: Mission = {
          ...executing,
          state: result
            ? transition(
                executing.state,
                action.type === "CREATE_CALENDAR_EVENT" ? "COMPLETE" : "RESUME",
              )
            : "EXECUTING",
          updatedAt: stamp(),
        };
        await tx.put("missions", next);
        await tx.insert(
          "audit",
          audit(mission, action, receipt.status, next.state, {
            payloadHash: action.payloadHash,
            receiptId: receipt.id,
          }),
        );
        return receipt;
      });
    } catch (error) {
      // Denial attempts survive the rejected transaction, while its consumption/state writes roll back.
      if (error instanceof ExecutionDenied)
        await deps.db.insert("audit", error.event);
      throw error;
    }
    return receipt.status === "SUCCEEDED" && deps.updateEnsReceipt
      ? updateEns(actionId)
      : receipt;
  };
}
