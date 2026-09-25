import { beforeAll, afterAll, describe, it, expect } from "vitest";
import { randomUUID } from "node:crypto";
import { Database } from "@humanos/database";
import { hashCanonical, type Mission } from "@humanos/schemas";
import { createApi } from "../src/app.js";
const db = new Database(
  process.env.TEST_DATABASE_URL ??
    "postgresql://saikarthik@127.0.0.1:55432/humanos",
  { schema: "auth_" + randomUUID().replaceAll("-", "") },
);
const app = createApi({ db, origin: "http://localhost:5173" });
beforeAll(() => db.migrate());
afterAll(() => db.close());
describe("actual API authentication and honest unavailable state", () => {
  it("returns readiness without secrets and refuses unconfigured root verification", async () => {
    expect((await app.request("/api/health")).status).toBe(200);
    const ready = await (await app.request("/api/ready")).json();
    expect(ready.ready).toBe(false);
    expect(
      (
        await app.request("/api/world/root/request", {
          method: "POST",
          headers: { origin: "http://localhost:5173" },
        })
      ).status,
    ).toBe(503);
  });
  it("protects all mission/action/internal access and CSRF", async () => {
    for (const path of [
      "/api/missions",
      "/api/missions/other",
      "/api/internal/conversations/other",
    ])
      expect((await app.request(path)).status).toBe(401);
    expect(
      (await app.request("/api/actions/other/execute", { method: "POST" }))
        .status,
    ).toBe(401);
    expect(
      (
        await app.request("/api/world/root/request", {
          method: "POST",
          headers: { origin: "https://attacker.invalid" },
        })
      ).status,
    ).toBe(403);
    expect(
      (
        await app.request("/api/internal/missions/other/prepare", {
          method: "POST",
        })
      ).status,
    ).toBe(401);
  });
  it("rejects cross-user conversation IDs and expired sessions", async () => {
    const stamp = new Date().toISOString(),
      rootId = randomUUID(),
      other = randomUUID();
    await db.insert("roots", {
      id: rootId,
      ensName: null,
      createdAt: stamp,
      verificationEnvironment: "staging",
    });
    await db.insert("roots", {
      id: other,
      ensName: null,
      createdAt: stamp,
      verificationEnvironment: "staging",
    });
    const accountId = "11155111:0x1111111111111111111111111111111111111111";
    await db.insert("accounts", {
      id: accountId,
      address: "0x1111111111111111111111111111111111111111",
      chainId: 11155111,
      createdAt: stamp,
    });
    const token = randomUUID();
    await db.insert("sessions", {
      id: hashCanonical(token),
      accountId,
      rootId,
      expiresAt: new Date(Date.now() + 60000).toISOString(),
    });
    const mission: Mission = {
      id: randomUUID(),
      rootId: other,
      goal: "Apply",
      title: "Apply",
      state: "PROPOSED",
      agentEns: null,
      capabilities: [],
      approvedCapabilities: [],
      steps: [],
      expiresAt: new Date(Date.now() + 60000).toISOString(),
      createdAt: stamp,
      updatedAt: stamp,
      policyVersion: "humanos-policy-v1",
    };
    await db.insert("missions", mission);
    expect(
      (
        await app.request("/api/internal/conversations/" + mission.id, {
          headers: { cookie: "humanos_session=" + token },
        })
      ).status,
    ).toBe(404);
    await db.put("sessions", {
      id: hashCanonical(token),
      accountId,
      rootId,
      expiresAt: "2020-01-01T00:00:00Z",
    });
    expect(
      (
        await app.request("/api/missions", {
          headers: { cookie: "humanos_session=" + token },
        })
      ).status,
    ).toBe(401);
  });
});
