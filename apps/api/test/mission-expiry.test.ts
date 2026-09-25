import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, expect, it, vi } from "vitest";
import { Database } from "@humanos/database";
import { hashCanonical } from "@humanos/schemas";
import { createApi } from "../src/app.js";
import { ModelUnavailableError } from "@humanos/models";

const db = new Database(
  process.env.TEST_DATABASE_URL ??
    "postgresql://saikarthik@127.0.0.1:55432/humanos",
  { schema: `expiry_${randomUUID().replaceAll("-", "")}` },
);
const token = randomUUID();
const goal = "Draft a Japan itinerary without booking anything";
const proposal = vi.fn(async () => ({
  goal,
  title: "Japan itinerary",
  capabilities: ["drafts.write" as const],
  steps: ["Write a draft"],
  expiresAt: "2026-05-16T00:00:00Z",
}));
const app = createApi({
  db,
  origin: "http://localhost:5173",
  models: {
    proposeMission: proposal,
    proposeNextAction: async () => {
      throw new Error("not used");
    },
    evaluate: async () => {
      throw new Error("not used");
    },
  },
});
beforeAll(async () => {
  await db.migrate();
  const stamp = new Date().toISOString();
  const rootId = randomUUID();
  const address = "0x1111111111111111111111111111111111111111";
  const accountId = `11155111:${address}`;
  await db.insert("accounts", {
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
    rootId,
    accountId,
    createdAt: stamp,
  });
  await db.insert("sessions", {
    id: hashCanonical(token),
    rootId,
    accountId,
    expiresAt: new Date(Date.now() + 3600000).toISOString(),
  });
});
afterAll(() => db.close());
const request = (body: unknown) =>
  app.request("/api/missions", {
    method: "POST",
    headers: {
      origin: "http://localhost:5173",
      cookie: `humanos_session=${token}`,
      "content-type": "application/json",
    },
    body: JSON.stringify(body),
  });

it("explains model credit failures without leaking provider bodies", async () => {
  proposal.mockRejectedValueOnce(
    new ModelUnavailableError("MODEL_CREDITS_REQUIRED"),
  );
  const response = await request({ goal });
  expect(response.status).toBe(503);
  expect((await response.json()).error).toMatchObject({
    code: "MODEL_CREDITS_REQUIRED",
    message:
      "The model provider needs credits. Top up the configured provider account, then retry.",
  });
});

it("uses a bounded server deadline instead of a hallucinated model expiry", async () => {
  const before = Date.now();
  const response = await request({ goal });
  expect(response.status).toBe(201);
  const { mission } = await response.json();
  expect(Date.parse(mission.expiresAt)).toBeGreaterThanOrEqual(
    before + 3600000,
  );
  expect(Date.parse(mission.expiresAt)).toBeLessThanOrEqual(
    Date.now() + 3600000,
  );
  expect(
    (await db.get<{ expiresAt: string }>("missions", mission.id))?.expiresAt,
  ).toBe(mission.expiresAt);
});

it("preserves an explicit valid deadline", async () => {
  const expiresAt = new Date(Date.now() + 600000).toISOString();
  const response = await request({ goal, expiresAt });
  expect(response.status).toBe(201);
  expect((await response.json()).mission.expiresAt).toBe(expiresAt);
});

it.each([-60000, 86400000 + 60000])(
  "rejects invalid explicit deadlines before paying for a model call (%s)",
  async (offset) => {
    proposal.mockClear();
    const response = await request({
      goal,
      expiresAt: new Date(Date.now() + offset).toISOString(),
    });
    expect(response.status).toBe(400);
    expect(proposal).not.toHaveBeenCalled();
  },
);
