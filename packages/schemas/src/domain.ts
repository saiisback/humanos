import * as v from "valibot";
export const IdSchema = v.pipe(v.string(), v.minLength(1), v.maxLength(256));
export const HexSchema = v.pipe(v.string(), v.regex(/^0x[0-9a-f]{64}$/));
export type Hex = `0x${string}`;
export const TimestampSchema = v.pipe(v.string(), v.isoTimestamp());
export function normalizeWalletAddress(address: string): string {
  if (!/^0x[0-9a-fA-F]{40}$/.test(address))
    throw new Error("INVALID_WALLET_ADDRESS");
  return address.toLowerCase();
}
export const WalletAddressSchema = v.pipe(
  v.string(),
  v.regex(/^0x[0-9a-fA-F]{40}$/),
  v.check((address) => {
    try {
      return address === normalizeWalletAddress(address);
    } catch {
      return false;
    }
  }),
);
export const ChainIdSchema = v.pipe(v.number(), v.integer(), v.minValue(1));
export const CapabilitySchema = v.picklist([
  "documents.read",
  "documents.disclose",
  "drafts.write",
  "web.search",
  "checklist.write",
  "calendar.create",
  "email.send",
  "form.save",
  "data.upload",
  "application.submit",
  "value.transfer",
  "message.sign",
  "account.recover",
  "permissions.change",
]);
export type Capability = v.InferOutput<typeof CapabilitySchema>;
export const RiskLevelSchema = v.picklist([
  "ROUTINE",
  "CONSEQUENTIAL",
  "SENSITIVE",
]);
export type RiskLevel = v.InferOutput<typeof RiskLevelSchema>;
export const MissionStateSchema = v.picklist([
  "DRAFT",
  "PROPOSED",
  "AUTHORIZED",
  "RUNNING",
  "AWAITING_APPROVAL",
  "EXECUTING",
  "COMPLETED",
  "REJECTED",
  "EXPIRED",
  "REVOKED",
  "FAILED",
]);
export type MissionState = v.InferOutput<typeof MissionStateSchema>;
export const ActionTypeSchema = v.picklist([
  "READ_DOCUMENT",
  "DISCLOSE_DOCUMENT",
  "WRITE_DRAFT",
  "SEARCH_WEB",
  "WRITE_CHECKLIST",
  "CREATE_CALENDAR_EVENT",
  "SEND_EMAIL",
  "SAVE_FORM",
  "UPLOAD_DATA",
  "SUBMIT_APPLICATION",
  "TRANSFER_VALUE",
  "SIGN_MESSAGE",
  "RECOVER_ACCOUNT",
  "CHANGE_PERMISSIONS",
]);
export type ActionType = v.InferOutput<typeof ActionTypeSchema>;
export type JsonValue =
  | null
  | boolean
  | number
  | string
  | JsonValue[]
  | { [key: string]: JsonValue };
export const JsonValueSchema: v.GenericSchema<JsonValue> = v.lazy(() =>
  v.union([
    v.null(),
    v.boolean(),
    v.pipe(v.number(), v.finite()),
    v.string(),
    v.array(JsonValueSchema),
    v.record(v.string(), JsonValueSchema),
  ]),
);
export const PayloadSchema = v.record(v.string(), JsonValueSchema);
export const RootIdentitySchema = v.strictObject({
  id: IdSchema,
  ensName: v.nullable(v.string()),
  createdAt: TimestampSchema,
  verificationEnvironment: v.picklist(["staging", "production"]),
});
export type RootIdentity = v.InferOutput<typeof RootIdentitySchema>;
export const WalletAccountSchema = v.pipe(
  v.strictObject({
    id: IdSchema,
    address: WalletAddressSchema,
    chainId: ChainIdSchema,
    createdAt: TimestampSchema,
  }),
  v.check(({ id, address, chainId }) => id === `${chainId}:${address}`),
);
export type WalletAccount = v.InferOutput<typeof WalletAccountSchema>;
export const RootAccountBindingSchema = v.strictObject({
  id: IdSchema,
  rootId: IdSchema,
  accountId: IdSchema,
  createdAt: TimestampSchema,
});
export type RootAccountBinding = v.InferOutput<typeof RootAccountBindingSchema>;
export const Uint160DecimalSchema = v.pipe(
  v.string(),
  v.maxLength(49),
  v.regex(/^(0|[1-9][0-9]*)$/),
  v.check((value) => BigInt(value) < 2n ** 160n),
);
export const Uint48Schema = v.pipe(
  v.number(),
  v.integer(),
  v.minValue(0),
  v.maxValue(2 ** 48 - 1),
);
const ExactAddressSchema = v.pipe(
  WalletAddressSchema,
  v.check(
    (value) =>
      value !== "0x0000000000000000000000000000000000000000" &&
      value !== "0x3232323232323232323232323232323232323232",
  ),
);
export const JawCallSchema = v.strictObject({
  target: ExactAddressSchema,
  selector: v.pipe(
    v.string(),
    v.regex(/^0x[0-9a-f]{8}$/),
    v.check((value) => value !== "0x32323232"),
  ),
});
export const JawSpendSchema = v.strictObject({
  token: ExactAddressSchema,
  allowance: Uint160DecimalSchema,
  unit: v.picklist(["minute", "hour", "day", "week", "month", "forever"]),
  multiplier: v.pipe(v.number(), v.integer(), v.minValue(1), v.maxValue(65535)),
});
const jawConstraintEntries = {
  missionId: IdSchema,
  accountId: IdSchema,
  account: ExactAddressSchema,
  chainId: v.literal(11155111),
  spender: ExactAddressSchema,
  calls: v.pipe(
    v.array(JawCallSchema),
    v.minLength(1),
    v.maxLength(32),
    v.check(
      (calls) =>
        new Set(calls.map((call) => `${call.target}:${call.selector}`)).size ===
        calls.length,
    ),
  ),
  spends: v.pipe(
    v.array(JawSpendSchema),
    v.maxLength(32),
    v.check(
      (spends) =>
        new Set(spends.map((spend) => spend.token)).size === spends.length,
    ),
  ),
  start: Uint48Schema,
  end: Uint48Schema,
  expiresAt: TimestampSchema,
  createdAt: TimestampSchema,
};
function validJawContext(value: {
  accountId: string;
  account: string;
  chainId: number;
  start: number;
  end: number;
  expiresAt: string;
}) {
  return (
    value.accountId === `${value.chainId}:${value.account}` &&
    value.start < value.end &&
    Date.parse(value.expiresAt) === value.end * 1000
  );
}
// The SDK selects start/salt itself. Review.start is the earliest permitted SDK start.
export const JawPermissionReviewSchema = v.pipe(
  v.strictObject({ id: IdSchema, ...jawConstraintEntries }),
  v.check((value) => validJawContext(value)),
);
export type JawPermissionReview = v.InferOutput<
  typeof JawPermissionReviewSchema
>;
export const JawPermissionGrantSchema = v.pipe(
  v.strictObject({
    ...jawConstraintEntries,
    id: HexSchema,
    reviewId: IdSchema,
    permissionId: HexSchema,
    salt: v.pipe(v.string(), v.regex(/^0x[0-9a-f]{1,64}$/)),
    status: v.picklist([
      "UNVERIFIED",
      "ACTIVE",
      "REVOKED",
      "EXPIRED",
      "RECONCILIATION_REQUIRED",
    ]),
    revokedAt: v.nullable(TimestampSchema),
  }),
  v.check((value) => validJawContext(value)),
  v.check(
    (value) =>
      value.id === value.permissionId &&
      (value.status === "REVOKED"
        ? value.revokedAt !== null
        : value.revokedAt === null),
  ),
);
export type JawPermissionGrant = v.InferOutput<typeof JawPermissionGrantSchema>;
export const MissionProposalSchema = v.strictObject({
  goal: v.pipe(v.string(), v.minLength(1), v.maxLength(10000)),
  title: v.pipe(v.string(), v.minLength(1), v.maxLength(200)),
  capabilities: v.array(CapabilitySchema),
  steps: v.array(v.string()),
  expiresAt: TimestampSchema,
});
export type MissionProposal = v.InferOutput<typeof MissionProposalSchema>;
export const MissionSchema = v.strictObject({
  ...MissionProposalSchema.entries,
  id: IdSchema,
  rootId: IdSchema,
  agentEns: v.nullable(v.string()),
  state: MissionStateSchema,
  approvedCapabilities: v.array(CapabilitySchema),
  createdAt: TimestampSchema,
  updatedAt: TimestampSchema,
  policyVersion: IdSchema,
});
export type Mission = v.InferOutput<typeof MissionSchema>;
export const ActionProposalDraftSchema = v.strictObject({
  type: ActionTypeSchema,
  capability: CapabilitySchema,
  payload: PayloadSchema,
  reason: v.pipe(v.string(), v.maxLength(4000)),
});
export type ActionProposalDraft = v.InferOutput<
  typeof ActionProposalDraftSchema
>;
export const ActionProposalSchema = v.strictObject({
  ...ActionProposalDraftSchema.entries,
  id: IdSchema,
  rootId: IdSchema,
  missionId: IdSchema,
  agentEns: v.string(),
  payloadHash: HexSchema,
  nonce: IdSchema,
  expiresAt: TimestampSchema,
  createdAt: TimestampSchema,
});
export type ActionProposal = v.InferOutput<typeof ActionProposalSchema>;
export const ApprovalBindingSchema = v.strictObject({
  rootId: IdSchema,
  agentEns: v.string(),
  missionId: IdSchema,
  actionType: ActionTypeSchema,
  payloadHash: HexSchema,
  nonce: IdSchema,
  expiresAt: TimestampSchema,
});
export type ApprovalBinding = v.InferOutput<typeof ApprovalBindingSchema>;
export const ApprovalSchema = v.strictObject({
  id: IdSchema,
  actionId: IdSchema,
  binding: ApprovalBindingSchema,
  bindingHash: HexSchema,
  kind: v.picklist(["CONSEQUENTIAL_CONFIRMATION", "WORLD_FRESH"]),
  status: v.picklist([
    "PENDING",
    "VERIFIED",
    "DENIED",
    "CANCELLED",
    "CONSUMED",
    "EXPIRED",
  ]),
  createdAt: TimestampSchema,
  verifiedAt: v.nullable(TimestampSchema),
  consumedAt: v.nullable(TimestampSchema),
  nullifierHash: v.nullable(HexSchema),
});
export type Approval = v.InferOutput<typeof ApprovalSchema>;
export const ExecutionReceiptSchema = v.strictObject({
  id: IdSchema,
  actionId: IdSchema,
  missionId: IdSchema,
  idempotencyKey: IdSchema,
  payloadHash: HexSchema,
  status: v.picklist(["SUCCEEDED", "FAILED", "RECONCILIATION_REQUIRED"]),
  externalId: v.nullable(v.string()),
  executedAt: TimestampSchema,
  metadata: PayloadSchema,
});
export type ExecutionReceipt = v.InferOutput<typeof ExecutionReceiptSchema>;
const ScoreSchema = v.pipe(v.number(), v.minValue(0), v.maxValue(1));
export const JevAssessmentSchema = v.strictObject({
  stateHash: HexSchema,
  questionVersion: IdSchema,
  modelVersion: IdSchema,
  evaluatedAt: TimestampSchema,
  risk: RiskLevelSchema,
  missionAligned: v.boolean(),
  injectionDetected: v.boolean(),
  requiresReview: v.boolean(),
  confidence: ScoreSchema,
  missionAlignmentScore: ScoreSchema,
  injectionScore: ScoreSchema,
  reason: v.pipe(v.string(), v.maxLength(4000)),
});
export type JevAssessment = v.InferOutput<typeof JevAssessmentSchema>;
export const AssessmentFlagsSchema = v.strictObject({
  block: v.boolean(),
  requireReview: v.boolean(),
  minimumRisk: RiskLevelSchema,
  reasons: v.array(v.string()),
});
export type AssessmentFlags = v.InferOutput<typeof AssessmentFlagsSchema>;
export const AgentAuthorizationSchema = v.strictObject({
  agentEns: v.string(),
  rootId: IdSchema,
  capabilities: v.array(CapabilitySchema),
  active: v.boolean(),
  revoked: v.boolean(),
  expiresAt: TimestampSchema,
  checkedAt: TimestampSchema,
  blockNumber: v.pipe(v.number(), v.integer(), v.minValue(0)),
  finalized: v.boolean(),
});
export type AgentAuthorization = v.InferOutput<typeof AgentAuthorizationSchema>;
export const PolicyDecisionSchema = v.strictObject({
  allowed: v.boolean(),
  risk: RiskLevelSchema,
  requiresApproval: v.boolean(),
  reasons: v.array(v.string()),
  effectiveCapabilities: v.array(CapabilitySchema),
  policyVersion: IdSchema,
});
export type PolicyDecision = v.InferOutput<typeof PolicyDecisionSchema>;
