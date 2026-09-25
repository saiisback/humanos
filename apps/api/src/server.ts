import { serve } from "@hono/node-server";
import { Database } from "@humanos/database";
import { createWorldVerifier } from "@humanos/world";
import { createDeepSeekClient, createJevClient } from "@humanos/models";
import { createSideEffectClient } from "@humanos/tools";
import { createApi, type ApiConfig } from "./app.js";
import {
  createEnsAdapterFromEnv,
  createPostgresTransactionJournal,
  initializeEnsTransactionJournal,
} from "@humanos/ens";
import { createEnsReceiptPublisher } from "./ens-receipts.js";
import { createSepoliaSiweVerifier } from "./services/siwe.js";
const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) throw new Error("DATABASE_URL required");
const db = new Database(databaseUrl);
await db.migrate();
const config: ApiConfig = {
  db,
  origin: process.env.WEB_ORIGIN ?? "http://localhost:5173",
};
if (process.env.SEPOLIA_RPC_URL)
  config.siweVerifier = createSepoliaSiweVerifier(process.env.SEPOLIA_RPC_URL);
if (
  process.env.WORLD_APP_ID &&
  process.env.WORLD_RP_ID &&
  process.env.WORLD_SIGNING_KEY
)
  config.world = createWorldVerifier({
    appId: process.env.WORLD_APP_ID,
    rpId: process.env.WORLD_RP_ID,
    signingKey: process.env.WORLD_SIGNING_KEY,
    environment:
      process.env.WORLD_ENVIRONMENT === "staging" ? "staging" : "production",
  });
if (process.env.DEEPSEEK_API_KEY && process.env.JEV_API_KEY) {
  const deepseek = createDeepSeekClient({
    apiKey: process.env.DEEPSEEK_API_KEY,
  });
  const jev = createJevClient({ apiKey: process.env.JEV_API_KEY });
  config.models = {
    proposeMission: deepseek.proposeMission,
    proposeNextAction: deepseek.proposeNextAction,
    evaluate: jev.evaluateAction,
  };
}
if (process.env.DEMO_SERVICE_URL && process.env.DEMO_SERVICE_SECRET)
  config.effect = createSideEffectClient({
    baseUrl: process.env.DEMO_SERVICE_URL,
    secret: process.env.DEMO_SERVICE_SECRET,
    ...(process.env.DEMO_SERVICE_ALLOW_HTTP_HOST
      ? { allowHttpHost: process.env.DEMO_SERVICE_ALLOW_HTTP_HOST }
      : {}),
  });
if (process.env.FLUE_URL && process.env.DEEPSEEK_API_KEY)
  config.flueUrl = process.env.FLUE_URL;
if (process.env.FLUE_INTERNAL_SECRET)
  config.internalSecret = process.env.FLUE_INTERNAL_SECRET;
if (
  process.env.SEPOLIA_RPC_URL &&
  process.env.ENS_REGISTRAR_ADDRESS &&
  process.env.ENS_OPERATOR_PRIVATE_KEY &&
  process.env.ENS_AGENT_KEY_SEED
) {
  // Separate pool: execution holds mission/action locks in the primary pool.
  const ensDb = new Database(databaseUrl);
  await initializeEnsTransactionJournal(ensDb);
  const ens = createEnsAdapterFromEnv(
    process.env,
    createPostgresTransactionJournal(ensDb),
  );
  config.ens = ens;
  config.updateEnsReceipt = createEnsReceiptPublisher({
    db: ensDb,
    ensAdapter: ens,
  });
}
const app = createApi(config);
serve({
  fetch: app.fetch,
  port: Number(process.env.PORT ?? 3001),
  hostname: process.env.HOST ?? "127.0.0.1",
});
