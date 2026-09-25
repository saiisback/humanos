import { afterAll, beforeAll, expect, it } from "vitest";
import * as v from "valibot";
import {
  AuthSessionResponseSchema,
  CreateSiweChallengeResponseSchema,
  JawPermissionGrantSchema,
  VerifySiweRequestSchema,
  WalletAccountSchema,
  hashCanonical,
  type WalletAccount,
} from "@humanos/schemas";
import { Database } from "../src/index.js";

const stamp = "2026-09-25T00:00:00.000Z";
const future = "2026-09-26T00:00:00.000Z";
const account: WalletAccount = {
  id: "11155111:0x1111111111111111111111111111111111111111",
  address: "0x1111111111111111111111111111111111111111",
  chainId: 11155111,
  createdAt: stamp,
};
const anotherAccount: WalletAccount = {
  id: "11155111:0x2222222222222222222222222222222222222222",
  address: "0x2222222222222222222222222222222222222222",
  chainId: 11155111,
  createdAt: stamp,
};
const concurrentAccount: WalletAccount = {
  id: "11155111:0x3333333333333333333333333333333333333333",
  address: "0x3333333333333333333333333333333333333333",
  chainId: 11155111,
  createdAt: stamp,
};
const schema = "test_auth_" + Date.now();
const db = new Database(
  process.env.TEST_DATABASE_URL ??
    "postgresql://saikarthik@127.0.0.1:55432/humanos",
  { schema },
);

beforeAll(async () => {
  await db.migrate();
  await db.migrate();
  for (const id of ["root-1", "root-2", "root-3", "root-4"]) {
    await db.insert("roots", {
      id,
      ensName: null,
      createdAt: stamp,
      verificationEnvironment: "staging",
    });
  }
  await db.insert("accounts", account);
  await db.insert("accounts", anotherAccount);
  await db.insert("accounts", concurrentAccount);
});

afterAll(async () => {
  await db.query(`DROP SCHEMA "${schema}" CASCADE`);
  await db.close();
});

it("accepts the authenticated account and session contracts", async () => {
  expect(v.parse(WalletAccountSchema, account)).toEqual(account);
  await db.insert("sessions", {
    id: hashCanonical("token"),
    accountId: account.id,
    rootId: null,
    expiresAt: future,
  });
  expect(await db.get("sessions", hashCanonical("token"))).toMatchObject({
    accountId: account.id,
    rootId: null,
  });
  expect(
    v.parse(AuthSessionResponseSchema, {
      account,
      root: null,
      jawConfigured: false,
    }),
  ).toMatchObject({ account, root: null, jawConfigured: false });
  expect(
    v.parse(CreateSiweChallengeResponseSchema, {
      challengeId: "challenge-1",
      nonce: "nonce-1",
      expiresAt: future,
      chainId: 11155111,
      domain: "humanos.example",
      uri: "https://humanos.example",
    }),
  ).toMatchObject({ challengeId: "challenge-1", chainId: 11155111 });
  expect(
    v.parse(VerifySiweRequestSchema, {
      challengeId: "challenge-1",
      message: "signed SIWE message",
      signature: "0x1234",
    }),
  ).toMatchObject({ challengeId: "challenge-1" });
});

it("rejects malformed wallet addresses and chain identifiers", () => {
  for (const malformed of [
    { ...account, address: "0x1234" },
    { ...account, address: account.address.toUpperCase() },
    { ...account, chainId: 0 },
    { ...account, chainId: 1.5 },
    { ...account, chainId: "11155111" },
    { ...account, id: anotherAccount.id },
    { ...account, extra: true },
  ]) {
    expect(v.safeParse(WalletAccountSchema, malformed).success).toBe(false);
  }
});

it("validates strict JAW permission grants", async () => {
  const grant = {
    id: `0x${"a".repeat(64)}`,
    missionId: "mission-1",
    reviewId: "review-1",
    accountId: account.id,
    account: account.address,
    chainId: 11155111,
    permissionId: `0x${"a".repeat(64)}`,
    status: "UNVERIFIED",
    spender: anotherAccount.address,
    calls: [{ target: account.address, selector: "0xa9059cbb" }],
    spends: [
      { token: account.address, allowance: "100", unit: "day", multiplier: 1 },
    ],
    start: Date.parse(stamp) / 1000,
    end: Date.parse(future) / 1000,
    salt: "0x1",
    expiresAt: future,
    createdAt: stamp,
    revokedAt: null,
  };
  expect(v.parse(JawPermissionGrantSchema, grant)).toEqual(grant);
  await db.insert("jaw_permissions", grant);
  expect(await db.get("jaw_permissions", grant.id)).toEqual(grant);
  expect(
    v.safeParse(JawPermissionGrantSchema, {
      ...grant,
      calls: [{ target: "0xBAD", selector: "0xa9059cbb" }],
    }).success,
  ).toBe(false);
});

it("retries an exact binding and rejects both conflicting directions", async () => {
  const first = await db.transaction((tx) =>
    tx.bindRootAccount("root-1", account.id, new Date(stamp)),
  );
  const retry = await db.transaction((tx) =>
    tx.bindRootAccount("root-1", account.id, new Date(future)),
  );
  expect(retry).toEqual(first);
  expect(first).toMatchObject({
    rootId: "root-1",
    accountId: account.id,
    createdAt: stamp,
  });
  await expect(
    db.transaction((tx) =>
      tx.bindRootAccount("root-1", anotherAccount.id, new Date(stamp)),
    ),
  ).rejects.toThrow("ROOT_ACCOUNT_CONFLICT");
  await expect(
    db.transaction((tx) =>
      tx.bindRootAccount("root-2", account.id, new Date(stamp)),
    ),
  ).rejects.toThrow("ROOT_ACCOUNT_CONFLICT");
});

it("allows only one incompatible concurrent binding to commit", async () => {
  const outcomes = await Promise.allSettled([
    db.transaction((tx) =>
      tx.bindRootAccount("root-3", concurrentAccount.id, new Date(stamp)),
    ),
    db.transaction((tx) =>
      tx.bindRootAccount("root-4", concurrentAccount.id, new Date(stamp)),
    ),
  ]);
  expect(
    outcomes.filter((outcome) => outcome.status === "fulfilled"),
  ).toHaveLength(1);
  expect(
    outcomes.filter((outcome) => outcome.status === "rejected"),
  ).toHaveLength(1);
  expect(
    outcomes.find((outcome) => outcome.status === "rejected"),
  ).toMatchObject({
    reason: expect.objectContaining({ message: "ROOT_ACCOUNT_CONFLICT" }),
  });
});
