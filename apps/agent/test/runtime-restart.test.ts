import { afterAll, beforeAll, expect, it } from "vitest";
import { Pool } from "pg";
import {
  fauxProvider,
  fauxAssistantMessage,
  fauxText,
} from "@earendil-works/pi-ai";
import { init, useModel } from "@flue/runtime";
import { start } from "@flue/runtime/node";
import { createPersistence } from "../src/persistence.js";
const connectionString =
  process.env.TEST_DATABASE_URL ??
  "postgresql://saikarthik@127.0.0.1:55432/humanos";
const schema = "flue_runtime_" + Date.now();
const admin = new Pool({ connectionString });
beforeAll(async () => {
  await admin.query(`CREATE SCHEMA "${schema}"`);
});
afterAll(async () => {
  await admin.query(`DROP SCHEMA "${schema}" CASCADE`);
  await admin.end();
});
// Fixture transport is test-only. This verifies Flue/PG recovery, not live DeepSeek.
function RecoveryFixture() {
  useModel("faux/model");
  return "Reply briefly.";
}
it("reopens an accepted settled receipt through the real Flue runtime after restart", async () => {
  const firstModel = fauxProvider({ models: [{ id: "model" }] });
  firstModel.setResponses([
    fauxAssistantMessage([fauxText("Durable first response")], {
      stopReason: "stop",
    }),
  ]);
  const first = await start({
    agents: [RecoveryFixture],
    db: createPersistence(connectionString, schema),
    providers: [firstModel.provider],
    env: {},
  });
  let receipt;
  try {
    const handle = init(RecoveryFixture, { id: "mission-runtime" });
    receipt = await handle.dispatch("First request");
    expect((await handle.read(receipt)).text).toBe("Durable first response");
  } finally {
    await first.stop();
  }
  const secondModel = fauxProvider({ models: [{ id: "model" }] });
  secondModel.setResponses([
    fauxAssistantMessage([fauxText("After restart")], { stopReason: "stop" }),
  ]);
  const second = await start({
    agents: [RecoveryFixture],
    db: createPersistence(connectionString, schema),
    providers: [secondModel.provider],
    env: {},
  });
  try {
    const handle = init(RecoveryFixture, { id: "mission-runtime" });
    expect((await handle.read(receipt!)).text).toBe("Durable first response");
    expect((await handle.read(await handle.dispatch("Continue"))).text).toBe(
      "After restart",
    );
  } finally {
    await second.stop();
  }
});
