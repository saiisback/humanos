import { it, expect, vi } from "vitest";
import { hashCanonical } from "@humanos/schemas";
import { normalizeSubmission, submissionPayloadHash, createWorkflowConfirmations } from "../src/workflows/confirmations.js";
import type { WorkflowStore } from "@humanos/database";
import type { StepExecutionContext } from "../src/workflows/types.js";

const submission = { destination: "https://example.com/reserve", fields: { name: "User", guests: "2" }, attachments: [{ name: "a.txt", contentHash: hashCanonical("file") }], value: { amount: "20", currency: "USD" }, pageFingerprint: hashCanonical("page") };
it.each(["destination", "fields", "attachments", "value", "pageFingerprint"])("binds %s to the exact approval", (field) => {
  const changed = { ...submission, [field]: ({ destination: "https://example.com/other", fields: { name: "Other", guests: "2" }, attachments: [], value: null, pageFingerprint: hashCanonical("changed") })[field] };
  expect(submissionPayloadHash("v1", "r1", "n1", changed)).not.toBe(submissionPayloadHash("v1", "r1", "n1", submission));
});
it("binds workflow version, run, and node and normalizes only equivalent display values", () => {
  const hash = submissionPayloadHash("v1", "r1", "n1", submission);
  expect(submissionPayloadHash("v2", "r1", "n1", submission)).not.toBe(hash);
  expect(submissionPayloadHash("v1", "r2", "n1", submission)).not.toBe(hash);
  expect(submissionPayloadHash("v1", "r1", "n2", submission)).not.toBe(hash);
  expect(normalizeSubmission({ ...submission, fields: { guests: "2", name: "User" } })).toEqual(normalizeSubmission(submission));
});
it.each(["http://localhost/", "http://127.0.0.1/", "http://[::1]/", "http://169.254.169.254/", "file:///tmp/a", "https://user:secret@example.com/"])("rejects unsafe destination %s", (destination) => {
  expect(() => normalizeSubmission({ ...submission, destination })).toThrow();
});
it("probes approval without spending it, but claims final dispatch at most once", async () => {
  const context = { actor: { accountId: "account", rootId: null }, run: { id: "run", revision: 1, leaseOwner: "worker" },
    version: { id: "version" }, node: { id: "node" }, step: { id: "step", idempotencyKey: hashCanonical("step") },
    input: { subject: "Hello" }, idempotencyKey: hashCanonical("step"), signal: new AbortController().signal } as unknown as StepExecutionContext;
  const prepared = { destination: "recipient@example.org", payload: { subject: "Hello" } };
  const payloadHash = hashCanonical({ accountId: "account", versionId: "version", runId: "run", nodeId: "node", input: context.input, prepared });
  const claim = vi.fn().mockResolvedValueOnce(true).mockResolvedValue(false);
  const store = { list: async () => [{ id: "confirmation", runId: "run", stepRunId: "step", actorAccountId: "account", payloadHash,
    expiresAt: "2026-10-01T00:00:00.000Z", status: "CONSUMED" }], claimConfirmedDispatch: claim } as unknown as WorkflowStore;
  const confirmations = createWorkflowConfirmations({ store, prepare: async () => prepared, clock: () => new Date("2026-09-26T00:00:00.000Z") });
  const probe = vi.fn(async () => ({ output: {} }));
  await confirmations.probeApproved(context, probe);
  await confirmations.probeApproved(context, probe);
  expect(probe).toHaveBeenCalledTimes(2);
  expect(claim).not.toHaveBeenCalled();
  const dispatch = vi.fn(async () => ({ output: {} }));
  await confirmations.dispatchConfirmed(context, dispatch);
  await expect(confirmations.dispatchConfirmed(context, dispatch)).rejects.toThrow("DISPATCH_ALREADY_CLAIMED");
  expect(dispatch).toHaveBeenCalledTimes(1);
});
it("binds public sender identity into the approval and refuses a final claim for different exact material", async () => {
  const context = { actor: { accountId: "account", rootId: null }, run: { id: "run", revision: 1, leaseOwner: "worker" },
    version: { id: "version" }, node: { id: "node" }, step: { id: "step", idempotencyKey: hashCanonical("step") },
    input: { subject: "Hello" }, idempotencyKey: hashCanonical("step"), signal: new AbortController().signal } as unknown as StepExecutionContext;
  let sender = "sender@example.org";
  const prepare = async () => ({ destination: "recipient@example.org", payload: { subject: "Hello" }, binding: { sender } });
  const approvedHash = hashCanonical({ accountId: "account", versionId: "version", runId: "run", nodeId: "node", input: context.input, prepared: await prepare() });
  const claim = vi.fn(async () => true);
  const inserted: unknown[] = [];
  const store = { list: async () => [{ id: "confirmation", runId: "run", stepRunId: "step", actorAccountId: "account", payloadHash: approvedHash,
    expiresAt: "2026-10-01T00:00:00.000Z", status: "CONSUMED" }], claimConfirmedDispatch: claim,
    saveValue: async () => "x", insertConfirmation: async (c: unknown) => { inserted.push(c); } } as unknown as WorkflowStore;
  const confirmations = createWorkflowConfirmations({ store, prepare, clock: () => new Date("2026-09-26T00:00:00.000Z") });
  const dispatch = vi.fn(async () => ({ output: {} }));
  await expect(confirmations.dispatchConfirmed(context, dispatch, () => false)).rejects.toThrow("CONFIRMATION_MISMATCH");
  expect(claim).not.toHaveBeenCalled();
  sender = "impostor@example.org";
  await expect(confirmations.dispatchConfirmed(context, dispatch)).rejects.toThrow("Review the exact destination");
  expect(inserted).toHaveLength(1);
  expect(claim).not.toHaveBeenCalled();
  expect(dispatch).not.toHaveBeenCalled();
});
