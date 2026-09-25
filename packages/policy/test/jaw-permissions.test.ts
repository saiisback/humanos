import { expect, it } from "vitest";
import {
  jawGrantHash,
  type JawPermissionGrant,
  type JawPermissionReview,
} from "@humanos/schemas";
import { authorizeOnchain } from "../src/index.js";
const account = "0x1111111111111111111111111111111111111111";
const time = new Date("2026-09-25T01:00:00Z");
const review: JawPermissionReview = {
  id: "review",
  missionId: "mission",
  accountId: `11155111:${account}`,
  account,
  chainId: 11155111,
  spender: "0x2222222222222222222222222222222222222222",
  calls: [{ target: account, selector: "0xa9059cbb" }],
  spends: [{ token: account, allowance: "100", unit: "day", multiplier: 1 }],
  start: 1790294400,
  end: 1790380800,
  expiresAt: "2026-09-26T00:00:00.000Z",
  createdAt: "2026-09-25T00:00:00.000Z",
};
const id = `0x${"a".repeat(64)}`;
const grant: JawPermissionGrant = {
  ...review,
  id,
  reviewId: review.id,
  permissionId: id,
  salt: "0x1",
  status: "ACTIVE",
  revokedAt: null,
};
const effect = {
  permissionId: id,
  accountId: review.accountId,
  account,
  chainId: 11155111,
  spender: review.spender,
  target: account,
  selector: "0xa9059cbb",
  value: "0",
  tokenSpend: { token: account, amount: "10" },
};
const input = () => ({
  missionId: review.missionId,
  accountId: review.accountId,
  account,
  now: time,
  review,
  grant,
  effect,
  evidence: {
    permissionId: id,
    constraintsHash: jawGrantHash(grant),
    state: "ACTIVE" as const,
    checkedAt: time.toISOString(),
    spent: { [account]: "90" },
  },
});
it("intersects exact pairs and current cumulative allowance with independently verified active grants", () => {
  expect(authorizeOnchain(input())).toBeNull();
  const x = input();
  x.evidence.spent[account] = "91";
  expect(authorizeOnchain(x)).toBe("JAW_ALLOWANCE_EXCEEDED");
});
it("denies absent, unverified, forged, revoked, expired or mismatched authority", () => {
  for (const change of [
    { grant: null },
    { evidence: null },
    { grant: { ...grant, status: "UNVERIFIED" } },
    { grant: { ...grant, status: "REVOKED", revokedAt: time.toISOString() } },
    { grant: { ...grant, status: "RECONCILIATION_REQUIRED" } },
    { now: new Date(review.expiresAt) },
    { missionId: "other" },
    { accountId: "other" },
    { effect: { ...effect, selector: "0x12345678" } },
    { effect: { ...effect, value: "1" } },
    { evidence: { ...input().evidence, constraintsHash: "forged" } },
  ])
    expect(
      authorizeOnchain({ ...input(), ...change } as Parameters<
        typeof authorizeOnchain
      >[0]),
    ).not.toBeNull();
});
