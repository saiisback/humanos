import * as v from "valibot";
import {
  ActionProposalSchema,
  ApprovalSchema,
  JevAssessmentSchema,
  MissionSchema,
  hashCanonical,
  type ActionProposal,
  type Approval,
  type ApprovalBinding,
  type AgentAuthorization,
  type JevAssessment,
  type Mission,
  type PolicyDecision,
  type RiskLevel,
} from "@humanos/schemas";
import { effectiveCapabilities } from "./capabilities.js";
import { classifyStatic, maximumRisk } from "./risk.js";
import { authorizeOnchain, type OnchainAuthority } from "./jaw-permissions.js";
export const POLICY_VERSION = "humanos-policy-v1";
export interface AuthorizeInput {
  action: ActionProposal;
  mission: Mission;
  authorization: AgentAuthorization;
  assessment: JevAssessment | null;
  now: Date;
  approval?: Approval | null;
  pinnedJevModelVersion: string;
  questionVersion: string;
  maxAuthorizationAgeMs?: number;
  maxAssessmentAgeMs?: number;
  maxApprovalAgeMs?: number;
  onchain?: OnchainAuthority | undefined;
}
export function approvalBinding(a: ActionProposal): ApprovalBinding {
  return {
    rootId: a.rootId,
    agentEns: a.agentEns,
    missionId: a.missionId,
    actionType: a.type,
    payloadHash: a.payloadHash,
    nonce: a.nonce,
    expiresAt: a.expiresAt,
  };
}
export function authorize(input: AuthorizeInput): PolicyDecision {
  const reasons: string[] = [];
  let risk: RiskLevel = "SENSITIVE";
  let requiresApproval = true;
  let capabilities: ReturnType<typeof effectiveCapabilities> = [];
  const deny = (reason: string): PolicyDecision => ({
    allowed: false,
    risk,
    requiresApproval,
    reasons: [...reasons, reason],
    effectiveCapabilities: capabilities,
    policyVersion: POLICY_VERSION,
  });
  try {
    const { action: a, mission: m, assessment: j, now } = input;
    if (
      !v.safeParse(ActionProposalSchema, a).success ||
      !v.safeParse(MissionSchema, m).success ||
      !Number.isFinite(now.getTime())
    )
      return deny("MALFORMED_INPUT");
    risk = classifyStatic(a);
    requiresApproval = risk !== "ROUTINE";
    capabilities = effectiveCapabilities(input);
    if (!capabilities.includes(a.capability))
      return deny("CAPABILITY_UNAVAILABLE");
    if (
      a.missionId !== m.id ||
      a.rootId !== m.rootId ||
      a.agentEns !== m.agentEns
    )
      return deny("IDENTITY_MISMATCH");
    if (
      Date.parse(a.expiresAt) <= now.getTime() ||
      Date.parse(a.expiresAt) > Date.parse(m.expiresAt) ||
      Date.parse(a.createdAt) > now.getTime()
    )
      return deny("ACTION_EXPIRED_OR_INVALID");
    if (hashCanonical(a.payload) !== a.payloadHash)
      return deny("PAYLOAD_HASH_MISMATCH");
    if (a.type === "TRANSFER_VALUE") {
      if (!input.onchain) return deny("JAW_PERMISSION_UNAVAILABLE");
      const reason = authorizeOnchain({
        ...input.onchain,
        missionId: m.id,
        effect: a.payload,
        now,
      });
      if (reason) return deny(reason);
    }
    if (!j || !v.safeParse(JevAssessmentSchema, j).success)
      return deny("ASSESSMENT_UNAVAILABLE");
    if (
      !input.pinnedJevModelVersion ||
      j.modelVersion !== input.pinnedJevModelVersion ||
      !input.questionVersion ||
      j.questionVersion !== input.questionVersion
    )
      return deny("ASSESSMENT_VERSION_MISMATCH");
    if (j.stateHash !== hashCanonical({ mission: m, action: a }))
      return deny("ASSESSMENT_STATE_MISMATCH");
    const age = now.getTime() - Date.parse(j.evaluatedAt);
    if (age < 0 || age > (input.maxAssessmentAgeMs ?? 300000))
      return deny("ASSESSMENT_STALE");
    if (
      j.confidence < 0.8 ||
      !j.missionAligned ||
      j.missionAlignmentScore < 0.8 ||
      j.injectionDetected ||
      j.injectionScore >= 0.2
    )
      return deny("ASSESSMENT_BLOCKED");
    risk = maximumRisk(
      risk,
      j.risk,
      j.requiresReview ? "CONSEQUENTIAL" : "ROUTINE",
    );
    requiresApproval = risk !== "ROUTINE";
    if (requiresApproval) {
      const p = input.approval;
      if (!p || !v.safeParse(ApprovalSchema, p).success)
        return deny("APPROVAL_REQUIRED");
      const binding = approvalBinding(a);
      if (
        p.actionId !== a.id ||
        p.status !== "VERIFIED" ||
        p.consumedAt !== null ||
        !p.verifiedAt ||
        p.bindingHash !== hashCanonical(binding) ||
        hashCanonical(p.binding) !== hashCanonical(binding)
      )
        return deny("APPROVAL_BINDING_INVALID");
      const approvalAge = now.getTime() - Date.parse(p.verifiedAt);
      if (
        approvalAge < 0 ||
        approvalAge > (input.maxApprovalAgeMs ?? 300000) ||
        Date.parse(p.createdAt) > Date.parse(p.verifiedAt)
      )
        return deny("APPROVAL_STALE");
      if (
        risk === "SENSITIVE" &&
        (p.kind !== "WORLD_FRESH" || !p.nullifierHash)
      )
        return deny("FRESH_WORLD_APPROVAL_REQUIRED");
      if (
        risk === "CONSEQUENTIAL" &&
        !["CONSEQUENTIAL_CONFIRMATION", "WORLD_FRESH"].includes(p.kind)
      )
        return deny("CONFIRMATION_REQUIRED");
    }
    return {
      allowed: true,
      risk,
      requiresApproval,
      reasons: [],
      effectiveCapabilities: capabilities,
      policyVersion: POLICY_VERSION,
    };
  } catch {
    return deny("INVALID_OR_UNSUPPORTED_INPUT");
  }
}
