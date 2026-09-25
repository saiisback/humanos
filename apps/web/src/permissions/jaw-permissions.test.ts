import { expect, it, vi } from "vitest";
import type { JawPermissionReview } from "@humanos/schemas";
import { createJawPermissionClient } from "./jaw-permissions";
const account = "0xabcdefabcdefabcdefabcdefabcdefabcdefabcd";
const now = Math.floor(Date.now() / 1000);
const review: JawPermissionReview = {
  id: "r1",
  missionId: "m1",
  accountId: `11155111:${account}`,
  account,
  chainId: 11155111,
  spender: "0x2222222222222222222222222222222222222222",
  calls: [{ target: account, selector: "0xa9059cbb" }],
  spends: [{ token: account, allowance: "100", unit: "month", multiplier: 12 }],
  start: now,
  end: now + 3600,
  expiresAt: new Date((now + 3600) * 1000).toISOString(),
  createdAt: new Date(now * 1000).toISOString(),
};
const wire = {
  account: "0x" + account.slice(2).toUpperCase(),
  spender: review.spender,
  chainId: "0xaa36a7",
  start: now,
  end: review.end,
  salt: "0x01",
  permissionId: `0x${"a".repeat(64)}`,
  calls: review.calls,
  spends: [{ token: account, allowance: "0x64", unit: "year", multiplier: 1 }],
};
const backend = () => ({
  record: vi.fn(async (grant: unknown) => grant),
  revoke: vi.fn(async () => ({ status: "REVOKED" })),
});
it("sends exact SDK 1.5.1 grant payload and normalizes hex allowance and year before recording", async () => {
  const provider = { request: vi.fn(async () => wire) };
  const server = backend();
  const client = createJawPermissionClient(provider, server, account);
  expect((await client.grant(review)).status).toBe("RECORDED");
  expect(provider.request).toHaveBeenCalledWith({
    method: "wallet_grantPermissions",
    params: [
      {
        address: account,
        chainId: "0xaa36a7",
        expiry: review.end,
        spender: review.spender,
        permissions: { calls: review.calls, spends: review.spends },
      },
    ],
  });
  expect(server.record).toHaveBeenCalledWith(
    expect.objectContaining({
      account,
      spends: review.spends,
      salt: "0x1",
      status: "UNVERIFIED",
    }),
  );
});
it("rejects changed context, widened pairs, malformed values, checker and prefunding without backend writes", async () => {
  for (const change of [
    { account: review.spender },
    { chainId: "0x1" },
    { spender: account },
    { end: review.end + 1 },
    { start: now - 1 },
    {
      calls: [
        ...wire.calls,
        { target: review.spender, selector: "0xa9059cbb" },
      ],
    },
    { calls: [{ ...wire.calls[0], checker: account }] },
    { spends: [{ ...wire.spends[0], allowance: "0x1" + "0".repeat(40) }] },
    { capabilities: { prefundSpender: true } },
  ]) {
    const server = backend();
    const client = createJawPermissionClient(
      { request: async () => ({ ...wire, ...change }) },
      server,
      account,
    );
    expect((await client.grant(review)).status).toBe("RECONCILIATION_REQUIRED");
    expect(server.record).not.toHaveBeenCalled();
  }
});
it("treats thrown and embedded 4001 as cancellation and records nothing", async () => {
  for (const request of [
    async () => {
      throw { code: 4001 };
    },
    async () => ({ error: { code: "4001" } }),
  ]) {
    const server = backend();
    expect(
      await createJawPermissionClient({ request }, server, account).grant(
        review,
      ),
    ).toEqual({ status: "CANCELLED" });
    expect(server.record).not.toHaveBeenCalled();
  }
});
it("lists using account and chain and revokes only after explicit SDK success", async () => {
  const provider = { request: vi.fn(async () => [wire] as unknown) };
  const server = backend();
  const client = createJawPermissionClient(provider, server, account);
  expect(await client.list()).toHaveLength(1);
  expect(provider.request).toHaveBeenLastCalledWith({
    method: "wallet_getPermissions",
    params: [{ address: account, chainId: "0xaa36a7" }],
  });
  provider.request.mockResolvedValue({ success: false });
  expect((await client.revoke(wire.permissionId)).status).toBe(
    "RECONCILIATION_REQUIRED",
  );
  expect(server.revoke).not.toHaveBeenCalled();
  provider.request.mockResolvedValue({ success: true });
  expect((await client.revoke(wire.permissionId)).status).toBe("RECORDED");
  expect(provider.request).toHaveBeenLastCalledWith({
    method: "wallet_revokePermissions",
    params: [{ address: account, id: wire.permissionId }],
  });
  expect(server.revoke).toHaveBeenCalledWith(wire.permissionId);
});
it("surfaces reconciliation after the wallet succeeds but backend tracking fails", async () => {
  const server = backend();
  server.record.mockRejectedValue(new Error("offline"));
  server.revoke.mockRejectedValue(new Error("offline"));
  const provider = { request: vi.fn(async () => wire as unknown) };
  const client = createJawPermissionClient(provider, server, account);
  expect((await client.grant(review)).status).toBe("RECONCILIATION_REQUIRED");
  provider.request.mockResolvedValue({ success: true });
  expect((await client.revoke(wire.permissionId)).status).toBe(
    "RECONCILIATION_REQUIRED",
  );
});
it("never labels a backend failure as wallet cancellation after a completed grant", async () => {
  const server = backend();
  server.record.mockRejectedValue({ code: 4001 });
  expect(
    (
      await createJawPermissionClient(
        { request: async () => wire },
        server,
        account,
      ).grant(review)
    ).status,
  ).toBe("RECONCILIATION_REQUIRED");
});
