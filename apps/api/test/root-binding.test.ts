import { afterAll, beforeAll, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import { Database, type SessionRecord } from "@humanos/database";
import { hashCanonical, type RootAccountBinding } from "@humanos/schemas";
import { createApi, type ApiConfig } from "../src/app.js";
import { WorldVerificationError } from "@humanos/world";

const origin = "http://localhost:5173";
const db = new Database(
  process.env.TEST_DATABASE_URL ??
    "postgresql://saikarthik@127.0.0.1:55432/humanos",
  { schema: "root_binding_" + randomUUID().replaceAll("-", "") },
);
const humanHash = hashCanonical("one verified human");
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
  async verify(request, proof) {
    if ((proof as { nonce?: string }).nonce !== request.rpContext.nonce)
      throw new Error("invalid fixture proof");
    const human = (proof as { human?: string }).human ?? "one verified human";
    return { nullifier: "1", nullifierHash: hashCanonical(human) };
  },
};
const app = createApi({ db, origin, world });
beforeAll(() => db.migrate());
afterAll(() => db.close());

async function signedIn(seed: number) {
  const address = `0x${seed.toString(16).padStart(40, "0")}`;
  const accountId = `11155111:${address}`;
  const token = randomUUID();
  await db.insert("accounts", {
    id: accountId,
    address,
    chainId: 11155111,
    createdAt: new Date().toISOString(),
  });
  await db.insert("sessions", {
    id: hashCanonical(token),
    accountId,
    rootId: null,
    expiresAt: new Date(Date.now() + 600000).toISOString(),
  });
  return { accountId, token, cookie: `humanos_session=${token}` };
}
async function request(cookie: string) {
  const response = await app.request("/api/world/root/request", {
    method: "POST",
    headers: { origin, cookie },
  });
  const body = await response.json();
  const challengeCookie =
    response.headers.get("set-cookie")?.split(";")[0] ?? "";
  return { response, body, challengeCookie };
}
async function verify(
  requestId: string,
  nonce: string,
  cookie: string,
  challengeCookie: string,
  human?: string,
) {
  return app.request("/api/world/root/verify", {
    method: "POST",
    headers: {
      origin,
      cookie: `${cookie}; ${challengeCookie}`,
      "content-type": "application/json",
    },
    body: JSON.stringify({
      requestId,
      proof: {
        nonce,
        proof: "secret-proof-bytes",
        ...(human ? { human } : {}),
      },
    }),
  });
}

it("requires an account session and upgrades the same session after World verification", async () => {
  expect((await request("")).response.status).toBe(401);
  const user = await signedIn(1);
  const issued = await request(user.cookie);
  expect(issued.response.status).toBe(200);
  const result = await verify(
    issued.body.requestId,
    issued.body.rpContext.nonce,
    user.cookie,
    issued.challengeCookie,
  );
  expect(result.status).toBe(200);
  expect(result.headers.get("set-cookie") ?? "").not.toContain(
    "humanos_session=",
  );
  const body = await result.json();
  expect(body).toMatchObject({
    account: { id: user.accountId },
    root: { id: expect.any(String) },
  });
  expect(
    await db.get<SessionRecord>("sessions", hashCanonical(user.token)),
  ).toMatchObject({ accountId: user.accountId, rootId: body.root.id });
  expect(await db.list<RootAccountBinding>("root_bindings")).toContainEqual(
    expect.objectContaining({
      accountId: user.accountId,
      rootId: body.root.id,
    }),
  );
  expect(
    await (
      await app.request("/api/auth/session", {
        headers: { cookie: user.cookie },
      })
    ).json(),
  ).toMatchObject({
    account: { id: user.accountId },
    root: { id: body.root.id },
  });
  for (const table of [
    "sessions",
    "challenges",
    "nullifiers",
    "audit",
  ] as const)
    expect(JSON.stringify(await db.list(table))).not.toContain(
      "secret-proof-bytes",
    );
  expect(JSON.stringify(await db.list("sessions"))).not.toContain(
    '"nullifier"',
  );
});

it("rejects another account's claim without orphan rows or consuming its challenge", async () => {
  const user = await signedIn(2);
  if (!(await db.get("nullifiers", humanHash))) {
    const first = await signedIn(8);
    const firstRequest = await request(first.cookie);
    expect(
      (
        await verify(
          firstRequest.body.requestId,
          firstRequest.body.rpContext.nonce,
          first.cookie,
          firstRequest.challengeCookie,
        )
      ).status,
    ).toBe(200);
  }
  const issued = await request(user.cookie);
  expect(issued.response.status, JSON.stringify(issued.body)).toBe(200);
  const beforeRoots = (await db.list("roots")).length;
  const result = await verify(
    issued.body.requestId,
    issued.body.rpContext.nonce,
    user.cookie,
    issued.challengeCookie,
  );
  expect(result.status, await result.clone().text()).toBe(409);
  expect((await result.json()).error.code).toBe("ROOT_ACCOUNT_CONFLICT");
  expect((await db.list("roots")).length).toBe(beforeRoots);
  expect(
    (
      await db.get<{ consumedAt: string | null }>(
        "challenges",
        issued.body.requestId,
      )
    )?.consumedAt,
  ).toBeNull();
  expect(
    (await db.get<SessionRecord>("sessions", hashCanonical(user.token)))
      ?.rootId,
  ).toBeNull();
});

it("rolls back a second human claim when the account already owns a root", async () => {
  const user = await signedIn(10);
  const first = await request(user.cookie);
  expect(
    (
      await verify(
        first.body.requestId,
        first.body.rpContext.nonce,
        user.cookie,
        first.challengeCookie,
        "human ten",
      )
    ).status,
  ).toBe(200);
  const rootsBefore = (await db.list("roots")).length;
  const nullifiersBefore = (await db.list("nullifiers")).length;
  const second = await request(user.cookie);
  const response = await verify(
    second.body.requestId,
    second.body.rpContext.nonce,
    user.cookie,
    second.challengeCookie,
    "different human",
  );
  expect(response.status).toBe(409);
  expect((await response.json()).error.code).toBe("ROOT_ACCOUNT_CONFLICT");
  expect((await db.list("roots")).length).toBe(rootsBefore);
  expect((await db.list("nullifiers")).length).toBe(nullifiersBefore);
  expect(
    (
      await db.get<{ consumedAt: string | null }>(
        "challenges",
        second.body.requestId,
      )
    )?.consumedAt,
  ).toBeNull();
});

it("refuses an expired challenge after provider verification without changing the session", async () => {
  const user = await signedIn(11);
  let release!: () => void;
  let entered!: () => void;
  const providerEntered = new Promise<void>((resolve) => {
    entered = resolve;
  });
  const providerGate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const delayed = createApi({
    db,
    origin,
    world: {
      ...world,
      async verify(request, proof) {
        entered();
        await providerGate;
        return world.verify(request, proof);
      },
    },
  });
  const issuedResponse = await delayed.request("/api/world/root/request", {
    method: "POST",
    headers: { origin, cookie: user.cookie },
  });
  const issued = await issuedResponse.json();
  const challengeCookie =
    issuedResponse.headers.get("set-cookie")?.split(";")[0] ?? "";
  const pending = delayed.request("/api/world/root/verify", {
    method: "POST",
    headers: {
      origin,
      cookie: `${user.cookie}; ${challengeCookie}`,
      "content-type": "application/json",
    },
    body: JSON.stringify({
      requestId: issued.requestId,
      proof: { nonce: issued.rpContext.nonce, human: "human eleven" },
    }),
  });
  await providerEntered;
  await db.query(
    "UPDATE challenges SET data=jsonb_set(data,'{expiresAt}',to_jsonb($2::text)) WHERE id=$1",
    [issued.requestId, "2020-01-01T00:00:00Z"],
  );
  release();
  const response = await pending;
  expect(response.status).toBe(403);
  expect((await response.json()).error.code).toBe("INVALID_CHALLENGE");
  expect(
    (await db.get<SessionRecord>("sessions", hashCanonical(user.token)))
      ?.rootId,
  ).toBeNull();
  expect(await db.get("nullifiers", hashCanonical("human eleven"))).toBeNull();
});

it.each(["session", "challenge"] as const)(
  "rolls back a root claim when the %s expires while waiting for the root lock",
  async (expiring) => {
    const seed = expiring === "session" ? 12 : 13;
    const user = await signedIn(seed);
    const human = `root-lock-human-${expiring}`;
    const rootId = randomUUID();
    await db.insert("roots", {
      id: rootId,
      ensName: null,
      createdAt: new Date().toISOString(),
      verificationEnvironment: "staging",
    });
    await db.insert("nullifiers", { id: hashCanonical(human), rootId });
    const issued = await request(user.cookie);
    const expiresAt = new Date(Date.now() + 2500).toISOString();
    await db.query(
      `UPDATE ${expiring === "session" ? "sessions" : "challenges"} SET data=jsonb_set(data,'{expiresAt}',to_jsonb($2::text)) WHERE id=$1`,
      [
        expiring === "session"
          ? hashCanonical(user.token)
          : issued.body.requestId,
        expiresAt,
      ],
    );
    let release!: () => void;
    let locked!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const rootLocked = new Promise<void>((resolve) => {
      locked = resolve;
    });
    const holder = db.transaction(async (tx) => {
      await tx.query("SELECT id FROM roots WHERE id=$1 FOR UPDATE", [rootId]);
      locked();
      await gate;
    });
    await rootLocked;
    const pending = verify(
      issued.body.requestId,
      issued.body.rpContext.nonce,
      user.cookie,
      issued.challengeCookie,
      human,
    );
    try {
      let waiting = false;
      while (Date.now() < Date.parse(expiresAt) - 200) {
        const row = await db.query(
          "SELECT 1 FROM pg_stat_activity WHERE wait_event_type='Lock' AND query='SELECT id FROM roots WHERE id=$1 FOR UPDATE' LIMIT 1",
        );
        if (row.rowCount) {
          waiting = true;
          break;
        }
        await new Promise((resolve) => setTimeout(resolve, 20));
      }
      expect(
        waiting,
        "verification must reach the root row lock before expiry",
      ).toBe(true);
      await new Promise((resolve) =>
        setTimeout(
          resolve,
          Math.max(0, Date.parse(expiresAt) - Date.now() + 50),
        ),
      );
    } finally {
      release();
      await holder;
    }
    const response = await pending;
    expect(response.status).toBe(expiring === "session" ? 401 : 403);
    expect((await response.json()).error.code).toBe(
      expiring === "session" ? "UNAUTHENTICATED" : "INVALID_CHALLENGE",
    );
    expect(
      (await db.get<SessionRecord>("sessions", hashCanonical(user.token)))
        ?.rootId,
    ).toBeNull();
    expect(
      (await db.list<RootAccountBinding>("root_bindings")).filter(
        (binding) => binding.accountId === user.accountId,
      ),
    ).toHaveLength(0);
    expect(
      (
        await db.get<{ consumedAt: string | null }>(
          "challenges",
          issued.body.requestId,
        )
      )?.consumedAt,
    ).toBeNull();
  },
  10000,
);

it("binds a concurrent first nullifier claim to exactly one account", async () => {
  const uniqueHash = hashCanonical(randomUUID());
  const concurrent = createApi({
    db,
    origin,
    world: {
      ...world,
      async verify(request, proof) {
        await world.verify(request, proof);
        return { nullifier: "2", nullifierHash: uniqueHash };
      },
    },
  });
  const [a, b] = await Promise.all([signedIn(3), signedIn(4)]);
  const issue = async (user: typeof a) => {
    const response = await concurrent.request("/api/world/root/request", {
      method: "POST",
      headers: { origin, cookie: user.cookie },
    });
    return {
      body: await response.json(),
      challengeCookie: response.headers.get("set-cookie")?.split(";")[0] ?? "",
    };
  };
  const [ar, br] = await Promise.all([issue(a), issue(b)]);
  const attempt = (user: typeof a, challenge: typeof ar) =>
    concurrent.request("/api/world/root/verify", {
      method: "POST",
      headers: {
        origin,
        cookie: `${user.cookie}; ${challenge.challengeCookie}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({
        requestId: challenge.body.requestId,
        proof: { nonce: challenge.body.rpContext.nonce },
      }),
    });
  const results = await Promise.all([attempt(a, ar), attempt(b, br)]);
  expect(results.map((r) => r.status).sort()).toEqual([200, 409]);
  expect(
    (await db.get<{ rootId: string }>("nullifiers", uniqueHash))?.rootId,
  ).toBeTruthy();
  expect(
    (await db.list<RootAccountBinding>("root_bindings")).filter((r) =>
      [a.accountId, b.accountId].includes(r.accountId),
    ),
  ).toHaveLength(1);
});

it("rejects wrong browser, wrong session and replay while preserving the JAW session", async () => {
  const user = await signedIn(5);
  const other = await signedIn(6);
  const issued = await request(user.cookie);
  const nonce = issued.body.rpContext.nonce;
  expect(
    (
      await verify(
        issued.body.requestId,
        nonce,
        user.cookie,
        "humanos_challenge=wrong",
      )
    ).status,
  ).toBe(403);
  expect(
    (
      await verify(
        issued.body.requestId,
        nonce,
        other.cookie,
        issued.challengeCookie,
      )
    ).status,
  ).toBe(403);
  expect(
    (
      await verify(
        issued.body.requestId,
        nonce,
        user.cookie,
        issued.challengeCookie,
        "third verified human",
      )
    ).status,
  ).toBe(200);
  expect(
    (
      await verify(
        issued.body.requestId,
        nonce,
        user.cookie,
        issued.challengeCookie,
        "third verified human",
      )
    ).status,
  ).not.toBe(200);
  expect(
    (
      await app.request("/api/auth/session", {
        headers: { cookie: user.cookie },
      })
    ).status,
  ).toBe(200);
});

it("keeps account sign-in after cancellation or unavailable World", async () => {
  const user = await signedIn(7);
  await request(user.cookie); // Client closes the World prompt without submitting a proof.
  const unavailable = createApi({ db, origin });
  expect(
    (
      await unavailable.request("/api/world/root/request", {
        method: "POST",
        headers: { origin, cookie: user.cookie },
      })
    ).status,
  ).toBe(503);
  expect(
    await (
      await app.request("/api/auth/session", {
        headers: { cookie: user.cookie },
      })
    ).json(),
  ).toMatchObject({ account: { id: user.accountId }, root: null });
  expect(
    (await db.get<SessionRecord>("sessions", hashCanonical(user.token)))
      ?.rootId,
  ).toBeNull();
});
it("rejects a failed proof without consuming the root challenge", async () => {
  const user = await signedIn(9);
  const refusing = createApi({
    db,
    origin,
    world: {
      ...world,
      async verify() {
        throw new WorldVerificationError();
      },
    },
  });
  const issued = await request(user.cookie);
  const response = await refusing.request("/api/world/root/verify", {
    method: "POST",
    headers: {
      origin,
      cookie: `${user.cookie}; ${issued.challengeCookie}`,
      "content-type": "application/json",
    },
    body: JSON.stringify({
      requestId: issued.body.requestId,
      proof: { nonce: issued.body.rpContext.nonce },
    }),
  });
  expect(response.status).toBe(403);
  expect((await response.json()).error.code).toBe("INVALID_PROOF");
  expect(
    (
      await db.get<{ consumedAt: string | null }>(
        "challenges",
        issued.body.requestId,
      )
    )?.consumedAt,
  ).toBeNull();
  expect(
    (await db.get<SessionRecord>("sessions", hashCanonical(user.token)))
      ?.rootId,
  ).toBeNull();
});
