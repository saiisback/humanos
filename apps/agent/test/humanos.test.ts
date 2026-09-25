import { expect, it } from "vitest";
import { Hono } from "hono";
import { createProtectedApp } from "../src/http.js";
import { canPrepareMission, prepareNextAction } from "../src/mission.js";
const cfg = {
  apiUrl: "http://localhost:3001",
  webOrigin: "http://localhost:3000",
  internalSecret: "test-secret",
};
const router = new Hono().all("/*", (c) => c.json({ admitted: true }, 202));
function app(status = 200) {
  return createProtectedApp(
    cfg,
    router,
    async () =>
      new Response(JSON.stringify({ mission: { id: "m" } }), { status }),
  );
}
it.each(["GET", "HEAD", "POST"])(
  "rejects anonymous %s access",
  async (method) => {
    expect((await app().request("/agents/humanos/m", { method })).status).toBe(
      401,
    );
  },
);
it.each(["", "/abort", "/attachments/file"])(
  "checks ownership for all surfaces %s",
  async (suffix) => {
    expect(
      (
        await app(403).request("/agents/humanos/m" + suffix, {
          headers: { cookie: "sid=abc" },
        })
      ).status,
    ).toBe(403);
  },
);
it("rejects client initialData and cross-origin prompts", async () => {
  expect(
    (
      await app().request("/agents/humanos/m", {
        method: "POST",
        headers: { cookie: "sid=abc", "content-type": "application/json" },
        body: JSON.stringify({
          kind: "user",
          body: "hi",
          initialData: { id: "victim" },
        }),
      })
    ).status,
  ).toBe(400);
  expect(
    (
      await app().request("/agents/humanos/m", {
        method: "POST",
        headers: {
          cookie: "sid=abc",
          origin: "https://evil.test",
          "content-type": "application/json",
        },
        body: JSON.stringify({ kind: "user", body: "hi" }),
      })
    ).status,
  ).toBe(403);
});
it("forwards only cookie to exact server ownership endpoint", async () => {
  let called = "";
  let cookie = "";
  const a = createProtectedApp(cfg, router, async (url, init) => {
    called = String(url);
    cookie = new Headers(init?.headers).get("cookie")!;
    return Response.json({ mission: { id: "m" } });
  });
  expect(
    (await a.request("/agents/humanos/m", { headers: { cookie: "sid=abc" } }))
      .status,
  ).toBe(202);
  expect(called).toBe("http://localhost:3001/api/internal/conversations/m");
  expect(cookie).toBe("sid=abc");
});
it("fails closed when ownership service unavailable", async () => {
  const a = createProtectedApp(cfg, router, async () => {
    throw new Error("offline");
  });
  expect(
    (await a.request("/agents/humanos/m", { headers: { cookie: "sid=abc" } }))
      .status,
  ).toBe(503);
});
it("mounts prepare only for active unexpired authorized mission", () => {
  expect(
    canPrepareMission({
      state: "RUNNING",
      agentEns: "a.eth",
      expiresAt: "2099-01-01T00:00:00.000Z",
    }),
  ).toBe(true);
  for (const state of [
    "REVOKED",
    "EXPIRED",
    "AWAITING_APPROVAL",
    "COMPLETED",
    "DRAFT",
  ])
    expect(
      canPrepareMission({
        state,
        agentEns: "a.eth",
        expiresAt: "2099-01-01T00:00:00.000Z",
      }),
    ).toBe(false);
  expect(
    canPrepareMission({
      state: "RUNNING",
      agentEns: "a.eth",
      expiresAt: "2020-01-01T00:00:00.000Z",
    }),
  ).toBe(false);
});
it("prepares only captured mission through protected API, propagates denial", async () => {
  let target = "";
  let auth = "";
  await prepareNextAction("m", cfg, async (url, init) => {
    target = String(url);
    auth = new Headers(init?.headers).get("authorization")!;
    return Response.json({ mission: { id: "m" } });
  });
  expect(target).toBe("http://localhost:3001/api/internal/missions/m/prepare");
  expect(auth).toBe("Bearer test-secret");
  await expect(
    prepareNextAction("m", cfg, async () => new Response("", { status: 403 })),
  ).rejects.toThrow();
});
it("registers exact current DeepSeek model and excludes retired alias", async () => {
  const { humanOSDeepSeekProvider } = await import("../src/provider.js");
  expect(
    humanOSDeepSeekProvider()
      .getModels()
      .map((m) => m.id),
  ).toEqual(["deepseek-flash"]);
});
it("rejects initialData even on abort surface", async () => {
  const response = await app().request("/agents/humanos/m/abort", {
    method: "POST",
    headers: { cookie: "sid=abc", "content-type": "application/json" },
    body: JSON.stringify({ initialData: { id: "other" } }),
  });
  expect(response.status).toBe(400);
});
