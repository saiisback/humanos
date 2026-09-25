import * as v from "valibot";
import {
  CapabilitySchema,
  HexSchema,
  IdSchema,
  JsonValueSchema,
  PayloadSchema,
  RiskLevelSchema,
  TimestampSchema,
} from "./domain.js";

const UserTextSchema = v.pipe(v.string(), v.minLength(1), v.maxLength(10000));
const ShortTextSchema = v.pipe(v.string(), v.minLength(1), v.maxLength(256));
const PreviewSchema = v.pipe(v.string(), v.maxLength(10000));
const PositiveIntSchema = v.pipe(v.number(), v.integer(), v.minValue(1));
const NonnegativeIntSchema = v.pipe(v.number(), v.integer(), v.minValue(0));
const ProbabilitySchema = v.pipe(v.number(), v.finite(), v.minValue(0), v.maxValue(1));
const BoundedIdsSchema = v.pipe(v.array(IdSchema), v.maxLength(64));
const BoundedCapabilitiesSchema = v.pipe(v.array(CapabilitySchema), v.maxLength(32));
const TimeoutMsSchema = v.pipe(v.number(), v.integer(), v.minValue(100), v.maxValue(300000));
const MaxAttemptsSchema = v.pipe(v.number(), v.integer(), v.minValue(1), v.maxValue(5));

// A workflow payload is JSON data, but it cannot be an unbounded model or client envelope.
function isBoundedJson(value: unknown): boolean {
  let entries = 0;
  let characters = 0;
  const seen = new WeakSet<object>();
  const pending: Array<{ value: unknown; depth: number }> = [{ value, depth: 0 }];
  while (pending.length > 0) {
    const item = pending.pop()!;
    if (++entries > 4096 || item.depth > 12) return false;
    if (typeof item.value === "string") {
      if (item.value.length > 10000) return false;
      characters += item.value.length;
    } else if (item.value && typeof item.value === "object") {
      if (seen.has(item.value)) return false;
      seen.add(item.value);
      if (Array.isArray(item.value)) {
        if (item.value.length > 256) return false;
        for (const child of item.value) pending.push({ value: child, depth: item.depth + 1 });
      } else {
        const pairs = Object.entries(item.value);
        if (pairs.length > 256) return false;
        for (const [key, child] of pairs) {
          if (key.length > 256) return false;
          characters += key.length;
          pending.push({ value: child, depth: item.depth + 1 });
        }
      }
    }
    if (characters > 65536) return false;
  }
  return true;
}

export const BoundedJsonValueSchema = v.pipe(
  v.unknown(),
  v.check((value) => isBoundedJson(value)),
  JsonValueSchema,
);
export const BoundedPayloadSchema = v.pipe(
  v.unknown(),
  v.check((value) => isBoundedJson(value)),
  PayloadSchema,
);
export type BoundedPayload = v.InferOutput<typeof BoundedPayloadSchema>;

export const BlockTypeSchema = v.picklist([
  "research.web", "extract.structured", "browser.navigate", "browser.extract",
  "browser.fill", "browser.submit", "connector.call", "content.generate",
  "content.transform", "control.wait", "control.branch", "control.join",
  "human.connect", "human.confirm", "human.input", "schedule.once",
  "schedule.recurring", "application.submit", "calendar.create",
]);
export type BlockType = v.InferOutput<typeof BlockTypeSchema>;
export const BlockVersionSchema = v.pipe(v.string(), v.regex(/^\d+\.\d+\.\d+$/), v.maxLength(32));
export const RunStatusSchema = v.picklist([
  "QUEUED", "RUNNING", "CONNECTION_REQUIRED", "CONFIRMATION_REQUIRED",
  "INPUT_REQUIRED", "WAITING", "RETRY_SCHEDULED", "COMPLETED", "FAILED",
  "CANCELLED", "REVOKED", "RECONCILIATION_REQUIRED",
]);
export type RunStatus = v.InferOutput<typeof RunStatusSchema>;
export const StepStatusSchema = v.picklist([
  "PENDING", "READY", "RUNNING", "WAITING", "RETRY_SCHEDULED",
  "COMPLETED", "SKIPPED", "FAILED", "CANCELLED", "REVOKED",
  "RECONCILIATION_REQUIRED",
]);
export type StepStatus = v.InferOutput<typeof StepStatusSchema>;
export const ErrorClassSchema = v.picklist([
  "TRANSIENT", "VALIDATION", "AUTHORIZATION", "REJECTION", "CONFIRMATION",
  "UNKNOWN_OUTCOME", "TIMEOUT", "INTERNAL",
]);
export type ErrorClass = v.InferOutput<typeof ErrorClassSchema>;
export const ExecutorKindSchema = v.picklist(["local", "connector", "browser", "timer", "human", "content"]);
export type ExecutorKind = v.InferOutput<typeof ExecutorKindSchema>;

export const WorkflowNodeSchema = v.strictObject({
  id: IdSchema,
  type: BlockTypeSchema,
  blockVersion: BlockVersionSchema,
  dependsOn: v.pipe(v.array(IdSchema), v.maxLength(32)),
  input: BoundedPayloadSchema,
  capability: v.nullable(CapabilitySchema),
  timeoutMs: TimeoutMsSchema,
  maxAttempts: MaxAttemptsSchema,
});
export type WorkflowNode = v.InferOutput<typeof WorkflowNodeSchema>;
export const WorkflowGraphSchema = v.pipe(
  v.strictObject({ nodes: v.pipe(v.array(WorkflowNodeSchema), v.maxLength(64)) }),
  v.check(({ nodes }) => nodes.reduce((count, node) => count + node.dependsOn.length, 0) <= 128),
);
export type WorkflowGraph = v.InferOutput<typeof WorkflowGraphSchema>;

export const WorkflowStatusSchema = v.picklist(["DRAFT", "ACTIVE", "PAUSED", "ARCHIVED"]);
export type WorkflowStatus = v.InferOutput<typeof WorkflowStatusSchema>;
export const WorkflowSchema = v.strictObject({
  id: IdSchema,
  accountId: IdSchema,
  rootId: v.nullable(IdSchema),
  missionId: v.nullable(IdSchema),
  name: ShortTextSchema,
  status: WorkflowStatusSchema,
  latestVersionId: v.nullable(IdSchema),
  createdAt: TimestampSchema,
  updatedAt: TimestampSchema,
  archivedAt: v.nullable(TimestampSchema),
});
export type Workflow = v.InferOutput<typeof WorkflowSchema>;

export const WorkflowTriggerSchema = v.variant("kind", [
  v.strictObject({ kind: v.literal("manual") }),
  v.strictObject({ kind: v.literal("once"), fireAt: TimestampSchema, timezone: ShortTextSchema }),
  v.strictObject({ kind: v.literal("recurring"), expression: ShortTextSchema, timezone: ShortTextSchema }),
]);
export type WorkflowTrigger = v.InferOutput<typeof WorkflowTriggerSchema>;
export const WorkflowVersionSchema = v.strictObject({
  id: IdSchema,
  workflowId: IdSchema,
  version: PositiveIntSchema,
  goal: UserTextSchema,
  normalizedIntent: BoundedPayloadSchema,
  graph: WorkflowGraphSchema,
  graphHash: HexSchema,
  requiredCapabilities: BoundedCapabilitiesSchema,
  connectorRefs: BoundedIdsSchema,
  browserFallbackAllowed: v.boolean(),
  trigger: WorkflowTriggerSchema,
  assembler: v.strictObject({ modelId: ShortTextSchema, modelVersion: ShortTextSchema, decisionHash: HexSchema }),
  createdAt: TimestampSchema,
  activatedAt: v.nullable(TimestampSchema),
});
export type WorkflowVersion = v.InferOutput<typeof WorkflowVersionSchema>;

export const WorkflowRunSchema = v.strictObject({
  id: IdSchema,
  workflowId: IdSchema,
  workflowVersionId: IdSchema,
  missionId: v.nullable(IdSchema),
  triggerKind: v.picklist(["manual", "once", "recurring", "api"]),
  triggerOccurrenceId: v.nullable(IdSchema),
  inputSnapshot: BoundedPayloadSchema,
  inputHash: HexSchema,
  status: RunStatusSchema,
  pauseReason: v.nullable(ShortTextSchema),
  revision: NonnegativeIntSchema,
  leaseOwner: v.nullable(IdSchema),
  leaseExpiresAt: v.nullable(TimestampSchema),
  heartbeatAt: v.nullable(TimestampSchema),
  createdAt: TimestampSchema,
  startedAt: v.nullable(TimestampSchema),
  completedAt: v.nullable(TimestampSchema),
  cancelledAt: v.nullable(TimestampSchema),
  nextResumeAt: v.nullable(TimestampSchema),
});
export type WorkflowRun = v.InferOutput<typeof WorkflowRunSchema>;

export const StepRunSchema = v.strictObject({
  id: IdSchema,
  runId: IdSchema,
  blockId: IdSchema,
  blockType: BlockTypeSchema,
  blockVersion: BlockVersionSchema,
  dependencies: v.pipe(v.array(IdSchema), v.maxLength(32)),
  status: StepStatusSchema,
  attemptCount: NonnegativeIntSchema,
  timeoutMs: TimeoutMsSchema,
  maxAttempts: MaxAttemptsSchema,
  inputRef: v.nullable(IdSchema),
  inputHash: v.nullable(HexSchema),
  outputRef: v.nullable(IdSchema),
  outputHash: v.nullable(HexSchema),
  idempotencyKey: HexSchema,
  startedAt: v.nullable(TimestampSchema),
  completedAt: v.nullable(TimestampSchema),
  errorClass: v.nullable(ErrorClassSchema),
});
export type StepRun = v.InferOutput<typeof StepRunSchema>;

export const StepAttemptSchema = v.strictObject({
  id: IdSchema,
  stepRunId: IdSchema,
  attemptNumber: PositiveIntSchema,
  executor: ExecutorKindSchema,
  provider: v.nullable(ShortTextSchema),
  metadata: BoundedPayloadSchema,
  requestHash: v.nullable(HexSchema),
  responseHash: v.nullable(HexSchema),
  requestPreview: v.nullable(PreviewSchema),
  responsePreview: v.nullable(PreviewSchema),
  jevDecision: v.nullable(BoundedPayloadSchema),
  errorClass: v.nullable(ErrorClassSchema),
  errorMessage: v.nullable(PreviewSchema),
  startedAt: TimestampSchema,
  completedAt: v.nullable(TimestampSchema),
  receiptId: v.nullable(IdSchema),
});
export type StepAttempt = v.InferOutput<typeof StepAttemptSchema>;

export const WorkflowEventSchema = v.strictObject({
  id: IdSchema,
  runId: IdSchema,
  stepRunId: v.nullable(IdSchema),
  sequence: PositiveIntSchema,
  type: ShortTextSchema,
  data: BoundedPayloadSchema,
  createdAt: TimestampSchema,
});
export type WorkflowEvent = v.InferOutput<typeof WorkflowEventSchema>;

export const WorkflowReceiptSchema = v.strictObject({
  id: IdSchema,
  runId: IdSchema,
  stepRunId: IdSchema,
  executor: ExecutorKindSchema,
  destination: UserTextSchema,
  summary: UserTextSchema,
  requestHash: HexSchema,
  outputHash: HexSchema,
  executedAt: TimestampSchema,
  idempotencyKey: HexSchema,
  providerReference: v.nullable(ShortTextSchema),
  finalUrl: v.nullable(UserTextSchema),
  successEvidence: v.nullable(PreviewSchema),
  metadata: BoundedPayloadSchema,
});
export type WorkflowReceipt = v.InferOutput<typeof WorkflowReceiptSchema>;

export const RunConfirmationStatusSchema = v.picklist(["PENDING", "CONSUMED", "EXPIRED", "CANCELLED"]);
export const RunConfirmationSchema = v.pipe(
  v.strictObject({
    id: IdSchema,
    runId: IdSchema,
    stepRunId: IdSchema,
    actorAccountId: IdSchema,
    actorRootId: v.nullable(IdSchema),
    destination: UserTextSchema,
    payloadHash: HexSchema,
    presentationHash: HexSchema,
    createdAt: TimestampSchema,
    consumedAt: v.nullable(TimestampSchema),
    expiresAt: TimestampSchema,
    status: RunConfirmationStatusSchema,
  }),
  v.check((confirmation) =>
    Date.parse(confirmation.expiresAt) > Date.parse(confirmation.createdAt) &&
    (confirmation.status === "CONSUMED") === (confirmation.consumedAt !== null) &&
    (confirmation.consumedAt === null || Date.parse(confirmation.consumedAt) <= Date.parse(confirmation.expiresAt))),
);
export type RunConfirmation = v.InferOutput<typeof RunConfirmationSchema>;

export const WorkflowScheduleSchema = v.strictObject({
  id: IdSchema,
  workflowId: IdSchema,
  workflowVersionId: IdSchema,
  definition: v.variant("kind", [
    v.strictObject({ kind: v.literal("once"), fireAt: TimestampSchema, timezone: ShortTextSchema }),
    v.strictObject({ kind: v.literal("recurring"), expression: ShortTextSchema, timezone: ShortTextSchema }),
  ]),
  nextFireAt: v.nullable(TimestampSchema),
  lastFireAt: v.nullable(TimestampSchema),
  status: v.picklist(["ACTIVE", "PAUSED", "CANCELLED", "COMPLETED"]),
  overlapPolicy: v.literal("skip"),
  createdAt: TimestampSchema,
  updatedAt: TimestampSchema,
});
export type WorkflowSchedule = v.InferOutput<typeof WorkflowScheduleSchema>;

export const WorkflowAssemblyCandidateSchema = v.strictObject({
  id: IdSchema,
  type: v.union([BlockTypeSchema, v.literal("complete")]),
  description: ShortTextSchema,
  parameterOptions: BoundedPayloadSchema,
});
export type WorkflowAssemblyCandidate = v.InferOutput<typeof WorkflowAssemblyCandidateSchema>;
export const WorkflowSelectionInputSchema = v.strictObject({
  goal: UserTextSchema,
  stateHash: HexSchema,
  turn: v.pipe(v.number(), v.integer(), v.minValue(0), v.maxValue(80)),
  history: v.optional(v.pipe(v.array(BlockTypeSchema), v.maxLength(64))),
  candidates: v.pipe(v.array(WorkflowAssemblyCandidateSchema), v.minLength(1), v.maxLength(65)),
});
export type WorkflowSelectionInput = v.InferOutput<typeof WorkflowSelectionInputSchema>;
export const WorkflowSelectionSchema = v.strictObject({
  selectedCandidateId: IdSchema,
  parameters: BoundedPayloadSchema,
  confidence: ProbabilitySchema,
  alignment: ProbabilitySchema,
  risk: ProbabilitySchema,
  injection: ProbabilitySchema,
  needsReview: v.boolean(),
  reasonCodes: v.pipe(v.array(ShortTextSchema), v.maxLength(32)),
});
export type WorkflowSelection = v.InferOutput<typeof WorkflowSelectionSchema>;

export const ContentBriefSchema = v.strictObject({
  instruction: UserTextSchema,
  context: BoundedJsonValueSchema,
  outputSchema: v.picklist(["text", "email", "form_fields"]),
  maxCharacters: v.pipe(v.number(), v.integer(), v.minValue(1), v.maxValue(10000)),
});
export type ContentBrief = v.InferOutput<typeof ContentBriefSchema>;
export const GeneratedContentSchema = v.variant("outputSchema", [
  v.strictObject({ outputSchema: v.literal("text"), text: UserTextSchema }),
  v.strictObject({ outputSchema: v.literal("email"), subject: ShortTextSchema, body: UserTextSchema }),
  v.strictObject({
    outputSchema: v.literal("form_fields"),
    fields: v.pipe(v.record(ShortTextSchema, UserTextSchema), v.check((fields) => Object.keys(fields).length <= 64)),
  }),
]);
export type GeneratedContent = v.InferOutput<typeof GeneratedContentSchema>;
