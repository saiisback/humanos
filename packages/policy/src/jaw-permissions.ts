import * as v from "valibot";
import {
  JawPermissionGrantSchema,
  JawPermissionReviewSchema,
  Uint160DecimalSchema,
  WalletAddressSchema,
  matchesJawReview,
  validJawEvidence,
  type JawPermissionGrant,
  type JawPermissionReview,
  type JawPermissionEvidence,
} from "@humanos/schemas";
const native = "0xeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee";
export const OnchainEffectSchema = v.strictObject({
  permissionId: v.string(),
  accountId: v.string(),
  account: WalletAddressSchema,
  chainId: v.literal(11155111),
  spender: WalletAddressSchema,
  target: WalletAddressSchema,
  selector: v.pipe(v.string(), v.regex(/^0x[0-9a-f]{8}$/)),
  value: Uint160DecimalSchema,
  tokenSpend: v.optional(
    v.strictObject({
      token: WalletAddressSchema,
      amount: Uint160DecimalSchema,
    }),
  ),
});
export interface OnchainAuthority {
  accountId: string;
  account: string;
  grant: JawPermissionGrant | null;
  review: JawPermissionReview | null;
  evidence: JawPermissionEvidence | null;
}
/** Pure authorization seam, never an execution/consumption API. A future chain
 * executor must atomically reserve contract-period spend before any effect. */
export function authorizeOnchain(
  input: OnchainAuthority & { missionId: string; effect: unknown; now: Date },
): string | null {
  try {
    const { grant, review, evidence } = input;
    const effect = v.parse(OnchainEffectSchema, input.effect);
    if (
      !grant ||
      !review ||
      !v.safeParse(JawPermissionGrantSchema, grant).success ||
      !v.safeParse(JawPermissionReviewSchema, review).success ||
      grant.status !== "ACTIVE" ||
      !matchesJawReview(grant, review) ||
      !validJawEvidence(grant, evidence, input.now.getTime()) ||
      evidence?.state !== "ACTIVE"
    )
      return "JAW_PERMISSION_UNVERIFIED";
    const now = input.now.getTime();
    if (now < grant.start * 1000 || now >= grant.end * 1000)
      return "JAW_PERMISSION_EXPIRED";
    if (
      grant.missionId !== input.missionId ||
      grant.accountId !== input.accountId ||
      grant.account !== input.account ||
      effect.permissionId !== grant.permissionId ||
      effect.accountId !== input.accountId ||
      effect.account !== input.account ||
      effect.chainId !== grant.chainId ||
      effect.spender !== grant.spender ||
      !grant.calls.some(
        (call) =>
          call.target === effect.target && call.selector === effect.selector,
      )
    )
      return "JAW_PERMISSION_MISMATCH";
    const costs = [
      { token: native, amount: effect.value },
      ...(effect.tokenSpend ? [effect.tokenSpend] : []),
    ];
    if (effect.tokenSpend?.token === native) return "JAW_INVALID_SPEND";
    for (const cost of costs) {
      if (BigInt(cost.amount) === 0n) continue;
      const spend = grant.spends.find((spend) => spend.token === cost.token);
      const used = evidence.spent[cost.token];
      if (
        !spend ||
        !v.safeParse(Uint160DecimalSchema, used).success ||
        BigInt(used!) + BigInt(cost.amount) > BigInt(spend.allowance)
      )
        return "JAW_ALLOWANCE_EXCEEDED";
    }
    return null;
  } catch {
    return "JAW_INVALID_PERMISSION";
  }
}
