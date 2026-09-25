import { serve } from "@hono/node-server";
import { createDemoService } from "./app.js";
const databaseUrl = process.env.DATABASE_URL;
const secret = process.env.DEMO_SERVICE_SECRET;
if (!databaseUrl || !secret)
  throw new Error("DATABASE_URL and DEMO_SERVICE_SECRET required");
const { app } = await createDemoService({ databaseUrl, secret });
serve({
  fetch: app.fetch,
  port: Number(process.env.PORT ?? 3003),
  hostname: process.env.HOST ?? "127.0.0.1",
});
