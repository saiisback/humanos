import { beforeAll, afterAll, it, expect } from "vitest";
import { randomUUID } from "node:crypto";
import { Database, type ChallengeRecord } from "@humanos/database";
import {
  hashCanonical,
  normalizeWalletAddress,
  type Mission,
  type Approval,
  type AuditEvent,
  type ActionProposal,
  type WorldProofRequest,
} from "@humanos/schemas";
import { createApi, type ApiConfig } from "../src/app.js";
import { approvalBinding } from "@humanos/world";
const db = new Database(
  process.env.TEST_DATABASE_URL ??
    "postgresql://saikarthik@127.0.0.1:55432/humanos",
  { schema: "approval_retry_" + randomUUID().replaceAll("-", "") },
);
beforeAll(() => db.migrate());
afterAll(() => db.close());
const fixtureNullifiers = new Map<string, `0x${string}`>();
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
  async verify(expected, payload) {
    if ((payload as { nonce: string }).nonce !== expected.rpContext.nonce)
      throw new Error("invalid fixture proof");
    const nullifierHash = fixtureNullifiers.get(expected.signal);
    if (!nullifierHash) throw new Error("unknown fixture human");
    return { nullifier: "1", nullifierHash };
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
  const address = normalizeWalletAddress(
    "0x" + hashCanonical(rootId).slice(2, 42),
  );
  const accountId = `11155111:${address}`;
  await db.insert("roots", {
    id: rootId,
    ensName: null,
    createdAt: stamp,
    verificationEnvironment: "staging",
  });
  await db.insert("accounts", {
    id: accountId,
    address,
    chainId: 11155111,
    createdAt: stamp,
  });
  await db.insert("sessions", {
    id: hashCanonical(token),
    accountId,
    rootId,
    expiresAt,
  });
  await db.insert("root_bindings", {
    id: randomUUID(),
    rootId,
    accountId,
    createdAt: stamp,
  });
  await db.insert("nullifiers", { id: hashCanonical(rootId), rootId });
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
  fixtureNullifiers.set(
    hashCanonical(approvalBinding(action)),
    hashCanonical(rootId),
  );
  const app = createApi({
    db,
    origin: "http://localhost:5173",
    world,
    siweVerifier: {
      async verify({ message }) {
        const address = message.match(
          /wants you to sign in with your Ethereum account:\n(0x[0-9a-fA-F]{40})/,
        )?.[1];
        if (!address) throw new Error("invalid message");
        return { address: address as `0x${string}`, chainId: 11155111 };
      },
    },
    ...(ens ? { ens } : {}),
  });
  const headers = {
    cookie: "humanos_session=" + token,
    "content-type": "application/json",
  };
  return { app, mission, action, headers, rootId, accountId, expiresAt };
}
it("approves against durable nullifier after logout and SIWE root restoration", async () => {
  const s = await setup();
  await s.app.request("/api/auth/logout", {
    method: "POST",
    headers: { ...s.headers, origin: "http://localhost:5173" },
  });
  const nonceResponse = await s.app.request("/api/auth/siwe/nonce", {
    method: "POST",
    headers: { origin: "http://localhost:5173" },
  });
  const nonce = await nonceResponse.json();
  const cookie = nonceResponse.headers.get("set-cookie")?.split(";")[0] ?? "";
  const message = `localhost:5173 wants you to sign in with your Ethereum account:\n${s.accountId.split(":")[1]}\n\nURI: http://localhost:5173\nVersion: 1\nChain ID: 11155111\nNonce: ${nonce.nonce}\nIssued At: ${new Date().toISOString()}\nExpiration Time: ${new Date(Date.now() + 240000).toISOString()}`;
  const login = await s.app.request("/api/auth/siwe/verify", {
    method: "POST",
    headers: {
      origin: "http://localhost:5173",
      cookie,
      "content-type": "application/json",
    },
    body: JSON.stringify({
      challengeId: nonce.challengeId,
      message,
      signature: "fixture",
    }),
  });
  expect(login.status).toBe(200);
  expect(await login.json()).toMatchObject({ root: { id: s.rootId } });
  const newCookie = login.headers.get("set-cookie")?.split(";")[0] ?? "";
  const route = `/api/actions/${s.action.id}/approval`;
  const requested = await s.app.request(`${route}/request`, {
    method: "POST",
    headers: { ...s.headers, cookie: newCookie },
  });
  expect(requested.status).toBe(200);
  const { request } = await requested.json();
  const approved = await s.app.request(`${route}/verify`, {
    method: "POST",
    headers: { ...s.headers, cookie: newCookie },
    body: JSON.stringify({
      requestId: request.requestId,
      proof: {
        nonce: request.rpContext.nonce,
        proof: "PRIVATE_PROOF_DO_NOT_LOG",
      },
    }),
  });
  expect(approved.status).toBe(200);
  expect(
    (
      await db.get<Approval>(
        "approvals",
        (await db.list<Approval>("approvals")).find(
          (p) => p.actionId === s.action.id,
        )!.id,
      )
    )?.status,
  ).toBe("VERIFIED");
  expect(JSON.stringify(await db.list("sessions"))).not.toContain(
    '"nullifier"',
  );
  expect(JSON.stringify(await db.list("audit"))).not.toContain(
    "PRIVATE_PROOF_DO_NOT_LOG",
  );
});
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
    (await db.get<ChallengeRecord>("challenges", first.request.requestId))
      ?.consumedAt,
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
  expect((await verify(first.request))?.status).not.toBe(200);
  expect((await verify(second.request))?.status).toBe(200);
  expect((await verify(second.request))?.status).not.toBe(200);
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
    accountId: s.accountId,
    rootId: s.rootId,
    expiresAt: s.expiresAt,
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
    (await db.get<ChallengeRecord>("challenges", first.request.requestId))
      ?.consumedAt,
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
    expect(
      (await db.get<Approval>("approvals", first.approval.id))?.status,
    ).toBe(status);
  },
);
it("audits cancellation/rejection and one concurrent expiry transition without payloads", async () => {
  const s = await setup();
  const route = `/api/actions/${s.action.id}/approval`;
  await s.app.request(route + "/request", {
    method: "POST",
    headers: s.headers,
  });
  expect(
    (
      await s.app.request(route + "/cancel", {
        method: "POST",
        headers: s.headers,
      })
    ).status,
  ).toBe(200);
  const cancelled = (await db.list<AuditEvent>("audit")).find(
    (e) => e.missionId === s.mission.id && e.type === "APPROVAL_CANCELLED",
  );
  expect(cancelled).toMatchObject({
    actionId: s.action.id,
    previousState: "AWAITING_APPROVAL",
    nextState: "REJECTED",
  });
  const x = await setup();
  await db.put("missions", { ...x.mission, expiresAt: "2020-01-01T00:00:00Z" });
  const responses = await Promise.all(
    [1, 2].map(() =>
      x.app.request(`/api/missions/${x.mission.id}`, { headers: x.headers }),
    ),
  );
  expect(responses.every((r) => r.status === 200)).toBe(true);
  const events = (await db.list<AuditEvent>("audit")).filter(
    (e) => e.missionId === x.mission.id && e.type === "MISSION_EXPIRED",
  );
  expect(events).toHaveLength(1);
  expect(JSON.stringify([...events, cancelled])).not.toContain("Alice");
});
it("audits denied proof attempt without logging proof contents or consuming pending approval", async () => {
  const s = await setup();
  const route = `/api/actions/${s.action.id}/approval`;
  const requested = await (
    await s.app.request(route + "/request", {
      method: "POST",
      headers: s.headers,
    })
  ).json();
  await s.app.request(route + "/verify", {
    method: "POST",
    headers: s.headers,
    body: JSON.stringify({
      requestId: requested.request.requestId,
      proof: { nonce: "PRIVATE_PROOF_DO_NOT_LOG" },
    }),
  });
  const events = (await db.list<AuditEvent>("audit")).filter(
    (e) => e.actionId === s.action.id,
  );
  expect(events.some((e) => e.type === "WORLD_APPROVAL_DENIED")).toBe(true);
  expect(JSON.stringify(events)).not.toContain("PRIVATE_PROOF_DO_NOT_LOG");
  expect(
    (await db.get<Approval>("approvals", requested.approval.id))?.status,
  ).toBe("PENDING");
});
it("cancels verified approval safely and refuses stale verified refresh", async () => {
  const s = await setup();
  const route = `/api/actions/${s.action.id}/approval`;
  const first = await (
    await s.app.request(route + "/request", {
      method: "POST",
      headers: s.headers,
    })
  ).json();
  expect(
    (
      await s.app.request(route + "/verify", {
        method: "POST",
        headers: s.headers,
        body: JSON.stringify({
          requestId: first.request.requestId,
          proof: { nonce: first.request.rpContext.nonce },
        }),
      })
    ).status,
  ).toBe(200);
  await db.query(
    "UPDATE approvals SET data=jsonb_set(data,'{verifiedAt}',to_jsonb($2::text)) WHERE id=$1",
    [first.approval.id, new Date(Date.now() - 360000).toISOString()],
  );
  expect(
    (
      await s.app.request(route + "/request", {
        method: "POST",
        headers: s.headers,
      })
    ).status,
  ).toBe(409);
  expect(
    (
      await s.app.request(route + "/cancel", {
        method: "POST",
        headers: s.headers,
      })
    ).status,
  ).toBe(200);
  expect((await db.get<Approval>("approvals", first.approval.id))?.status).toBe(
    "CANCELLED",
  );
  expect((await db.get<Mission>("missions", s.mission.id))?.state).toBe(
    "REJECTED",
  );
  expect(
    (
      await s.app.request(route + "/cancel", {
        method: "POST",
        headers: s.headers,
      })
    ).status,
  ).toBe(409);
});
it("returns conflict when cancelling a consumed approval without changing state", async () => {
  const s = await setup();
  const route = `/api/actions/${s.action.id}/approval`;
  const first = await (
    await s.app.request(route + "/request", {
      method: "POST",
      headers: s.headers,
    })
  ).json();
  await s.app.request(route + "/verify", {
    method: "POST",
    headers: s.headers,
    body: JSON.stringify({
      requestId: first.request.requestId,
      proof: { nonce: first.request.rpContext.nonce },
    }),
  });
  await db.withLockedAction(s.action.id, (tx) =>
    tx.consumeApproval(first.approval.id, new Date()),
  );
  expect(
    (
      await s.app.request(route + "/cancel", {
        method: "POST",
        headers: s.headers,
      })
    ).status,
  ).toBe(409);
  expect((await db.get<Approval>("approvals", first.approval.id))?.status).toBe(
    "CONSUMED",
  );
  expect((await db.get<Mission>("missions", s.mission.id))?.state).toBe(
    "RUNNING",
  );
});
