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
} from "./domain.js";
import { AuditEventSchema } from "./events.js";
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
