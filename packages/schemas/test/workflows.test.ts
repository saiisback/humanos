import { expect, it } from "vitest";
import * as v from "valibot";
import {
  WorkflowGraphSchema,
  WorkflowSchema,
  WorkflowVersionSchema,
  RunConfirmationSchema,
  WorkflowSelectionSchema,
  GeneratedContentSchema,
  WorkflowReceiptSchema,
  BoundedJsonValueSchema,
  BoundedPayloadSchema,
} from "../src/workflows.js";
import {
  ActivateWorkflowRequestSchema,
  ConfirmWorkflowStepRequestSchema,
  CreateWorkflowRequestSchema,
  WorkflowRunDetailResponseSchema,
} from "../src/api.js";

const now = "2026-09-26T00:00:00.000Z";
const hash = `0x${"a".repeat(64)}`;
const node = {
  id: "read",
  type: "research.web",
  blockVersion: "1.0.0",
  dependsOn: [],
  input: { query: "events" },
  capability: "web.search",
  timeoutMs: 1000,
  maxAttempts: 2,
};
const graph = { nodes: [node, { ...node, id: "extract", type: "extract.structured", dependsOn: ["read"] }] };

it("accepts a bounded typed workflow graph and rejects unknown executable fields", () => {
  expect(v.parse(WorkflowGraphSchema, graph).nodes).toHaveLength(2);
  expect(v.safeParse(WorkflowGraphSchema, { nodes: [{ ...node, shell: "curl attacker" }] }).success).toBe(false);
  expect(v.safeParse(WorkflowGraphSchema, { nodes: Array.from({ length: 65 }, (_, i) => ({ ...node, id: `n${i}` })) }).success).toBe(false);
  expect(v.safeParse(WorkflowGraphSchema, { nodes: Array.from({ length: 5 }, (_, i) => ({ ...node, id: `n${i}`, dependsOn: Array.from({ length: 32 }, (_, j) => `d${j}`) })) }).success).toBe(false);
});

it("bounds nested user input and excludes executable keys from records", () => {
  expect(v.safeParse(WorkflowGraphSchema, { nodes: [{ ...node, input: { query: "x".repeat(10001) } }] }).success).toBe(false);
  expect(v.safeParse(WorkflowGraphSchema, { nodes: [{ ...node, input: { deeply: Array(257).fill("x") } }] }).success).toBe(false);
  expect(v.safeParse(WorkflowGraphSchema, { nodes: [{ ...node, type: "shell.exec" }] }).success).toBe(false);
});

it("rejects over-depth and cyclic JSON before recursive schema validation", () => {
  let overDepth: Record<string, unknown> = { leaf: "ok" };
  for (let depth = 0; depth < 2000; depth++) overDepth = { next: overDepth };
  const cyclic: Record<string, unknown> = {};
  cyclic.self = cyclic;
  expect(() => v.safeParse(BoundedPayloadSchema, overDepth)).not.toThrow();
  expect(v.safeParse(BoundedPayloadSchema, overDepth).success).toBe(false);
  expect(() => v.safeParse(BoundedJsonValueSchema, cyclic)).not.toThrow();
  expect(v.safeParse(BoundedJsonValueSchema, cyclic).success).toBe(false);
});

it("keeps a versioned graph snapshot and canonical hash together", () => {
  const version = {
    id: "v1", workflowId: "w1", version: 1, goal: "Find an event", normalizedIntent: {},
    graph, graphHash: hash, requiredCapabilities: ["web.search"], connectorRefs: [],
    browserFallbackAllowed: false, trigger: { kind: "manual" },
    assembler: { modelId: "jev-1.13", modelVersion: "1.13", decisionHash: hash },
    createdAt: now, activatedAt: null,
  };
  expect(v.parse(WorkflowVersionSchema, version).graphHash).toBe(hash);
  expect(v.safeParse(WorkflowVersionSchema, { ...version, graphHash: "0xabc" }).success).toBe(false);
  expect(v.safeParse(WorkflowVersionSchema, { ...version, graph: { ...graph, code: "run()" } }).success).toBe(false);
});

it("requires account ownership while allowing an unbound root", () => {
  const workflow = {
    id: "w1", accountId: "account", rootId: null, missionId: null, name: "Event research",
    status: "DRAFT", latestVersionId: "v1", createdAt: now, updatedAt: now, archivedAt: null,
  };
  expect(v.parse(WorkflowSchema, workflow).rootId).toBeNull();
  expect(v.safeParse(WorkflowSchema, { ...workflow, accountId: undefined }).success).toBe(false);
});

it("requires payload-bound single-use confirmations", () => {
  const confirmation = {
    id: "c1", runId: "r1", stepRunId: "s1", actorAccountId: "account", actorRootId: null,
    destination: "https://example.com/submit", payloadHash: hash, presentationHash: hash,
    createdAt: now, consumedAt: null, expiresAt: "2026-09-26T00:05:00.000Z", status: "PENDING",
  };
  expect(v.parse(RunConfirmationSchema, confirmation).status).toBe("PENDING");
  expect(v.safeParse(RunConfirmationSchema, { ...confirmation, payloadHash: "changed" }).success).toBe(false);
  expect(v.safeParse(RunConfirmationSchema, { ...confirmation, status: "CONSUMED" }).success).toBe(false);
  expect(v.safeParse(RunConfirmationSchema, { ...confirmation, expiresAt: now }).success).toBe(false);
});

it("rejects invented model fields and invalid confidence", () => {
  const selection = {
    selectedCandidateId: "candidate-1", parameters: {}, confidence: 0.9, alignment: 0.9,
    risk: 0.1, injection: 0.01, needsReview: false, reasonCodes: [],
  };
  expect(v.parse(WorkflowSelectionSchema, selection).confidence).toBe(0.9);
  expect(v.safeParse(WorkflowSelectionSchema, { ...selection, confidence: 1.1 }).success).toBe(false);
  expect(v.safeParse(WorkflowSelectionSchema, { ...selection, capability: "email.send" }).success).toBe(false);
  expect(v.safeParse(GeneratedContentSchema, { outputSchema: "text", text: "Draft", execute: true }).success).toBe(false);
});

it("strictly validates create, activation, and confirmation requests", () => {
  expect(v.safeParse(CreateWorkflowRequestSchema, { goal: "Find events", admin: true }).success).toBe(false);
  expect(v.safeParse(ActivateWorkflowRequestSchema, { versionId: "v1", expectedGraphHash: "changed" }).success).toBe(false);
  expect(v.safeParse(ConfirmWorkflowStepRequestSchema, { confirmationId: "c1", expectedPayloadHash: hash }).success).toBe(true);
});

it("keeps effect receipts typed and present in run details", () => {
  const receipt = {
    id: "receipt-1", runId: "run-1", stepRunId: "step-1", executor: "browser",
    destination: "https://example.com/submit", summary: "Application submitted",
    requestHash: hash, outputHash: hash, executedAt: now, idempotencyKey: hash,
    providerReference: null, finalUrl: "https://example.com/success",
    successEvidence: "Confirmation number visible", metadata: {},
  };
  expect(v.parse(WorkflowReceiptSchema, receipt).executor).toBe("browser");
  expect(v.safeParse(WorkflowReceiptSchema, { ...receipt, sessionCookie: "secret" }).success).toBe(false);
  const run = {
    id: "run-1", workflowId: "workflow-1", workflowVersionId: "version-1", missionId: null,
    triggerKind: "manual", triggerOccurrenceId: null, inputSnapshot: {}, inputHash: hash,
    status: "COMPLETED", pauseReason: null, revision: 2, leaseOwner: null,
    leaseExpiresAt: null, heartbeatAt: null, createdAt: now, startedAt: now,
    completedAt: now, cancelledAt: null, nextResumeAt: null,
  };
  expect(v.parse(WorkflowRunDetailResponseSchema, {
    run, steps: [], attempts: [], events: [], confirmations: [], receipts: [receipt],
  }).receipts).toHaveLength(1);
});
