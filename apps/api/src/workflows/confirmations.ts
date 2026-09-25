import { randomUUID } from "node:crypto";
import { isIP } from "node:net";
import * as v from "valibot";
import { hashCanonical, HexSchema, BoundedPayloadSchema, type Hex, type RunConfirmation, type StepRun, type JsonValue } from "@humanos/schemas";
import type { WorkflowStore } from "@humanos/database";
import type { StepExecutionContext, StepExecutionResult, WorkflowActor } from "./types.js";
import { WorkflowPause, WorkflowExecutionError } from "./runner.js";

const text = v.pipe(v.string(), v.minLength(1), v.maxLength(10000));
const SubmissionSchema = v.strictObject({
  destination: text,
  fields: v.pipe(v.record(text, v.pipe(v.string(), v.maxLength(10000))), v.maxEntries(100)),
  attachments: v.pipe(v.array(v.strictObject({ name: text, contentHash: HexSchema })), v.maxLength(20)),
  value: v.nullable(v.strictObject({ amount: v.pipe(v.string(), v.regex(/^\d+(\.\d{1,18})?$/)), currency: v.pipe(v.string(), v.regex(/^[A-Z]{3}$/)) })),
  pageFingerprint: HexSchema,
});
export type BrowserSubmission = v.InferOutput<typeof SubmissionSchema>;
export function publicDestination(raw: string): string {
  const url = new URL(raw);
  const hostname = url.hostname.replace(/^\[|\]$/g, "").toLowerCase();
  // Literal IPs and local names are unnecessary for third-party bookings. DNS
  // destinations additionally require address/redirect checks by the browser port.
  if (!["https:", "http:"].includes(url.protocol) || url.username || url.password || isIP(hostname) || !hostname.includes(".") || /(^|\.)(localhost|local|internal|test|invalid)$/.test(hostname) || hostname.endsWith("."))
    throw new Error("UNSAFE_DESTINATION");
  url.hash = "";
  return url.href;
}
export function normalizeSubmission(input: unknown): BrowserSubmission {
  const value = v.parse(SubmissionSchema, input);
  const normalize = (s: string) => s.normalize("NFC").replace(/\r\n?/g, "\n");
  const fields: Record<string, string> = Object.create(null);
  for (const [key, entry] of Object.entries(value.fields).sort(([a], [b]) => a.localeCompare(b))) {
    const name = normalize(key);
    if (Object.hasOwn(fields, name) || ["__proto__", "constructor", "prototype"].includes(name)) throw new Error("AMBIGUOUS_FIELD");
    fields[name] = normalize(entry);
  }
  return { ...value, destination: publicDestination(value.destination), fields,
    attachments: value.attachments.map(a => ({ ...a, name: normalize(a.name) })).sort((a, b) => a.name.localeCompare(b.name) || a.contentHash.localeCompare(b.contentHash)) };
}
export function submissionPayloadHash(versionId: string, runId: string, nodeId: string, submission: unknown): Hex {
  return hashCanonical({ versionId, runId, nodeId, submission: normalizeSubmission(submission) });
}
export interface PreparedAction {
  destination: string;
  /** Exact material values displayed and subsequently sent by the executor. */
  payload: Record<string, import("@humanos/schemas").JsonValue>;
  /** Public identity material applied by the provider (for example the email sender). */
  binding?: Record<string, import("@humanos/schemas").JsonValue>;
}
export function createWorkflowConfirmations(deps: {
  store: WorkflowStore;
  prepare(context: StepExecutionContext): Promise<PreparedAction>;
  requiresConfirmation?(type: import("@humanos/schemas").BlockType): boolean;
  clock?: () => Date;
}) {
  const clock = deps.clock ?? (() => new Date());
  const api = {
    async confirmNode(context: StepExecutionContext): Promise<StepExecutionResult> {
      const index = context.version.graph.nodes.findIndex(n => n.id === context.node.id);
      const target = context.version.graph.nodes.slice(index + 1).find(n => deps.requiresConfirmation?.(n.type));
      if (!target) throw new WorkflowPause("INPUT_REQUIRED", "Choose the exact action to review.");
      const steps = (await deps.store.list<StepRun>("workflow_steps")).filter(s => s.runId === context.run.id);
      const targetStep = steps.find(s => s.blockId === target.id);
      if (!targetStep) throw new Error("STEP_NOT_FOUND");
      async function materialize(value: JsonValue): Promise<JsonValue> {
        if (Array.isArray(value)) return Promise.all(value.map(materialize));
        if (value && typeof value === "object") {
          if (typeof value.$ref === "string" && Object.keys(value).length === 1) {
            const [id, field] = value.$ref.split(".");
            const step = steps.find(s => s.blockId === id && s.status === "COMPLETED");
            const output = step?.outputRef ? await deps.store.getValue(step.outputRef, context.run.id) : null;
            if (!output || typeof output !== "object" || Array.isArray(output) || !field || !Object.hasOwn(output, field)) throw new WorkflowPause("INPUT_REQUIRED", "Prepare the action's content before confirming.");
            return output[field]!;
          }
          return Object.fromEntries(await Promise.all(Object.entries(value).map(async ([k, val]) => [k, await materialize(val)])));
        }
        return value;
      }
      return api.probeApproved({ ...context, step: targetStep, node: target, input: await materialize(target.input) as Record<string, JsonValue>, idempotencyKey: targetStep.idempotencyKey }, async () => ({ output: { confirmed: true } }));
    },
    /** Final effect gate. `matches` ties the approved preparation to the executor's exact dispatch material. */
    async dispatchConfirmed(context: StepExecutionContext, dispatch: () => Promise<StepExecutionResult>, matches?: (prepared: PreparedAction) => boolean, live?: PreparedAction) {
      return api.probeApproved(context, dispatch, true, matches, live);
    },
    /** `live` lets an executor bind the material it is about to act on (e.g. the open browser page). */
    async probeApproved(context: StepExecutionContext, dispatch: () => Promise<StepExecutionResult>, claim = false, matches?: (prepared: PreparedAction) => boolean, live?: PreparedAction): Promise<StepExecutionResult> {
      if (context.signal.aborted) throw new Error("AUTHORIZATION_REVOKED");
      const prepared = live ?? await deps.prepare(context);
      v.parse(BoundedPayloadSchema, prepared.payload);
      if (prepared.binding !== undefined) v.parse(BoundedPayloadSchema, prepared.binding);
      v.parse(text, prepared.destination);
      if (matches && !matches(prepared)) throw Object.assign(new WorkflowExecutionError("CONFIRMATION"), { message: "CONFIRMATION_MISMATCH" });
      const payloadHash = hashCanonical({ accountId: context.actor.accountId, versionId: context.version.id, runId: context.run.id, nodeId: context.node.id, input: context.input, prepared });
      const confirmations = (await deps.store.list<RunConfirmation>("workflow_confirmations"))
        .filter(c => c.runId === context.run.id && c.stepRunId === context.step.id && c.actorAccountId === context.actor.accountId && c.payloadHash === payloadHash && Date.parse(c.expiresAt) > clock().getTime());
      const approved = confirmations.find(c => c.status === "CONSUMED");
      if (approved) {
        if (claim && !await deps.store.claimConfirmedDispatch({ runId: context.run.id, revision: context.run.revision, workerId: context.run.leaseOwner!, now: clock(), confirmationId: approved.id, stepId: context.step.id, accountId: context.actor.accountId, payloadHash, idempotencyKey: v.parse(HexSchema, context.idempotencyKey) }))
          throw Object.assign(new WorkflowExecutionError("UNKNOWN_OUTCOME"), { message: "DISPATCH_ALREADY_CLAIMED" });
        if (context.signal.aborted) throw new Error("AUTHORIZATION_REVOKED");
        return dispatch();
      }
      if (!confirmations.some(c => c.status === "PENDING")) {
        const now = clock();
        const confirmation: RunConfirmation = { id: randomUUID(), runId: context.run.id, stepRunId: context.step.id, actorAccountId: context.actor.accountId, actorRootId: context.actor.rootId,
          destination: prepared.destination, payloadHash, presentationHash: hashCanonical(prepared), createdAt: now.toISOString(), consumedAt: null, expiresAt: new Date(now.getTime() + 5 * 60000).toISOString(), status: "PENDING" };
        await deps.store.saveValue(confirmation.id, context.run.id, prepared as unknown as import("@humanos/schemas").JsonValue);
        await deps.store.insertConfirmation(confirmation);
      }
      throw new WorkflowPause("CONFIRMATION_REQUIRED", "Review the exact destination and content, then confirm once.");
    },
    async confirm(actor: WorkflowActor, runId: string, confirmationId: string, expectedPayloadHash: string) {
      const confirmation = await deps.store.get<RunConfirmation>("workflow_confirmations", confirmationId);
      if (!confirmation || confirmation.runId !== runId || confirmation.actorAccountId !== actor.accountId) throw new Error("NOT_FOUND");
      // Ownership is checked again in the store's run-locked transaction.
      return deps.store.consumeConfirmation(confirmationId, expectedPayloadHash, clock(), actor.accountId, true);
    },
    async preview(actor: WorkflowActor, confirmationId: string) {
      const confirmation = await deps.store.get<RunConfirmation>("workflow_confirmations", confirmationId);
      if (!confirmation || confirmation.actorAccountId !== actor.accountId) throw new Error("NOT_FOUND");
      return { confirmation, preview: await deps.store.getValue(confirmation.id, confirmation.runId) };
    },
  };
  return api;
}
