import { randomUUID } from "node:crypto";
import { Hono } from "hono";
import { bodyLimit } from "hono/body-limit";
import { Pool } from "pg";
import { hashCanonical } from "@humanos/schemas";
import { verifyEnvelope } from "@humanos/tools";
export async function createDemoService(config: {
  databaseUrl: string;
  secret: string;
}) {
  if (config.secret.length < 32)
    throw new Error("DEMO_SERVICE_SECRET must be at least 32 characters");
  const pool = new Pool({ connectionString: config.databaseUrl });
  await pool.query(
    "CREATE TABLE IF NOT EXISTS humanos_effects (idempotency_key text PRIMARY KEY, payload_hash text NOT NULL, kind text NOT NULL, external_id text NOT NULL, payload jsonb NOT NULL, created_at timestamptz NOT NULL DEFAULT now())",
  );
  const app = new Hono();
  app.use("*", bodyLimit({ maxSize: 100000 }));
  app.get("/health", (c) => c.json({ status: "ok" }));
  app.post("/effects", async (c) => {
    const body = await c.req.json();
    if (
      !verifyEnvelope(
        body,
        c.req.header("x-humanos-authorization") ?? "",
        config.secret,
      )
    )
      return c.json({ error: "Unauthorized" }, 401);
    if (
      !body ||
      typeof body.idempotencyKey !== "string" ||
      body.idempotencyKey.length > 256 ||
      body.actionId !== body.idempotencyKey ||
      !["application", "calendar"].includes(body.kind) ||
      !body.payload ||
      hashCanonical(body.payload) !== body.payloadHash
    )
      return c.json({ error: "Invalid effect" }, 400);
    const externalId = randomUUID();
    await pool.query(
      "INSERT INTO humanos_effects(idempotency_key,payload_hash,kind,external_id,payload) VALUES($1,$2,$3,$4,$5) ON CONFLICT DO NOTHING",
      [
        body.idempotencyKey,
        body.payloadHash,
        body.kind,
        externalId,
        body.payload,
      ],
    );
    const row = (
      await pool.query(
        "SELECT * FROM humanos_effects WHERE idempotency_key=$1",
        [body.idempotencyKey],
      )
    ).rows[0];
    if (row.payload_hash !== body.payloadHash || row.kind !== body.kind)
      return c.json({ error: "Idempotency conflict" }, 409);
    return c.json({
      externalId: row.external_id,
      payloadHash: row.payload_hash,
      kind: row.kind,
    });
  });
  app.get("/receipts/:id", async (c) => {
    const auth = {
      idempotencyKey: c.req.param("id"),
      issuedAt: Number(c.req.header("x-humanos-issued-at")),
    };
    if (
      !verifyEnvelope(
        auth,
        c.req.header("x-humanos-authorization") ?? "",
        config.secret,
      )
    )
      return c.json({ error: "Unauthorized" }, 401);
    const row = (
      await pool.query(
        "SELECT external_id,payload_hash,kind FROM humanos_effects WHERE idempotency_key=$1",
        [auth.idempotencyKey],
      )
    ).rows[0];
    return row
      ? c.json({
          externalId: row.external_id,
          payloadHash: row.payload_hash,
          kind: row.kind,
        })
      : c.json({ error: "Not found" }, 404);
  });
  app.onError((_error, c) => c.json({ error: "Service unavailable" }, 503));
  return { app, close: () => pool.end() };
}
