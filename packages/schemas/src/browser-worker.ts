import * as v from "valibot";
import { HexSchema, TimestampSchema } from "./domain.js";

/**
 * Versioned, newline-framed JSON protocol between the workflow runner and the local
 * Browser Use worker (a child process on pipes, never a network listener). Every
 * message is bound to one account, run, browser session, monotonic action id and
 * observation revision. Payloads are typed data: no scripts, URLs, selectors, paths
 * or other executable instructions can be expressed.
 */
export const BROWSER_WORKER_PROTOCOL_VERSION = 1;
export const BROWSER_WORKER_MAX_MESSAGE_BYTES = 256 * 1024;

const ScopeIdSchema = v.pipe(v.string(), v.regex(/^[A-Za-z0-9:_.-]{1,128}$/));
const SequenceSchema = v.pipe(v.number(), v.integer(), v.minValue(0), v.maxValue(2 ** 31 - 1));
const ActionIdSchema = v.pipe(v.number(), v.integer(), v.minValue(1), v.maxValue(2 ** 31 - 1));
export const BrowserPolicyIdSchema = v.pipe(v.string(), v.regex(/^[a-z][a-z0-9-]{0,63}$/));
export const BrowserCandidateIdSchema = v.pipe(v.string(), v.regex(/^(navigate|extract|fill|select|submit):[A-Za-z0-9_-]{1,64}$/));
const FieldNameSchema = v.pipe(v.string(), v.regex(/^[a-z][a-z0-9_]{0,63}$/));
const FieldsSchema = v.pipe(v.record(FieldNameSchema, v.pipe(v.string(), v.maxLength(2000))), v.maxEntries(32));
const ShortText = v.pipe(v.string(), v.maxLength(500));
const OriginSchema = v.pipe(v.string(), v.maxLength(256), v.regex(/^https?:\/\/[a-z0-9.-]+(:\d{1,5})?$/));

export const BrowserSubmissionPermitSchema = v.strictObject({
  runId: ScopeIdSchema,
  sessionId: ScopeIdSchema,
  actionId: ActionIdSchema,
  observationRevision: SequenceSchema,
  payloadHash: HexSchema,
  expiresAt: TimestampSchema,
});
export type BrowserSubmissionPermit = v.InferOutput<typeof BrowserSubmissionPermitSchema>;

const envelope = {
  protocolVersion: v.literal(BROWSER_WORKER_PROTOCOL_VERSION),
  accountId: ScopeIdSchema,
  runId: ScopeIdSchema,
  sessionId: ScopeIdSchema,
  actionId: ActionIdSchema,
  observationRevision: SequenceSchema,
};
const command = <C extends string, P extends v.GenericSchema>(name: C, payload: P) =>
  v.strictObject({ ...envelope, command: v.literal(name), payload });
const Empty = v.strictObject({});

export const BrowserWorkerCommandSchema = v.variant("command", [
  command("start", v.strictObject({ policyId: BrowserPolicyIdSchema })),
  command("observe", Empty),
  command("act", v.strictObject({ candidateId: BrowserCandidateIdSchema })),
  command("prepare", v.strictObject({ fields: FieldsSchema })),
  command("submit", v.strictObject({ permit: BrowserSubmissionPermitSchema })),
  command("inspect_receipt", Empty),
  command("close", Empty),
]);
export type BrowserWorkerCommand = v.InferOutput<typeof BrowserWorkerCommandSchema>;
export type BrowserWorkerCommandName = BrowserWorkerCommand["command"];
export type BrowserWorkerPayload<C extends BrowserWorkerCommandName> = Extract<BrowserWorkerCommand, { command: C }>["payload"];

export const BrowserCandidateSchema = v.strictObject({
  id: BrowserCandidateIdSchema,
  kind: v.picklist(["navigate", "extract", "fill", "select", "submit"]),
  label: v.pipe(v.string(), v.maxLength(200)),
  targetId: v.pipe(v.string(), v.regex(/^[A-Za-z0-9_-]{1,64}$/)),
  policyId: BrowserPolicyIdSchema,
  observationRevision: SequenceSchema,
});
export type BrowserCandidate = v.InferOutput<typeof BrowserCandidateSchema>;

export const BrowserHandoffReasonSchema = v.picklist([
  "LOGIN_REQUIRED", "CAPTCHA", "UNSUPPORTED_EFFECT", "POLICY_BLOCKED", "STALE_OBSERVATION",
  "PAGE_CHANGED", "UNAVAILABLE_SLOT", "TIMEOUT", "PROFILE_BUSY",
]);
export type BrowserHandoffReason = v.InferOutput<typeof BrowserHandoffReasonSchema>;

const result = <S extends string, P extends v.GenericSchema>(status: S, payload: P) =>
  v.strictObject({ ...envelope, status: v.literal(status), payload });
export const BrowserWorkerResultSchema = v.variant("status", [
  result("ready", v.strictObject({
    runtime: v.strictObject({ name: v.literal("browser-use"), version: v.pipe(v.string(), v.regex(/^\d+\.\d+\.\d+$/)) }),
    policyId: BrowserPolicyIdSchema,
    origin: OriginSchema,
    profile: v.literal("dedicated"),
  })),
  result("observed", v.strictObject({
    origin: OriginSchema,
    path: v.pipe(v.string(), v.maxLength(512)),
    title: v.pipe(v.string(), v.maxLength(200)),
    loginRequired: v.boolean(),
    facts: v.pipe(v.array(v.strictObject({ label: v.pipe(v.string(), v.maxLength(64)), text: ShortText })), v.maxLength(32)),
    candidates: v.pipe(v.array(BrowserCandidateSchema), v.maxLength(64)),
  })),
  result("acted", Empty),
  result("prepared", v.strictObject({
    destination: v.pipe(v.string(), v.maxLength(512)),
    fields: FieldsSchema,
    material: v.pipe(v.array(ShortText), v.maxLength(16)),
    value: v.nullable(v.strictObject({ amount: v.pipe(v.string(), v.regex(/^\d+(\.\d{1,18})?$/)), currency: v.pipe(v.string(), v.regex(/^[A-Z]{3}$/)) })),
    materialHash: HexSchema,
  })),
  result("submitted", v.strictObject({
    providerReference: v.pipe(v.string(), v.minLength(1), v.maxLength(128)),
    finalUrl: v.pipe(v.string(), v.maxLength(512)),
    successEvidence: ShortText,
  })),
  result("handoff", v.strictObject({ reason: BrowserHandoffReasonSchema, message: ShortText })),
  result("unavailable", v.strictObject({ reason: v.picklist(["RUNTIME_MISSING", "INCOMPATIBLE_RUNTIME", "POLICY_UNKNOWN", "NO_RECEIPT"]), message: ShortText })),
  result("failed", v.strictObject({ code: v.picklist(["PROTOCOL", "POLICY", "BROWSER", "UNKNOWN_OUTCOME", "PERMIT"]), message: ShortText })),
  result("closed", Empty),
]);
export type BrowserWorkerResult = v.InferOutput<typeof BrowserWorkerResultSchema>;
export type BrowserWorkerStatus = BrowserWorkerResult["status"];

function decode(raw: string): unknown {
  if (Buffer.byteLength(raw, "utf8") > BROWSER_WORKER_MAX_MESSAGE_BYTES) throw new Error("MESSAGE_TOO_LARGE");
  if (raw.includes("\n")) throw new Error("FRAMING");
  // valibot records skip prototype keys silently; refuse them so both sides see the same payload.
  const value: unknown = JSON.parse(raw, (key, item: unknown) => {
    if (key === "__proto__" || key === "constructor" || key === "prototype") throw new Error("PROTOCOL");
    return item;
  });
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("PROTOCOL");
  return value;
}
export function parseBrowserWorkerCommand(raw: string): BrowserWorkerCommand {
  return v.parse(BrowserWorkerCommandSchema, decode(raw));
}
export interface BrowserWorkerExpectation { accountId: string; runId: string; sessionId: string; actionId: number }
/** Validates a worker reply and requires it to answer exactly the request that was sent. */
export function parseBrowserWorkerResult(raw: string, expected: BrowserWorkerExpectation): BrowserWorkerResult {
  const parsed = v.parse(BrowserWorkerResultSchema, decode(raw));
  if (parsed.accountId !== expected.accountId || parsed.runId !== expected.runId ||
      parsed.sessionId !== expected.sessionId || parsed.actionId !== expected.actionId) throw new Error("SCOPE_MISMATCH");
  if (parsed.status === "observed" && parsed.payload.candidates.some(c => c.observationRevision !== parsed.observationRevision))
    throw new Error("STALE_CANDIDATE");
  return parsed;
}
/** One JSON object per line; key order is preserved so both runtimes frame identically. */
export function encodeBrowserWorkerMessage(message: BrowserWorkerCommand | BrowserWorkerResult): string {
  const text = JSON.stringify(message);
  if (Buffer.byteLength(text, "utf8") > BROWSER_WORKER_MAX_MESSAGE_BYTES) throw new Error("MESSAGE_TOO_LARGE");
  return `${text}\n`;
}

/** Runner-side view of one worker session: issues action ids and tracks the latest revision. */
export function createBrowserWorkerScope(scope: { accountId: string; runId: string; sessionId: string }) {
  let nextAction = 1;
  let answered = 0;
  let revision = 0;
  return {
    get revision() { return revision; },
    get sessionId() { return scope.sessionId; },
    command<C extends BrowserWorkerCommandName>(name: C, payload: BrowserWorkerPayload<C>): Extract<BrowserWorkerCommand, { command: C }> {
      return v.parse(BrowserWorkerCommandSchema, {
        protocolVersion: BROWSER_WORKER_PROTOCOL_VERSION, ...scope, actionId: nextAction++,
        observationRevision: revision, command: name, payload,
      }) as Extract<BrowserWorkerCommand, { command: C }>;
    },
    expecting(sent: BrowserWorkerCommand): BrowserWorkerExpectation {
      return { ...scope, actionId: sent.actionId };
    },
    accept(reply: BrowserWorkerResult): BrowserWorkerResult {
      if (reply.actionId <= answered || reply.actionId >= nextAction) throw new Error("REPLAYED_ACTION");
      if (reply.observationRevision < revision) throw new Error("STALE_OBSERVATION");
      answered = reply.actionId;
      revision = reply.observationRevision;
      return reply;
    },
  };
}
export type BrowserWorkerScope = ReturnType<typeof createBrowserWorkerScope>;
