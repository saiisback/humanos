import { beforeAll, afterAll, expect, it } from "vitest";
import { Database } from "../src/index.js";
import { createMcpStore } from "../src/mcp.js";
const db = new Database(process.env.TEST_DATABASE_URL!, { schema: `test_mcp_${Date.now()}` });
beforeAll(() => db.migrate());
afterAll(() => db.close());
it("claims a write once across concurrent workers and isolates accounts", async () => {
  const s = createMcpStore(db);
  const results = await Promise.all([s.claim("alice", "key", "hash"), s.claim("alice", "key", "hash")]);
  expect(results.filter(Boolean)).toHaveLength(1);
  expect(await s.get("bob", "key")).toBeNull();
  await expect(s.claim("alice", "key", "different")).rejects.toThrow("IDEMPOTENCY_CONFLICT");
  await s.recordId("alice", "key", "id-1");
  expect(await s.get("alice", "key")).toMatchObject({ requestHash: "hash", objectId: "id-1" });
  expect(await s.claim("alice", "key", "hash")).toBe(false);
  await expect(s.recordId("alice", "key", "id-2")).rejects.toThrow();
});
it("versions selected destinations and makes disconnected bindings unavailable", async () => {
  const s = createMcpStore(db);
  expect(await s.connection("alice", "linear")).toBeNull();
  const c = await s.select("alice", "linear", { workspaceId: "w", workspaceName: "Workspace", destinationId: "t", destinationName: "Team", credentialHash: "key-version" });
  expect(c.version).toBe(1);
  expect(await s.connection("bob", "linear")).toBeNull();
  await s.disconnect("alice", "linear");
  expect(await s.connection("alice", "linear")).toMatchObject({ status: "revoked", version: 2 });
  const next = await s.select("alice", "linear", { workspaceId: "w", workspaceName: "Workspace", destinationId: "t", destinationName: "Team", credentialHash: "key-version" });
  expect(next.version).toBe(3);
});
