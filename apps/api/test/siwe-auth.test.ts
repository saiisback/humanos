import { afterAll, beforeAll, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import { Database } from "@humanos/database";
import { hashCanonical } from "@humanos/schemas";
import { createApi, type ApiConfig } from "../src/app.js";

const origin = "http://localhost:5173";
const address = "0x1111111111111111111111111111111111111111";
const db = new Database(
  process.env.TEST_DATABASE_URL ??
    "postgresql://saikarthik@127.0.0.1:55432/humanos",
  { schema: "siwe_auth_" + randomUUID().replaceAll("-", "") },
);
const verifier: NonNullable<ApiConfig["siweVerifier"]> = {
  async verify({ message, signature }) {
    if (signature !== hashCanonical(message))
      throw new Error("INVALID_SIGNATURE");
    const match = message.match(
      /wants you to sign in with your Ethereum account:\n(0x[0-9a-fA-F]{40})/,
    );
    if (!match) throw new Error("INVALID_MESSAGE");
    return {
      address: match[1] as `0x${string}`,
      chainId: Number(message.match(/Chain ID: (\d+)/)?.[1]),
    };
  },
};
const app = createApi({ db, origin, siweVerifier: verifier });
beforeAll(() => db.migrate());
afterAll(() => db.close());

async function challenge() {
  const response = await app.request("/api/auth/siwe/nonce", {
    method: "POST",
    headers: { origin },
  });
  expect(response.status).toBe(200);
  const body = (await response.json()) as {
    challengeId: string;
    nonce: string;
    domain: string;
    uri: string;
    chainId: number;
    expiresAt: string;
  };
  const cookie = response.headers.get("set-cookie")?.split(";")[0] ?? "";
  expect(response.headers.get("set-cookie")).toContain("HttpOnly");
  expect(cookie).toMatch(/^humanos_auth_challenge=/);
  return { body, cookie };
}
function message(
  c: Awaited<ReturnType<typeof challenge>>["body"],
  changes: Record<string, string | number> = {},
) {
  const fields = {
    domain: c.domain,
    uri: c.uri,
    nonce: c.nonce,
    chainId: c.chainId,
    issuedAt: new Date().toISOString(),
    expiration: new Date(Date.now() + 240000).toISOString(),
    ...changes,
  };
  return `${fields.domain} wants you to sign in with your Ethereum account:\n${address}\n\nURI: ${fields.uri}\nVersion: 1\nChain ID: ${fields.chainId}\nNonce: ${fields.nonce}\nIssued At: ${fields.issuedAt}\nExpiration Time: ${fields.expiration}`;
}
async function verify(
  c: Awaited<ReturnType<typeof challenge>>,
  signedMessage: string,
  signature = hashCanonical(signedMessage),
) {
  return app.request("/api/auth/siwe/verify", {
    method: "POST",
    headers: { origin, cookie: c.cookie, "content-type": "application/json" },
    body: JSON.stringify({
      challengeId: c.body.challengeId,
      message: signedMessage,
      signature,
    }),
  });
}

it("issues an account session once and rejects replay", async () => {
  const c = await challenge();
  const first = await verify(c, message(c.body));
  expect(first.status).toBe(200);
  expect(first.headers.get("set-cookie")).toContain("humanos_session=");
  expect(first.headers.get("set-cookie")).toContain("HttpOnly");
  expect(await first.json()).toMatchObject({
    account: { address, chainId: 11155111 },
    root: null,
  });
  expect((await verify(c, message(c.body))).status).toBe(403);
  const sessionCookie = first.headers.get("set-cookie")?.split(";")[0] ?? "";
  expect(
    await (
      await app.request("/api/auth/session", {
        headers: { cookie: sessionCookie },
      })
    ).json(),
  ).toMatchObject({ account: { address }, root: null });
  expect(
    (
      await app.request("/api/auth/logout", {
        method: "POST",
        headers: { origin, cookie: sessionCookie },
      })
    ).status,
  ).toBe(200);
  expect(
    await (
      await app.request("/api/auth/session", {
        headers: { cookie: sessionCookie },
      })
    ).json(),
  ).toMatchObject({ account: null, root: null });
});

it.each([
  ["domain", { domain: "attacker.invalid" }],
  ["URI", { uri: "https://attacker.invalid" }],
  ["chain", { chainId: 1 }],
  ["nonce", { nonce: "wrongnonce123" }],
])(
  "consumes a valid signed message with wrong %s without issuing a session",
  async (_name, changes) => {
    const c = await challenge();
    const response = await verify(c, message(c.body, changes));
    expect(response.status).toBe(403);
    expect(response.headers.get("set-cookie") ?? "").not.toContain(
      "humanos_session=",
    );
    expect((await verify(c, message(c.body))).status).toBe(403);
  },
);

it("preserves a challenge after an invalid signature or expired message", async () => {
  const c = await challenge();
  expect((await verify(c, message(c.body), "0xdead")).status).toBe(403);
  expect(
    (
      await verify(
        c,
        message(c.body, {
          expiration: new Date(Date.now() - 1000).toISOString(),
        }),
      )
    ).status,
  ).toBe(403);
  expect((await verify(c, message(c.body))).status).toBe(200);
});

it("rejects an expired challenge and issues no session", async () => {
  const c = await challenge();
  await db.query(
    "UPDATE challenges SET data=jsonb_set(data,'{expiresAt}',to_jsonb($2::text)) WHERE id=$1",
    [c.body.challengeId, "2020-01-01T00:00:00Z"],
  );
  const response = await verify(c, message(c.body));
  expect(response.status).toBe(403);
  expect(response.headers.get("set-cookie") ?? "").not.toContain(
    "humanos_session=",
  );
});

it("restores the existing root when a bound account signs in again", async () => {
  const accountId = `11155111:${address}`;
  const rootId = randomUUID();
  const stamp = new Date().toISOString();
  await db.put("accounts", {
    id: accountId,
    address,
    chainId: 11155111,
    createdAt: stamp,
  });
  await db.insert("roots", {
    id: rootId,
    ensName: null,
    createdAt: stamp,
    verificationEnvironment: "staging",
  });
  await db.insert("root_bindings", {
    id: randomUUID(),
    accountId,
    rootId,
    createdAt: stamp,
  });
  const c = await challenge();
  const response = await verify(c, message(c.body));
  expect(response.status).toBe(200);
  expect(await response.json()).toMatchObject({ root: { id: rootId } });
  const cookie = response.headers.get("set-cookie")?.split(";")[0] ?? "";
  expect(
    await (
      await app.request("/api/auth/session", { headers: { cookie } })
    ).json(),
  ).toMatchObject({ root: { id: rootId } });
});

it("fails closed when no SIWE verifier is configured", async () => {
  const unavailable = createApi({ db, origin });
  expect(
    (
      await unavailable.request("/api/auth/siwe/nonce", {
        method: "POST",
        headers: { origin },
      })
    ).status,
  ).toBe(503);
});
