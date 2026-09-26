import { expect, it } from "vitest";
import * as v from "valibot";
import {
  EnableWorkflowAgentRequestSchema,
  RevokeWorkflowAgentRequestSchema,
  WorkflowAgentBindingSchema,
  WorkflowAgentReservationSchema,
  WorkflowAgentReviewSchema,
  ensNamehash,
  workflowAgentDerivationId,
} from "../src/workflow-agents.js";
import { WorkflowRunSchema, WorkflowScheduleSchema } from "../src/workflows.js";

const now = "2026-09-26T00:00:00.000Z";
const later = "2026-09-27T00:00:00.000Z";
const hash = `0x${"a".repeat(64)}`;
const tx = `0x${"b".repeat(64)}`;
const ensName = "wf1.root1.humanos.eth";
const active = {
  id: "binding-1",
  accountId: "11155111:0x1111111111111111111111111111111111111111",
  rootId: "root-1",
  workflowId: "wf",
  versionId: "wf-v1",
  graphHash: hash,
  capabilities: ["drafts.write", "web.search"],
  expiresAt: later,
  generation: 1,
  derivationId: "workflow:wf:1",
  chainId: 11155111,
  ensName,
  node: ensNamehash(ensName),
  agentAddress: `0x${"2".repeat(40)}`,
  state: "ACTIVE",
  revision: 1,
  registrationTxHashes: [tx],
  revocationTxHashes: [],
  createdAt: now,
  updatedAt: now,
};
const pending = {
  ...active,
  ensName: null,
  node: null,
  agentAddress: null,
  state: "PENDING_REGISTRATION",
  revision: 0,
  registrationTxHashes: [],
};
const ok = (value: unknown) =>
  v.safeParse(WorkflowAgentBindingSchema, value).success;

it("computes standard ENS namehashes and domain-separated derivation IDs", () => {
  expect(ensNamehash("eth")).toBe(
    "0x93cdeb708b7545dc668eb9280176169d1c33cfd8ed6f04690a0bcc88a93fc4ae",
  );
  expect(workflowAgentDerivationId("wf", 2)).toBe("workflow:wf:2");
});

it("accepts version-bound bindings and rejects unknown or private-key fields", () => {
  expect(ok(active)).toBe(true);
  expect(ok(pending)).toBe(true);
  expect(ok({ ...active, privateKey: `0x${"c".repeat(64)}` })).toBe(false);
  expect(ok({ ...active, agentPrivateKey: "secret" })).toBe(false);
  expect(ok({ ...active, missionId: "m" })).toBe(false);
});

it("requires chain identity only once registered and binds the node to the name", () => {
  expect(ok({ ...pending, state: "ACTIVE" })).toBe(false);
  expect(ok({ ...active, node: hash })).toBe(false);
  expect(ok({ ...active, agentAddress: null })).toBe(false);
  expect(
    ok({
      ...active,
      ensName: "Placeholder.ETH",
      node: ensNamehash("Placeholder.ETH"),
    }),
  ).toBe(false);
  // Reconciled no-op registration/revocation reports verified preexisting state without hashes.
  expect(ok({ ...active, registrationTxHashes: [] })).toBe(true);
  expect(ok({ ...active, state: "REVOKED", revision: 3 })).toBe(true);
  // Pending intents may be revoked before any chain identity exists.
  expect(ok({ ...pending, state: "REVOKING" })).toBe(true);
  expect(ok({ ...pending, state: "REVOKED" })).toBe(true);
  expect(ok({ ...pending, state: "REVOKED", revocationTxHashes: [tx] })).toBe(
    false,
  );
  expect(ok({ ...active, revocationTxHashes: [tx] })).toBe(false);
  expect(ok({ ...active, registrationTxHashes: [tx, tx] })).toBe(false);
  expect(ok({ ...active, registrationTxHashes: ["0xabc"] })).toBe(false);
});

it("pins Sepolia, derivation, canonical scope and a future expiry", () => {
  expect(ok({ ...active, chainId: 1 })).toBe(false);
  expect(ok({ ...active, derivationId: "mission:wf:1" })).toBe(false);
  expect(ok({ ...active, generation: 0, derivationId: "workflow:wf:0" })).toBe(
    false,
  );
  expect(ok({ ...active, capabilities: [] })).toBe(false);
  expect(ok({ ...active, capabilities: ["web.search", "drafts.write"] })).toBe(
    false,
  );
  expect(
    ok({ ...active, capabilities: ["drafts.write", "drafts.write"] }),
  ).toBe(false);
  expect(
    ok({ ...active, capabilities: ["drafts.write", "value.transfer"] }),
  ).toBe(false);
  expect(ok({ ...active, capabilities: ["permissions.change"] })).toBe(false);
  expect(ok({ ...active, expiresAt: now })).toBe(false);
  expect(ok({ ...active, state: "LINKED" })).toBe(false);
});

it("accepts reservations without store-allocated identity or chain evidence", () => {
  const reservation = {
    accountId: active.accountId,
    rootId: active.rootId,
    workflowId: active.workflowId,
    versionId: active.versionId,
    graphHash: hash,
    capabilities: ["drafts.write"],
    expiresAt: later,
    state: "PENDING_REGISTRATION",
    createdAt: now,
    updatedAt: now,
  };
  const parse = (value: unknown) =>
    v.safeParse(WorkflowAgentReservationSchema, value).success;
  expect(parse(reservation)).toBe(true);
  expect(parse({ ...reservation, id: "chosen" })).toBe(false);
  expect(parse({ ...reservation, generation: 1 })).toBe(false);
  expect(parse({ ...reservation, derivationId: "workflow:wf:1" })).toBe(false);
  expect(parse({ ...reservation, ensName })).toBe(false);
  expect(parse({ ...reservation, revision: 0 })).toBe(false);
  expect(parse({ ...reservation, state: "ACTIVE" })).toBe(false);
});

it("bounds public review and request payloads", () => {
  const review = {
    id: "review-1",
    accountId: active.accountId,
    rootId: active.rootId,
    workflowId: active.workflowId,
    versionId: active.versionId,
    graphHash: hash,
    capabilities: ["drafts.write"],
    expiresAt: later,
    chainId: 11155111,
    network: "sepolia",
    parentName: "humanos.eth",
    reviewHash: hash,
    createdAt: now,
    reviewExpiresAt: "2026-09-26T00:05:00.000Z",
  };
  expect(v.safeParse(WorkflowAgentReviewSchema, review).success).toBe(true);
  expect(
    v.safeParse(WorkflowAgentReviewSchema, {
      ...review,
      reviewExpiresAt: "2026-09-26T00:06:00.000Z",
    }).success,
  ).toBe(false);
  expect(
    v.safeParse(EnableWorkflowAgentRequestSchema, {
      reviewId: "review-1",
      expectedReviewHash: hash,
    }).success,
  ).toBe(true);
  expect(
    v.safeParse(EnableWorkflowAgentRequestSchema, {
      reviewId: "review-1",
      expectedReviewHash: hash,
      ensName,
    }).success,
  ).toBe(false);
  expect(
    v.safeParse(RevokeWorkflowAgentRequestSchema, { bindingId: "x" }).success,
  ).toBe(false);
});

it("keeps legacy runs and schedules valid while accepting authority pins", () => {
  const run = {
    id: "run",
    workflowId: "wf",
    workflowVersionId: "wf-v1",
    missionId: null,
    triggerKind: "manual",
    triggerOccurrenceId: null,
    inputSnapshot: {},
    inputHash: hash,
    status: "QUEUED",
    pauseReason: null,
    revision: 0,
    leaseOwner: null,
    leaseExpiresAt: null,
    heartbeatAt: null,
    createdAt: now,
    startedAt: null,
    completedAt: null,
    cancelledAt: null,
    nextResumeAt: null,
  };
  const schedule = {
    id: "schedule",
    workflowId: "wf",
    workflowVersionId: "wf-v1",
    definition: { kind: "once", fireAt: later, timezone: "UTC" },
    nextFireAt: later,
    lastFireAt: null,
    status: "ACTIVE",
    overlapPolicy: "skip",
    createdAt: now,
    updatedAt: now,
  };
  const pin = { authorityMode: "ens", agentBindingId: "binding-1" };
  expect(v.safeParse(WorkflowRunSchema, run).success).toBe(true);
  expect(v.safeParse(WorkflowRunSchema, { ...run, ...pin }).success).toBe(true);
  expect(
    v.safeParse(WorkflowRunSchema, { ...run, authorityMode: "mission" })
      .success,
  ).toBe(false);
  expect(v.safeParse(WorkflowScheduleSchema, schedule).success).toBe(true);
  expect(
    v.safeParse(WorkflowScheduleSchema, { ...schedule, ...pin }).success,
  ).toBe(true);
});
