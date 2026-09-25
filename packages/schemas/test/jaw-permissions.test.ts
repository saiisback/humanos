import { expect, it } from "vitest";
import * as v from "valibot";
import {
  JawPermissionReviewSchema,
  JawPermissionGrantSchema,
} from "../src/index.js";

const account = "0x1111111111111111111111111111111111111111";
export const review = {
  id: "review-1",
  missionId: "mission-1",
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
it("accepts bounded exact call pairs and rejects widening or malformed limits", () => {
  expect(v.parse(JawPermissionReviewSchema, review)).toEqual(review);
  for (const change of [
    { calls: [...review.calls, ...review.calls] },
    { calls: [{ target: account, selector: "0x32323232" }] },
    {
      calls: [
        {
          target: "0x3232323232323232323232323232323232323232",
          selector: "0xa9059cbb",
        },
      ],
    },
    { calls: [{ ...review.calls[0], checker: account }] },
    { spends: [...review.spends, ...review.spends] },
    ...["-1", "0x64", "01", (2n ** 160n).toString()].map((allowance) => ({
      spends: [{ ...review.spends[0], allowance }],
    })),
    { spends: [{ ...review.spends[0], multiplier: 65536 }] },
    { start: 2 ** 48 },
    { chainId: 1 },
    { prefundSpender: true },
  ])
    expect(
      v.safeParse(JawPermissionReviewSchema, { ...review, ...change }).success,
    ).toBe(false);
});
it("binds grant identity, exact expiry, status and revocation timestamp", () => {
  const grant = {
    ...review,
    id: `0x${"a".repeat(64)}`,
    reviewId: review.id,
    permissionId: `0x${"a".repeat(64)}`,
    salt: "0x01",
    status: "UNVERIFIED",
    revokedAt: null,
  };
  expect(v.safeParse(JawPermissionGrantSchema, grant).success).toBe(true);
  for (const change of [
    { permissionId: "unknown" },
    { expiresAt: review.createdAt },
    { accountId: "another" },
    { salt: `0x1${"0".repeat(64)}` },
    { status: "REVOKED" },
  ])
    expect(
      v.safeParse(JawPermissionGrantSchema, { ...grant, ...change }).success,
    ).toBe(false);
});
