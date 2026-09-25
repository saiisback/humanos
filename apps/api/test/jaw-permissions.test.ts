import { afterAll, beforeAll, expect, it, vi } from "vitest";
import { randomUUID } from "node:crypto";
import { Database } from "@humanos/database";
import {
  hashCanonical,
  jawGrantHash,
  type JawPermissionVerifier,
  type JawPermissionReview,
  type JawPermissionGrant,
  type Mission,
} from "@humanos/schemas";
import { createApi } from "../src/app.js";

const db = new Database(
  process.env.TEST_DATABASE_URL ??
    "postgresql://saikarthik@127.0.0.1:55432/humanos",
  { schema: "jaw_" + randomUUID().replaceAll("-", "") },
);
const app = createApi({ db, origin: "http://localhost:5173" });
beforeAll(() => db.migrate());
afterAll(() => db.close());
async function setup(verifier?: JawPermissionVerifier) {
  const api = verifier
    ? createApi({
        db,
        origin: "http://localhost:5173",
        jawPermissionVerifier: verifier,
      })
    : app;
  const stamp = new Date().toISOString();
  const rootId = randomUUID();
  const token = randomUUID();
  const account = "0x" + randomUUID().replaceAll("-", "").padEnd(40, "1");
  const accountId = `11155111:${account}`;
  await db.insert("roots", {
    id: rootId,
    ensName: null,
    createdAt: stamp,
    verificationEnvironment: "staging",
  });
  await db.insert("accounts", {
    id: accountId,
    address: account,
    chainId: 11155111,
    createdAt: stamp,
  });
  await db.transaction((tx) =>
    tx.bindRootAccount(rootId, accountId, new Date()),
  );
  await db.insert("sessions", {
    id: hashCanonical(token),
    accountId,
    rootId,
    expiresAt: new Date(Date.now() + 600000).toISOString(),
  });
  const end = Math.floor(Date.now() / 1000) + 3600;
  const mission: Mission = {
    id: randomUUID(),
    rootId,
    title: "Reviewed chain task",
    goal: "Explicit onchain mandate",
    state: "AUTHORIZED",
    agentEns: "test.humanos.eth",
    capabilities: ["value.transfer"],
    approvedCapabilities: ["value.transfer"],
    steps: [],
    expiresAt: new Date(end * 1000).toISOString(),
    createdAt: stamp,
    updatedAt: stamp,
    policyVersion: "humanos-policy-v1",
  };
  await db.insert("missions", mission);
  const review: JawPermissionReview = {
    id: randomUUID(),
    missionId: mission.id,
    accountId,
    account,
    chainId: 11155111,
    spender: "0x2222222222222222222222222222222222222222",
    calls: [{ target: account, selector: "0xa9059cbb" }],
    spends: [{ token: account, allowance: "100", unit: "day", multiplier: 1 }],
    start: Math.floor(Date.now() / 1000),
    end,
    expiresAt: mission.expiresAt,
    createdAt: stamp,
  };
  await db.insert("jaw_reviews", review);
  const id = hashCanonical(randomUUID());
  const grant: JawPermissionGrant = {
    ...review,
    id,
    reviewId: review.id,
    permissionId: id,
    salt: "0x1",
    status: "UNVERIFIED",
    revokedAt: null,
  };
  const request = (path: string, body?: unknown) =>
    api.request(`/api/jaw/permissions${path}`, {
      headers: {
        cookie: `humanos_session=${token}`,
        "content-type": "application/json",
      },
      ...(body ? { method: "POST", body: JSON.stringify(body) } : {}),
    });
  return { request, grant, review, mission, token };
}
it("records only exact reviewed grants, without trusting browser activation, and retries identically", async () => {
  const { request, grant } = await setup();
  const response = await request("/record", { grant });
  expect(response.status).toBe(200);
  expect((await response.json()).grant.status).toBe("UNVERIFIED");
  expect((await request("/record", { grant })).status).toBe(200);
  expect((await (await request("")).json()).grants).toHaveLength(1);
  expect(
    (await request("/record", { grant: { ...grant, spender: grant.account } }))
      .status,
  ).toBe(409);
});
it("serializes concurrent exact records and revoke/replay without reviving verified revocation", async () => {
  let state: "ACTIVE" | "REVOKED" = "ACTIVE";
  const { request, grant } = await setup({
    verify: async (g) => ({
      permissionId: g.id,
      constraintsHash: jawGrantHash(g),
      state,
      checkedAt: new Date().toISOString(),
      spent: {},
    }),
  });
  const records = await Promise.all(
    Array.from({ length: 4 }, () => request("/record", { grant })),
  );
  expect(records.map((r) => r.status)).toEqual([200, 200, 200, 200]);
  expect((await (await request("")).json()).grants).toHaveLength(1);
  state = "REVOKED";
  await Promise.all([
    request(`/${grant.id}/revoke`, { success: true }),
    request("/record", { grant }),
  ]);
  expect(
    (await (await request("/record", { grant })).json()).grant.status,
  ).toBe("REVOKED");
});
it("does not activate forged, unavailable or stale independent evidence", async () => {
  for (const mode of ["forged", "stale", "unavailable"]) {
    const { request, grant } = await setup({
      verify: async (g) => {
        if (mode === "unavailable") throw new Error("unavailable");
        return {
          permissionId: g.id,
          constraintsHash: mode === "forged" ? "forged" : jawGrantHash(g),
          state: "ACTIVE",
          checkedAt: new Date(
            Date.now() - (mode === "stale" ? 60000 : 0),
          ).toISOString(),
          spent: {},
        };
      },
    });
    expect(
      (await (await request("/record", { grant })).json()).grant.status,
    ).toBe("UNVERIFIED");
  }
});
it("rejects expiry that passes while waiting for independent evidence", async () => {
  let entered!: () => void;
  let release!: () => void;
  const started = new Promise<void>((resolve) => {
    entered = resolve;
  });
  const waiting = new Promise<void>((resolve) => {
    release = resolve;
  });
  const { request, grant } = await setup({
    verify: async (g) => {
      entered();
      await waiting;
      return {
        permissionId: g.id,
        constraintsHash: jawGrantHash(g),
        state: "ACTIVE",
        checkedAt: new Date().toISOString(),
        spent: {},
      };
    },
  });
  const response = request("/record", { grant });
  await started;
  const clock = vi.spyOn(Date, "now").mockReturnValue(grant.end * 1000 + 1);
  try {
    release();
    expect((await response).status).toBe(401);
  } finally {
    clock.mockRestore();
  }
  expect((await (await request("")).json()).grants).toEqual([]);
});
it("revalidates mission ownership, state, expiry and durable root linkage", async () => {
  const { request, grant, mission, token } = await setup();
  const other = await setup();
  expect((await other.request("/record", { grant })).status).toBe(404);
  await db.put("missions", { ...mission, state: "REVOKED" });
  expect((await request("/record", { grant })).status).toBe(409);
  await db.put("missions", {
    ...mission,
    expiresAt: new Date(Date.now() - 1).toISOString(),
  });
  expect((await request("/record", { grant })).status).toBe(409);
  await db.query("DELETE FROM root_bindings WHERE account_id=$1", [
    grant.accountId,
  ]);
  expect((await request("")).status).toBe(403);
  await db.delete("sessions", hashCanonical(token));
  expect((await request("")).status).toBe(401);
});
it("rejects forged review, cross-account, widened pairs and invalid allowance", async () => {
  const { request, grant } = await setup();
  for (const change of [
    { reviewId: "forged" },
    { accountId: "another" },
    { chainId: 1 },
    { calls: [{ target: grant.account, selector: "0x12345678" }] },
    { spends: [{ ...grant.spends[0], allowance: "0x64" }] },
    { status: "ACTIVE" },
  ]) {
    const result = await request("/record", { grant: { ...grant, ...change } });
    expect(result.status).toBeGreaterThanOrEqual(400);
  }
  expect((await (await request("")).json()).grants).toEqual([]);
});
it("makes revocation deny immediately even without external verification and never revives replay", async () => {
  const { request, grant } = await setup();
  await request("/record", { grant });
  const other = await setup();
  expect(
    (await other.request(`/${grant.id}/revoke`, { success: true })).status,
  ).toBe(404);
  expect(
    (await request(`/${grant.id}/revoke`, { success: false })).status,
  ).toBe(400);
  const revoked = await request(`/${grant.id}/revoke`, { success: true });
  expect(revoked.status).toBe(200);
  expect((await revoked.json()).grant.status).toBe("RECONCILIATION_REQUIRED");
  const replay = await request("/record", { grant });
  expect((await replay.json()).grant.status).toBe("RECONCILIATION_REQUIRED");
});
it("requires a live linked account for every route", async () => {
  for (const path of [
    "/api/jaw/permissions",
    "/api/jaw/permissions/record",
    "/api/jaw/permissions/id/revoke",
  ])
    expect(
      (
        await app.request(path, {
          method: path.endsWith("permissions") ? "GET" : "POST",
        })
      ).status,
    ).toBe(401);
});
