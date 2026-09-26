import * as v from "valibot";
import {
  CapabilitySchema,
  ChainIdSchema,
  ActionProposalSchema,
  ApprovalSchema,
  ExecutionReceiptSchema,
  IdSchema,
  JevAssessmentSchema,
  MissionSchema,
  PayloadSchema,
  PolicyDecisionSchema,
  RootIdentitySchema,
  TimestampSchema,
  WalletAccountSchema,
  JawPermissionGrantSchema,
  JawPermissionReviewSchema,
  HexSchema,
} from "./domain.js";
import { AuditEventSchema } from "./events.js";
import {
  BoundedPayloadSchema,
  RunConfirmationSchema,
  StepAttemptSchema,
  StepRunSchema,
  WorkflowEventSchema,
  WorkflowRunSchema,
  WorkflowReceiptSchema,
  WorkflowScheduleSchema,
  WorkflowSchema,
  WorkflowTriggerSchema,
  WorkflowVersionSchema,
} from "./workflows.js";
export const ReadinessSchema = v.strictObject({
  ready: v.boolean(),
  services: v.array(
    v.strictObject({
      name: v.string(),
      ready: v.boolean(),
      reason: v.nullable(v.string()),
    }),
  ),
});
export type Readiness = v.InferOutput<typeof ReadinessSchema>;
export const WorldProofRequestSchema = v.strictObject({
  requestId: IdSchema,
  action: v.string(),
  signal: v.string(),
  rpContext: PayloadSchema,
  appId: v.string(),
  environment: v.picklist(["staging", "production"]),
});
export type WorldProofRequest = v.InferOutput<typeof WorldProofRequestSchema>;
export const SessionResponseSchema = v.strictObject({
  root: v.nullable(RootIdentitySchema),
});
export type SessionResponse = v.InferOutput<typeof SessionResponseSchema>;
export const CreateSiweChallengeResponseSchema = v.strictObject({
  challengeId: IdSchema,
  nonce: IdSchema,
  expiresAt: TimestampSchema,
  chainId: ChainIdSchema,
  domain: v.string(),
  uri: v.string(),
});
export type CreateSiweChallengeResponse = v.InferOutput<
  typeof CreateSiweChallengeResponseSchema
>;
export const VerifySiweRequestSchema = v.strictObject({
  challengeId: IdSchema,
  message: v.string(),
  signature: v.string(),
});
export type VerifySiweRequest = v.InferOutput<typeof VerifySiweRequestSchema>;
export const AuthSessionResponseSchema = v.strictObject({
  account: v.nullable(WalletAccountSchema),
  root: v.nullable(RootIdentitySchema),
  jawConfigured: v.boolean(),
});
export type AuthSessionResponse = v.InferOutput<
  typeof AuthSessionResponseSchema
>;
export const CreateMissionRequestSchema = v.strictObject({
  goal: v.pipe(v.string(), v.minLength(1), v.maxLength(10000)),
  expiresAt: v.optional(TimestampSchema),
});
export type CreateMissionRequest = v.InferOutput<
  typeof CreateMissionRequestSchema
>;
export const MissionListResponseSchema = v.strictObject({
  missions: v.array(MissionSchema),
});
export type MissionListResponse = v.InferOutput<
  typeof MissionListResponseSchema
>;
export const MissionDetailResponseSchema = v.strictObject({
  mission: MissionSchema,
  actions: v.array(ActionProposalSchema),
  approvals: v.array(ApprovalSchema),
  receipts: v.array(ExecutionReceiptSchema),
  events: v.array(AuditEventSchema),
  assessment: v.nullable(JevAssessmentSchema),
  decision: v.nullable(PolicyDecisionSchema),
  permissionReviews: v.optional(v.array(JawPermissionReviewSchema)),
  permissionGrants: v.optional(v.array(JawPermissionGrantSchema)),
});
export const RecordJawPermissionSchema = v.strictObject({
  grant: JawPermissionGrantSchema,
});
export const JawPermissionListResponseSchema = v.strictObject({
  grants: v.array(JawPermissionGrantSchema),
});
export type JawPermissionListResponse = v.InferOutput<
  typeof JawPermissionListResponseSchema
>;
export type MissionDetailResponse = v.InferOutput<
  typeof MissionDetailResponseSchema
>;
export const ApprovalRequestResponseSchema = v.strictObject({
  approval: ApprovalSchema,
  request: WorldProofRequestSchema,
});
export type ApprovalRequestResponse = v.InferOutput<
  typeof ApprovalRequestResponseSchema
>;
export const VerifyWorldRequestSchema = v.strictObject({
  requestId: IdSchema,
  proof: PayloadSchema,
});
export type VerifyWorldRequest = v.InferOutput<typeof VerifyWorldRequestSchema>;
export const ApiErrorSchema = v.strictObject({
  error: v.strictObject({
    code: v.string(),
    message: v.string(),
    requestId: v.optional(v.string()),
  }),
});
export type ApiError = v.InferOutput<typeof ApiErrorSchema>;

export const AuthorizeMissionRequestSchema = v.strictObject({
  approvedCapabilities: v.array(CapabilitySchema),
});
export type AuthorizeMissionRequest = v.InferOutput<
  typeof AuthorizeMissionRequestSchema
>;

export const CreateWorkflowRequestSchema = v.strictObject({
  goal: v.pipe(v.string(), v.minLength(1), v.maxLength(10000)),
});
export type CreateWorkflowRequest = v.InferOutput<typeof CreateWorkflowRequestSchema>;
export const UpdateWorkflowDraftRequestSchema = v.strictObject({
  name: v.optional(v.pipe(v.string(), v.minLength(1), v.maxLength(256))),
  goal: v.optional(v.pipe(v.string(), v.minLength(1), v.maxLength(10000))),
  browserFallbackAllowed: v.optional(v.boolean()),
  trigger: v.optional(WorkflowTriggerSchema),
});
export type UpdateWorkflowDraftRequest = v.InferOutput<typeof UpdateWorkflowDraftRequestSchema>;
/** Edited request text only; it is re-classified and re-assembled, never executed directly. */
export const RefineWorkflowRequestSchema = v.strictObject({
  goal: v.pipe(v.string(), v.trim(), v.minLength(1), v.maxLength(10000)),
});
export type RefineWorkflowRequest = v.InferOutput<typeof RefineWorkflowRequestSchema>;
export const AssembleWorkflowRequestSchema = v.strictObject({});
export type AssembleWorkflowRequest = v.InferOutput<typeof AssembleWorkflowRequestSchema>;
export const ActivateWorkflowRequestSchema = v.strictObject({
  versionId: IdSchema,
  expectedGraphHash: HexSchema,
});
export type ActivateWorkflowRequest = v.InferOutput<typeof ActivateWorkflowRequestSchema>;
export const RunWorkflowRequestSchema = v.strictObject({ input: BoundedPayloadSchema });
export type RunWorkflowRequest = v.InferOutput<typeof RunWorkflowRequestSchema>;
export const CancelWorkflowRunRequestSchema = v.strictObject({});
export const ResumeWorkflowRunRequestSchema = v.strictObject({});
export const CreateWorkflowScheduleRequestSchema = v.strictObject({
  versionId: IdSchema,
  definition: WorkflowScheduleSchema.entries.definition,
});
export type CreateWorkflowScheduleRequest = v.InferOutput<typeof CreateWorkflowScheduleRequestSchema>;
export const UpdateWorkflowScheduleRequestSchema = v.strictObject({
  definition: v.optional(WorkflowScheduleSchema.entries.definition),
  status: v.optional(v.picklist(["ACTIVE", "PAUSED", "CANCELLED"])),
});
export type UpdateWorkflowScheduleRequest = v.InferOutput<typeof UpdateWorkflowScheduleRequestSchema>;
export const PrepareWorkflowConfirmationRequestSchema = v.strictObject({ stepRunId: IdSchema });
export type PrepareWorkflowConfirmationRequest = v.InferOutput<typeof PrepareWorkflowConfirmationRequestSchema>;
export const ConfirmWorkflowStepRequestSchema = v.strictObject({
  confirmationId: IdSchema,
  expectedPayloadHash: HexSchema,
});
export type ConfirmWorkflowStepRequest = v.InferOutput<typeof ConfirmWorkflowStepRequestSchema>;

export const WorkflowListResponseSchema = v.strictObject({ workflows: v.array(WorkflowSchema) });
export type WorkflowListResponse = v.InferOutput<typeof WorkflowListResponseSchema>;
export const WorkflowUsageSummarySchema = v.object({
  pricingDate: v.string(), complete: v.boolean(), attempts: v.number(), retries: v.number(), unknownAttempts: v.number(),
  knownModelCostUsd: v.nullable(v.number()),
  models: v.array(v.object({ model: v.string(), inputTokens: v.nullable(v.number()), outputTokens: v.nullable(v.number()), attempts: v.number(), unknownAttempts: v.number() })),
  comparisons: v.array(v.object({ model: v.string(), costUsd: v.nullable(v.number()), source: v.string() })),
});
export type WorkflowUsageSummary = v.InferOutput<typeof WorkflowUsageSummarySchema>;
export const WorkflowDetailResponseSchema = v.strictObject({
  workflow: WorkflowSchema,
  versions: v.array(WorkflowVersionSchema),
  schedules: v.array(WorkflowScheduleSchema),
  usage: v.optional(WorkflowUsageSummarySchema),
});
export type WorkflowDetailResponse = v.InferOutput<typeof WorkflowDetailResponseSchema>;
export const WorkflowRunListResponseSchema = v.strictObject({ runs: v.array(WorkflowRunSchema) });
export type WorkflowRunListResponse = v.InferOutput<typeof WorkflowRunListResponseSchema>;
export const WorkflowRunDetailResponseSchema = v.strictObject({
  run: WorkflowRunSchema,
  steps: v.array(StepRunSchema),
  attempts: v.array(StepAttemptSchema),
  events: v.array(WorkflowEventSchema),
  confirmations: v.array(RunConfirmationSchema),
  receipts: v.array(WorkflowReceiptSchema),
  usage: v.optional(WorkflowUsageSummarySchema),
});
export type WorkflowRunDetailResponse = v.InferOutput<typeof WorkflowRunDetailResponseSchema>;
export const WorkflowScheduleListResponseSchema = v.strictObject({
  schedules: v.array(WorkflowScheduleSchema),
});
export type WorkflowScheduleListResponse = v.InferOutput<typeof WorkflowScheduleListResponseSchema>;
/** Account-scoped capability status. `connected` means the server can act for this
 * account through a real adapter; it is not evidence that any provider call succeeded. */
export const WorkflowConnectionStatusSchema = v.picklist(["connected", "setup_required", "not_connected", "disabled"]);
export type WorkflowConnectionStatus = v.InferOutput<typeof WorkflowConnectionStatusSchema>;
export const WorkflowConnectionSchema = v.strictObject({
  id: v.pipe(v.string(), v.regex(/^[a-z][a-z0-9._-]{0,63}$/)),
  label: v.pipe(v.string(), v.minLength(1), v.maxLength(128)),
  kind: v.picklist(["model", "connector", "browser"]),
  capabilities: v.pipe(v.array(CapabilitySchema), v.maxLength(16)),
  status: WorkflowConnectionStatusSchema,
  detail: v.pipe(v.string(), v.minLength(1), v.maxLength(1000)),
  setup: v.nullable(v.pipe(v.string(), v.minLength(1), v.maxLength(1000))),
  /** Public identity the user must recognize (e.g. email sender); never a credential. */
  publicIdentity: v.nullable(v.pipe(v.string(), v.minLength(1), v.maxLength(256))),
});
export type WorkflowConnection = v.InferOutput<typeof WorkflowConnectionSchema>;
export const WorkflowConnectionsResponseSchema = v.strictObject({
  accountId: IdSchema,
  connections: v.pipe(v.array(WorkflowConnectionSchema), v.maxLength(32)),
});
export type WorkflowConnectionsResponse = v.InferOutput<typeof WorkflowConnectionsResponseSchema>;
export const WorkflowConfirmationResponseSchema = v.strictObject({ confirmation: RunConfirmationSchema });
export type WorkflowConfirmationResponse = v.InferOutput<typeof WorkflowConfirmationResponseSchema>;
