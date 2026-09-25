import { describe, it, expect } from "vitest";
import {
  MissionStateSchema,
  MissionEventSchema,
  hashCanonical,
  type Mission,
  type ActionProposal,
  type AgentAuthorization,
  type JevAssessment,
  type Approval,
} from "@humanos/schemas";
import {
  transition,
  authorize,
  approvalBinding,
  STATIC_RULES,
} from "../src/index.js";
const now = new Date("2026-09-24T00:00:00.000Z"),
  future = "2026-09-24T01:00:00.000Z";
const mission: Mission = {
  id: "m",
  rootId: "r",
  agentEns: "a.eth",
  title: "apply",
  goal: "apply",
  capabilities: ["application.submit"],
  approvedCapabilities: ["application.submit"],
  steps: [],
  state: "RUNNING",
  expiresAt: future,
  createdAt: now.toISOString(),
  updatedAt: now.toISOString(),
  policyVersion: "humanos-policy-v1",
};
const action: ActionProposal = {
  id: "a",
  rootId: "r",
  missionId: "m",
  agentEns: "a.eth",
  type: "SUBMIT_APPLICATION",
  capability: "application.submit",
  payload: { name: "Ada" },
  payloadHash: hashCanonical({ name: "Ada" }),
  nonce: "n",
  expiresAt: future,
  createdAt: now.toISOString(),
  reason: "apply",
};
const authorization: AgentAuthorization = {
  rootId: "r",
  agentEns: "a.eth",
  capabilities: ["application.submit"],
  active: true,
  revoked: false,
  expiresAt: future,
  checkedAt: now.toISOString(),
  blockNumber: 1,
  finalized: true,
};
const assessment: JevAssessment = {
  stateHash: hashCanonical({ mission, action }),
  questionVersion: "q1",
  modelVersion: "pinned",
  evaluatedAt: now.toISOString(),
  risk: "ROUTINE",
  missionAligned: true,
  injectionDetected: false,
  requiresReview: false,
  confidence: 0.99,
  missionAlignmentScore: 0.99,
  injectionScore: 0.01,
  reason: "aligned",
};
function input() {
  const binding = approvalBinding(action);
  const approval: Approval = {
    id: "p",
    actionId: "a",
    binding,
    bindingHash: hashCanonical(binding),
    kind: "WORLD_FRESH",
    status: "VERIFIED",
    createdAt: now.toISOString(),
    verifiedAt: now.toISOString(),
    consumedAt: null,
    nullifierHash: hashCanonical("nullifier"),
  };
  return {
    mission,
    action,
    authorization,
    assessment,
    approval,
    now,
    pinnedJevModelVersion: "pinned",
    questionVersion: "q1",
  };
}
const allowed: Record<string, Record<string, string>> = {
  DRAFT: { PROPOSE: "PROPOSED" },
  PROPOSED: { AUTHORIZE: "AUTHORIZED" },
  AUTHORIZED: { START: "RUNNING" },
  RUNNING: {
    REQUEST_APPROVAL: "AWAITING_APPROVAL",
    EXECUTE: "EXECUTING",
    COMPLETE: "COMPLETED",
  },
  AWAITING_APPROVAL: { APPROVE: "RUNNING" },
  EXECUTING: { RESUME: "RUNNING", COMPLETE: "COMPLETED" },
};
for (const state of [
  "DRAFT",
  "PROPOSED",
  "AUTHORIZED",
  "RUNNING",
  "AWAITING_APPROVAL",
  "EXECUTING",
])
  Object.assign(allowed[state]!, {
    REJECT: "REJECTED",
    EXPIRE: "EXPIRED",
    REVOKE: "REVOKED",
    FAIL: "FAILED",
  });
describe("exhaustive state machine", () => {
  for (const state of MissionStateSchema.options)
    for (const event of MissionEventSchema.options)
      it(`${state} ${event}`, () => {
        const expected = allowed[state]?.[event];
        if (expected) expect(transition(state, event)).toBe(expected);
        else expect(() => transition(state, event)).toThrow();
      });
});
it("static table covers every capability without model influence", () => {
  expect(Object.keys(STATIC_RULES)).toHaveLength(14);
  expect(STATIC_RULES.SUBMIT_APPLICATION.risk).toBe("SENSITIVE");
});
it("authorizes bound fresh approval, never lowers static risk", () => {
  expect(authorize(input())).toMatchObject({
    allowed: true,
    risk: "SENSITIVE",
  });
});
it.each([
  "payload",
  "root",
  "agent",
  "nonce",
  "expiry",
  "action",
  "consumed",
  "kind",
  "nullifier",
  "bindingHash",
  "futureVerification",
] as const)("rejects approval substitution %s", (key) => {
  const x = input();
  x.approval = structuredClone(x.approval);
  if (key === "payload") x.action = { ...action, payload: { name: "Mallory" } };
  if (key === "root") x.approval.binding.rootId = "other";
  if (key === "agent") x.approval.binding.agentEns = "other.eth";
  if (key === "nonce") x.approval.binding.nonce = "other";
  if (key === "expiry") x.approval.binding.expiresAt = now.toISOString();
  if (key === "action") x.approval.actionId = "other";
  if (key === "consumed") x.approval.status = "CONSUMED";
  if (key === "kind") x.approval.kind = "CONSEQUENTIAL_CONFIRMATION";
  if (key === "nullifier") x.approval.nullifierHash = null;
  if (key === "bindingHash") x.approval.bindingHash = hashCanonical("other");
  if (key === "futureVerification") x.approval.verifiedAt = future;
  expect(authorize(x).allowed).toBe(false);
});
it.each([
  "revoked",
  "expired",
  "unfinalized",
  "stale",
  "unknownModel",
  "lowConfidence",
  "injection",
  "drift",
  "staleAssessment",
  "wrongStateHash",
  "noCapability",
  "missionRevoked",
  "schema",
] as const)("fails closed: %s", (key) => {
  const x = input();
  x.authorization = { ...authorization };
  x.assessment = { ...assessment };
  x.mission = { ...mission };
  if (key === "revoked") x.authorization.revoked = true;
  if (key === "expired") x.mission.expiresAt = now.toISOString();
  if (key === "unfinalized") x.authorization.finalized = false;
  if (key === "stale") x.authorization.checkedAt = "2026-09-23T00:00:00.000Z";
  if (key === "unknownModel") x.assessment.modelVersion = "other";
  if (key === "lowConfidence") x.assessment.confidence = 0.2;
  if (key === "injection") x.assessment.injectionDetected = true;
  if (key === "drift") x.assessment.missionAligned = false;
  if (key === "staleAssessment")
    x.assessment.evaluatedAt = "2026-09-23T00:00:00.000Z";
  if (key === "wrongStateHash") x.assessment.stateHash = hashCanonical("other");
  if (key === "noCapability") x.mission.approvedCapabilities = [];
  if (key === "missionRevoked") x.mission.state = "REVOKED";
  if (key === "schema") x.assessment.confidence = NaN;
  expect(authorize(x).allowed).toBe(false);
});
it("requires explicit consequential confirmation", () => {
  const x = input();
  x.action = {
    ...action,
    type: "CREATE_CALENDAR_EVENT",
    capability: "calendar.create",
  };
  x.mission = {
    ...mission,
    capabilities: ["calendar.create"],
    approvedCapabilities: ["calendar.create"],
  };
  x.authorization = { ...authorization, capabilities: ["calendar.create"] };
  x.assessment = {
    ...assessment,
    stateHash: hashCanonical({ mission: x.mission, action: x.action }),
  };
  x.approval = {
    ...x.approval,
    kind: "CONSEQUENTIAL_CONFIRMATION",
    binding: approvalBinding(x.action),
    nullifierHash: null,
  };
  x.approval.bindingHash = hashCanonical(x.approval.binding);
  expect(authorize(x).allowed).toBe(true);
  expect(authorize({ ...x, approval: null }).allowed).toBe(false);
});
it("rejects capability/type laundering despite approved capability", () => {
  const x = input();
  x.action = { ...action, type: "TRANSFER_VALUE" };
  x.assessment = {
    ...assessment,
    stateHash: hashCanonical({ mission: x.mission, action: x.action }),
  };
  expect(authorize(x).allowed).toBe(false);
});
it("routine read needs no human approval and models cannot broaden authority", () => {
  const x = input();
  x.action = { ...action, type: "READ_DOCUMENT", capability: "documents.read" };
  x.mission = {
    ...mission,
    capabilities: ["documents.read"],
    approvedCapabilities: ["documents.read"],
  };
  x.authorization = {
    ...authorization,
    capabilities: ["documents.read", "value.transfer"],
  };
  x.assessment = {
    ...assessment,
    stateHash: hashCanonical({ mission: x.mission, action: x.action }),
  };
  expect(authorize({ ...x, approval: null })).toMatchObject({
    allowed: true,
    risk: "ROUTINE",
    requiresApproval: false,
    effectiveCapabilities: ["documents.read"],
  });
});
it("review recommendation escalates routine action to confirmation", () => {
  const x = input();
  x.action = { ...action, type: "READ_DOCUMENT", capability: "documents.read" };
  x.mission = {
    ...mission,
    capabilities: ["documents.read"],
    approvedCapabilities: ["documents.read"],
  };
  x.authorization = { ...authorization, capabilities: ["documents.read"] };
  x.assessment = {
    ...assessment,
    requiresReview: true,
    stateHash: hashCanonical({ mission: x.mission, action: x.action }),
  };
  expect(authorize({ ...x, approval: null })).toMatchObject({
    allowed: false,
    risk: "CONSEQUENTIAL",
    requiresApproval: true,
  });
});
it("rejects unknown runtime states and prototype keys", () => {
  expect(() => transition("RUNNING", "toString" as never)).toThrow();
  expect(() => transition("__proto__" as never, "COMPLETE")).toThrow();
});
