import { beforeAll, afterAll, it, expect } from "vitest";
import { randomUUID } from "node:crypto";
import { Database } from "@humanos/database";
import {
  hashCanonical,
  type Mission,
  type ActionProposal,
  type WorldProofRequest,
} from "@humanos/schemas";
import { createApi, type ApiConfig } from "../src/app.js";
const db = new Database(
  process.env.TEST_DATABASE_URL ??
    "postgresql://saikarthik@127.0.0.1:55432/humanos",
  { schema: "approval_retry_" + randomUUID().replaceAll("-", "") },
);
beforeAll(() => db.migrate());
afterAll(() => db.close());
// API boundary fixture. Cryptographic acceptance is covered separately by World adapter tests.
const world: NonNullable<ApiConfig["world"]> = {
  createRequest(action, signal) {
    return {
      requestId: randomUUID(),
      action,
      signal,
      appId: "app_fixture",
      environment: "staging",
      rpContext: {
        rp_id: "rp_fixture",
        nonce: randomUUID(),
        signature: "fixture",
        created_at: Date.now() / 1000,
        expires_at: Date.now() / 1000 + 300,
      },
    };
  },
  async verify(expected, payload, expectedNullifier) {
    if (
      (payload as { nonce: string }).nonce !== expected.rpContext.nonce ||
      expectedNullifier !== "1"
    )
      throw new Error("invalid fixture proof");
    return { nullifier: "1", nullifierHash: hashCanonical("fixture-human") };
  },
};
async function setup(
  state: Mission["state"] = "RUNNING",
  ens?: ApiConfig["ens"],
) {
  const stamp = new Date().toISOString(),
    expiresAt = new Date(Date.now() + 900000).toISOString();
  const rootId = randomUUID(),
    token = randomUUID();
  await db.insert("roots", {
    id: rootId,
    ensName: null,
    createdAt: stamp,
    verificationEnvironment: "staging",
  });
  await db.insert("sessions", {
    id: hashCanonical(token),
    rootId,
    expiresAt,
    nullifier: "1",
  });
  const mission: Mission = {
    id: randomUUID(),
    rootId,
    agentEns: state === "PROPOSED" ? null : "a.eth",
    goal: "Apply",
    title: "Apply",
    capabilities: ["application.submit"],
    approvedCapabilities: state === "PROPOSED" ? [] : ["application.submit"],
    steps: [],
    expiresAt,
    state,
    createdAt: stamp,
    updatedAt: stamp,
    policyVersion: "humanos-policy-v1",
  };
  await db.insert("missions", mission);
  const action: ActionProposal = {
    id: randomUUID(),
    missionId: mission.id,
    rootId,
    agentEns: "a.eth",
    type: "SUBMIT_APPLICATION",
    capability: "application.submit",
    payload: { name: "Alice" },
    payloadHash: hashCanonical({ name: "Alice" }),
    reason: "Apply",
    nonce: randomUUID(),
    createdAt: stamp,
    expiresAt,
  };
  await db.insert("actions", action);
  const app = createApi({
    db,
    origin: "http://localhost:5173",
    world,
    ...(ens ? { ens } : {}),
  });
  const headers = {
    cookie: "humanos_session=" + token,
    "content-type": "application/json",
  };
  return { app, mission, action, headers, rootId, expiresAt };
}
it("refreshes expired challenge without replacing approval; old request cannot verify", async () => {
  const s = await setup();
  const route = `/api/actions/${s.action.id}/approval`;
  const first = await (
    await s.app.request(route + "/request", {
      method: "POST",
      headers: s.headers,
    })
  ).json();
  await db.query(
    "UPDATE challenges SET data=jsonb_set(data,'{expiresAt}',to_jsonb($2::text)) WHERE id=$1",
    [first.request.requestId, "2020-01-01T00:00:00Z"],
  );
  const response = await s.app.request(route + "/request", {
    method: "POST",
    headers: s.headers,
  });
  expect(response.status).toBe(200);
  const second = await response.json();
  expect(second.approval.id).toBe(first.approval.id);
  expect(second.approval.bindingHash).toBe(first.approval.bindingHash);
  expect(second.request.requestId).not.toBe(first.request.requestId);
  expect(
    (await db.get<any>("challenges", first.request.requestId)).consumedAt,
  ).not.toBeNull();
  const verify = (r: WorldProofRequest) =>
    s.app.request(route + "/verify", {
      method: "POST",
      headers: s.headers,
      body: JSON.stringify({
        requestId: r.requestId,
        proof: { nonce: r.rpContext.nonce },
      }),
    });
  expect((await verify(first.request)).status).not.toBe(200);
  expect((await verify(second.request)).status).toBe(200);
  expect((await verify(second.request)).status).not.toBe(200);
});
it("refuses cancelled approval refresh and another session takeover", async () => {
  const s = await setup();
  const route = `/api/actions/${s.action.id}/approval`;
  const first = await (
    await s.app.request(route + "/request", {
      method: "POST",
      headers: s.headers,
    })
  ).json();
  await db.query(
    "UPDATE challenges SET data=jsonb_set(data,'{expiresAt}',to_jsonb($2::text)) WHERE id=$1",
    [first.request.requestId, "2020-01-01T00:00:00Z"],
  );
  const secondToken = randomUUID();
  await db.insert("sessions", {
    id: hashCanonical(secondToken),
    rootId: s.rootId,
    expiresAt: s.expiresAt,
    nullifier: "1",
  });
  expect(
    (
      await s.app.request(route + "/request", {
        method: "POST",
        headers: { ...s.headers, cookie: "humanos_session=" + secondToken },
      })
    ).status,
  ).toBe(403);
  expect(
    (
      await s.app.request(route + "/cancel", {
        method: "POST",
        headers: s.headers,
      })
    ).status,
  ).toBe(200);
  expect(
    (
      await s.app.request(route + "/request", {
        method: "POST",
        headers: s.headers,
      })
    ).status,
  ).toBe(409);
});
it("serializes concurrent authorization before calling ENS", async () => {
  let calls = 0;
  const ens: NonNullable<ApiConfig["ens"]> = {
    register: async () => {
      calls++;
      await new Promise((r) => setTimeout(r, 30));
      return "a.eth";
    },
    revoke: async () => {},
    readAuthorization: async () => {
      throw new Error("unused");
    },
  };
  const s = await setup("PROPOSED", ens);
  const results = await Promise.all(
    Array.from({ length: 2 }, () =>
      s.app.request(`/api/missions/${s.mission.id}/authorize`, {
        method: "POST",
        headers: s.headers,
        body: JSON.stringify({ approvedCapabilities: ["application.submit"] }),
      }),
    ),
  );
  expect(results.map((r) => r.status).sort()).toEqual([200, 409]);
  expect(calls).toBe(1);
});
it("revocation waits for in-flight registration and leaves mission revoked", async () => {
  let started!: () => void, release!: () => void;
  const registrationStarted = new Promise<void>((r) => {
    started = r;
  });
  const gate = new Promise<void>((r) => {
    release = r;
  });
  let revoked = false;
  const ens: NonNullable<ApiConfig["ens"]> = {
    register: async () => {
      started();
      await gate;
      return "a.eth";
    },
    revoke: async () => {
      revoked = true;
    },
    readAuthorization: async () => {
      throw new Error("unused");
    },
  };
  const s = await setup("PROPOSED", ens);
  const authorization = s.app.request(
    `/api/missions/${s.mission.id}/authorize`,
    {
      method: "POST",
      headers: s.headers,
      body: JSON.stringify({ approvedCapabilities: ["application.submit"] }),
    },
  );
  await registrationStarted;
  const revocation = s.app.request(`/api/missions/${s.mission.id}/revoke`, {
    method: "POST",
    headers: s.headers,
  });
  release();
  await authorization;
  await revocation;
  expect((await db.get<Mission>("missions", s.mission.id))?.state).toBe(
    "REVOKED",
  );
  expect(revoked).toBe(true);
});
it("uses fixed World action scope and exact approval digest signal", async () => {
  const s = await setup();
  const first = await (
    await s.app.request(`/api/actions/${s.action.id}/approval/request`, {
      method: "POST",
      headers: s.headers,
    })
  ).json();
  expect(first.request.action).toBe("humanos-root");
  expect(first.request.signal).toBe(first.approval.bindingHash);
});
it("replaces a live legacy dynamic-scope challenge and serializes concurrent refresh", async () => {
  const s = await setup();
  const route = `/api/actions/${s.action.id}/approval/request`;
  const first = await (
    await s.app.request(route, { method: "POST", headers: s.headers })
  ).json();
  await db.query(
    "UPDATE challenges SET data=jsonb_set(data,'{request,action}',to_jsonb($2::text)) WHERE id=$1",
    [first.request.requestId, "humanos:legacy-digest"],
  );
  const responses = await Promise.all(
    Array.from({ length: 3 }, () =>
      s.app.request(route, { method: "POST", headers: s.headers }),
    ),
  );
  expect(responses.every((r) => r.status === 200)).toBe(true);
  const refreshed = await Promise.all(responses.map((r) => r.json()));
  expect(new Set(refreshed.map((r) => r.request.requestId)).size).toBe(1);
  expect(refreshed[0].request.requestId).not.toBe(first.request.requestId);
  expect(refreshed[0].request.action).toBe("humanos-root");
  expect(
    (await db.get<any>("challenges", first.request.requestId)).consumedAt,
  ).not.toBeNull();
});
it.each(["DENIED", "CANCELLED", "CONSUMED", "VERIFIED"])(
  "never resets a %s approval during refresh",
  async (status) => {
    const s = await setup();
    const route = `/api/actions/${s.action.id}/approval/request`;
    const first = await (
      await s.app.request(route, { method: "POST", headers: s.headers })
    ).json();
    await db.query(
      "UPDATE approvals SET data=jsonb_set(data,'{status}',to_jsonb($2::text)) WHERE id=$1",
      [first.approval.id, status],
    );
    expect(
      (await s.app.request(route, { method: "POST", headers: s.headers }))
        .status,
    ).toBe(409);
    expect((await db.get<any>("approvals", first.approval.id)).status).toBe(
      status,
    );
  },
);
