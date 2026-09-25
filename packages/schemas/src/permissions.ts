import * as v from "valibot";
import {
  HexSchema,
  JawCallSchema,
  JawSpendSchema,
  JawPermissionReviewSchema,
  Uint48Schema,
  normalizeWalletAddress,
  type JawPermissionGrant,
  type JawPermissionReview,
} from "./domain.js";
import { canonicalize, hashCanonical } from "./canonicalize.js";

export function jawGrantConstraints(grant: JawPermissionGrant) {
  return {
    missionId: grant.missionId,
    accountId: grant.accountId,
    account: grant.account,
    chainId: grant.chainId,
    spender: grant.spender,
    start: grant.start,
    end: grant.end,
    expiresAt: grant.expiresAt,
    calls: grant.calls,
    spends: grant.spends,
    permissionId: grant.permissionId,
    salt: grant.salt,
    reviewId: grant.reviewId,
  };
}
export function jawGrantHash(grant: JawPermissionGrant): string {
  return hashCanonical(jawGrantConstraints(grant));
}
export function matchesJawReview(
  grant: JawPermissionGrant,
  review: JawPermissionReview,
): boolean {
  return (
    grant.reviewId === review.id &&
    grant.missionId === review.missionId &&
    grant.accountId === review.accountId &&
    grant.account === review.account &&
    grant.chainId === review.chainId &&
    grant.spender === review.spender &&
    grant.start >= review.start &&
    grant.start <= review.start + 300 &&
    grant.end === review.end &&
    grant.expiresAt === review.expiresAt &&
    canonicalize(grant.calls) === canonicalize(review.calls) &&
    canonicalize(grant.spends) === canonicalize(review.spends)
  );
}
/** Only an independently verified server source may produce this evidence.
 * Relay/browser permission listings alone are not active-state evidence. */
export interface JawPermissionEvidence {
  permissionId: string;
  constraintsHash: string;
  state: "ACTIVE" | "REVOKED" | "UNKNOWN";
  checkedAt: string;
  /** Cumulative spend in each current contract period, from the same observation. */
  spent: Record<string, string>;
}
export interface JawPermissionVerifier {
  verify(grant: JawPermissionGrant): Promise<JawPermissionEvidence>;
}
export function validJawEvidence(
  grant: JawPermissionGrant,
  evidence: JawPermissionEvidence | null,
  now: number,
): boolean {
  if (!evidence) return false;
  const age = now - Date.parse(evidence.checkedAt);
  return (
    evidence.permissionId === grant.permissionId &&
    evidence.constraintsHash === jawGrantHash(grant) &&
    Number.isFinite(age) &&
    age >= 0 &&
    age <= 5000
  );
}
const sdkAddress = v.pipe(
  v.string(),
  v.regex(/^0x[0-9a-fA-F]{40}$/),
  v.transform(normalizeWalletAddress),
);
const sdkPermission = v.strictObject({
  account: sdkAddress,
  spender: sdkAddress,
  chainId: v.literal("0xaa36a7"),
  start: Uint48Schema,
  end: Uint48Schema,
  salt: v.pipe(
    v.string(),
    v.regex(/^0x[0-9a-fA-F]{1,64}$/),
    v.transform((value) => `0x${BigInt(value).toString(16)}`),
  ),
  permissionId: HexSchema,
  calls: v.array(
    v.strictObject({
      target: sdkAddress,
      selector: v.string(),
      checker: v.optional(
        v.pipe(
          sdkAddress,
          v.check(
            (value) => value === "0x0000000000000000000000000000000000000000",
          ),
        ),
      ),
    }),
  ),
  spends: v.array(
    v.strictObject({
      token: sdkAddress,
      allowance: v.pipe(
        v.string(),
        v.maxLength(49),
        v.regex(/^(0x[0-9a-fA-F]+|0|[1-9][0-9]*)$/),
        v.check((value) => BigInt(value) < 2n ** 160n),
        v.transform((value) => BigInt(value).toString(10)),
      ),
      unit: v.picklist([
        "minute",
        "hour",
        "day",
        "week",
        "month",
        "year",
        "forever",
      ]),
      multiplier: v.optional(
        v.pipe(v.number(), v.integer(), v.minValue(1), v.maxValue(65535)),
        1,
      ),
    }),
  ),
});
export function parseJawSdkPermission(input: unknown) {
  const parsed = v.parse(sdkPermission, input);
  const calls = parsed.calls.map(({ target, selector }) =>
    v.parse(JawCallSchema, { target, selector: selector.toLowerCase() }),
  );
  const spends = parsed.spends.map((spend) =>
    v.parse(JawSpendSchema, {
      ...spend,
      unit: spend.unit === "year" ? "month" : spend.unit,
      multiplier: spend.multiplier * (spend.unit === "year" ? 12 : 1),
    }),
  );
  if (
    new Set(calls.map((call) => `${call.target}:${call.selector}`)).size !==
      calls.length ||
    new Set(spends.map((spend) => spend.token)).size !== spends.length ||
    !calls.length ||
    calls.length > 32 ||
    spends.length > 32 ||
    parsed.start >= parsed.end
  )
    throw new Error("INVALID_PERMISSION");
  return { ...parsed, chainId: 11155111 as const, calls, spends };
}
export function parseJawReview(input: unknown): JawPermissionReview {
  return v.parse(JawPermissionReviewSchema, input);
}
