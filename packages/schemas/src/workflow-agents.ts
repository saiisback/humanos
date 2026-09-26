import * as v from "valibot";
import { keccak_256 } from "@noble/hashes/sha3";
import { bytesToHex, utf8ToBytes } from "@noble/hashes/utils";
import {
  CapabilitySchema,
  HexSchema,
  IdSchema,
  TimestampSchema,
  WalletAddressSchema,
  type Capability,
  type Hex,
} from "./domain.js";

export const WORKFLOW_AGENT_CHAIN_ID = 11155111;
export const WORKFLOW_AGENT_REVIEW_TTL_MS = 5 * 60 * 1000;
export const WorkflowAgentStateSchema = v.picklist([
  "PENDING_REGISTRATION",
  "ACTIVE",
  "REVOKING",
  "REVOKED",
  "FAILED",
  "EXPIRED",
]);
export type WorkflowAgentState = v.InferOutput<typeof WorkflowAgentStateSchema>;
/** At most one binding per workflow may be in one of these states. */
export const LIVE_WORKFLOW_AGENT_STATES = [
  "PENDING_REGISTRATION",
  "ACTIVE",
  "REVOKING",
] as const satisfies readonly WorkflowAgentState[];

/** Spending, recovery and registry administration are never delegated to workflow agents. */
const UNDELEGABLE = new Set<Capability>([
  "value.transfer",
  "permissions.change",
  "account.recover",
]);
/** Canonical scope: nonempty, strictly sorted (so unique) and delegable. */
export const WorkflowAgentCapabilitiesSchema = v.pipe(
  v.array(CapabilitySchema),
  v.minLength(1),
  v.maxLength(32),
  v.check((caps) =>
    caps.every(
      (cap, i) => !UNDELEGABLE.has(cap) && (i === 0 || caps[i - 1]! < cap),
    ),
  ),
);
export const EnsNameSchema = v.pipe(
  v.string(),
  v.maxLength(255),
  v.regex(/^(?:[a-z0-9-]{1,63}\.)+[a-z0-9-]{1,63}$/),
);
/** Confirmed transaction references only; empty when verified chain state already matched. */
const TxHashesSchema = v.pipe(
  v.array(HexSchema),
  v.maxLength(16),
  v.check((hashes) => new Set(hashes).size === hashes.length),
);
const PositiveIntSchema = v.pipe(v.number(), v.integer(), v.minValue(1));
const NonnegativeIntSchema = v.pipe(v.number(), v.integer(), v.minValue(0));

export function workflowAgentDerivationId(
  workflowId: string,
  generation: number,
): string {
  return `workflow:${workflowId}:${generation}`;
}
/** ENS namehash for already-normalized lowercase ASCII names. */
export function ensNamehash(name: string): Hex {
  let node = new Uint8Array(32);
  for (const label of name.split(".").reverse()) {
    const next = new Uint8Array(64);
    next.set(node);
    next.set(keccak_256(utf8ToBytes(label)), 32);
    node = keccak_256(next);
  }
  return `0x${bytesToHex(node)}`;
}

const immutableEntries = {
  accountId: IdSchema,
  rootId: IdSchema,
  workflowId: IdSchema,
  versionId: IdSchema,
  graphHash: HexSchema,
  capabilities: WorkflowAgentCapabilitiesSchema,
  expiresAt: TimestampSchema,
};

export const WorkflowAgentBindingSchema = v.pipe(
  v.strictObject({
    id: IdSchema,
    ...immutableEntries,
    generation: PositiveIntSchema,
    derivationId: IdSchema,
    chainId: v.literal(WORKFLOW_AGENT_CHAIN_ID),
    ensName: v.nullable(EnsNameSchema),
    node: v.nullable(HexSchema),
    agentAddress: v.nullable(WalletAddressSchema),
    state: WorkflowAgentStateSchema,
    revision: NonnegativeIntSchema,
    registrationTxHashes: TxHashesSchema,
    revocationTxHashes: TxHashesSchema,
    createdAt: TimestampSchema,
    updatedAt: TimestampSchema,
  }),
  v.check(
    (b) =>
      b.derivationId === workflowAgentDerivationId(b.workflowId, b.generation),
  ),
  v.check(
    (b) =>
      Date.parse(b.expiresAt) > Date.parse(b.createdAt) &&
      Date.parse(b.updatedAt) >= Date.parse(b.createdAt),
  ),
  // Chain identity is all-or-nothing, matches the name and is mandatory once ACTIVE.
  v.check((b) => {
    const missing = [b.ensName, b.node, b.agentAddress].filter(
      (field) => field === null,
    ).length;
    return missing === 0
      ? b.node === ensNamehash(b.ensName!)
      : missing === 3 && b.state !== "ACTIVE";
  }),
  v.check(
    (b) =>
      b.ensName !== null ||
      (b.registrationTxHashes.length === 0 &&
        b.revocationTxHashes.length === 0),
  ),
  v.check(
    (b) =>
      !(b.state === "PENDING_REGISTRATION" || b.state === "ACTIVE") ||
      b.revocationTxHashes.length === 0,
  ),
);
export type WorkflowAgentBinding = v.InferOutput<
  typeof WorkflowAgentBindingSchema
>;

/** Store input: identity, generation and chain evidence are allocated or recorded by the store. */
export const WorkflowAgentReservationSchema = v.pipe(
  v.strictObject({
    ...immutableEntries,
    state: v.literal("PENDING_REGISTRATION"),
    createdAt: TimestampSchema,
    updatedAt: TimestampSchema,
  }),
  v.check(
    (r) =>
      r.updatedAt === r.createdAt &&
      Date.parse(r.expiresAt) > Date.parse(r.createdAt),
  ),
);
export type WorkflowAgentReservation = v.InferOutput<
  typeof WorkflowAgentReservationSchema
>;

export const WorkflowAgentReviewSchema = v.pipe(
  v.strictObject({
    id: IdSchema,
    ...immutableEntries,
    chainId: v.literal(WORKFLOW_AGENT_CHAIN_ID),
    network: v.literal("sepolia"),
    parentName: EnsNameSchema,
    reviewHash: HexSchema,
    createdAt: TimestampSchema,
    reviewExpiresAt: TimestampSchema,
  }),
  v.check((r) => {
    const created = Date.parse(r.createdAt);
    const until = Date.parse(r.reviewExpiresAt);
    return (
      until > created &&
      until - created <= WORKFLOW_AGENT_REVIEW_TTL_MS &&
      Date.parse(r.expiresAt) > created
    );
  }),
);
export type WorkflowAgentReview = v.InferOutput<
  typeof WorkflowAgentReviewSchema
>;

export const ReviewWorkflowAgentRequestSchema = v.strictObject({
  versionId: IdSchema,
});
export type ReviewWorkflowAgentRequest = v.InferOutput<
  typeof ReviewWorkflowAgentRequestSchema
>;
export const EnableWorkflowAgentRequestSchema = v.strictObject({
  reviewId: IdSchema,
  expectedReviewHash: HexSchema,
});
export type EnableWorkflowAgentRequest = v.InferOutput<
  typeof EnableWorkflowAgentRequestSchema
>;
export const RevokeWorkflowAgentRequestSchema = v.strictObject({});
export type RevokeWorkflowAgentRequest = v.InferOutput<
  typeof RevokeWorkflowAgentRequestSchema
>;
export const WorkflowAgentReviewResponseSchema = v.strictObject({
  review: WorkflowAgentReviewSchema,
});
export type WorkflowAgentReviewResponse = v.InferOutput<
  typeof WorkflowAgentReviewResponseSchema
>;
export const WorkflowAgentResponseSchema = v.strictObject({
  binding: v.nullable(WorkflowAgentBindingSchema),
});
export type WorkflowAgentResponse = v.InferOutput<
  typeof WorkflowAgentResponseSchema
>;
export const WorkflowAgentListResponseSchema = v.strictObject({
  bindings: v.pipe(v.array(WorkflowAgentBindingSchema), v.maxLength(1000)),
});
export type WorkflowAgentListResponse = v.InferOutput<
  typeof WorkflowAgentListResponseSchema
>;
