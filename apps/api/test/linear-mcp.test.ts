import { beforeAll, afterAll, expect, it } from "vitest";
import { Database, createMcpStore } from "@humanos/database";
import { ConnectorRegistry } from "../src/workflows/connectors.js";
import { createDefaultCatalog } from "@humanos/workflows";
import * as v from "valibot";
import { createLinearService } from "../src/workflows/mcp/linear.js";
const db = new Database(process.env.TEST_DATABASE_URL!, { schema: `test_linear_${Date.now()}` });
beforeAll(() => db.migrate()); afterAll(() => db.close());
function fixture(failRead = false) {
  let writes = 0;
  const service = createLinearService({ store: createMcpStore(db), token: account => account === "alice" ? "fixture-token" : null,
    session: async () => ({ close: async () => {}, call: async (name: string, args: Record<string, unknown>) => {
      if (name === "get_workspace") return { id: "workspace", name: "Fixture", url: "https://linear.app/fixture" };
      if (name === "list_teams") return { teams: [{ id: "team", name: "Team" }], hasNextPage: false };
      if (name === "save_issue") { writes++; expect(Object.keys(args).sort()).toEqual(["description", "team", "title"]); return { id: "ISS-1" }; }
      if (failRead) throw new Error("unavailable");
      return { id: "ISS-1", title: "Demo", description: "Body", teamId: "team", url: "https://linear.app/fixture/issue/ISS-1/demo" };
    } }),
  });
  return { service, writes: () => writes };
}
it("uses only explicit create arguments, confirms binding and reads back before success", async () => {
  const {service,writes} = fixture();
  await service.select("alice", "team");
  const a = service.adapter;
  const registry = new ConnectorRegistry(); registry.register(a);
  const binding = (await a.binding!("alice", "linear.issue.create"))!;
  const request = { accountId: "alice", operationId: "linear.issue.create", binding, idempotencyKey: "once", signal: new AbortController().signal, authorize: async () => true,
    input: { connectorId: "linear", operationId: "linear.issue.create", arguments: { title: "Demo", body: "Body" } } };
  const result = await a.execute(request);
  expect(result.output).toMatchObject({ provider: "linear", id: "ISS-1", verified: true });
  expect(() => v.parse(createDefaultCatalog().get("connector.call").output, result.output)).not.toThrow();
  expect((await a.execute(request)).providerReference).toBe("ISS-1"); expect(writes()).toBe(1);
  await expect(a.execute({ ...request, accountId: "bob" })).rejects.toThrow();
  await service.disconnect("alice");
  await expect(a.execute({ ...request, idempotencyKey: "revoked" })).rejects.toThrow(); expect(writes()).toBe(1);
});
it("rechecks full workflow authorization after session setup", async () => {
  const {service,writes} = fixture(); await service.select("alice", "team");
  const a = service.adapter;
  await expect(a.execute({ accountId: "alice", operationId: "linear.issue.create", binding: (await a.binding!("alice", "linear.issue.create"))!, idempotencyKey: "expired", signal: new AbortController().signal,
    authorize: async () => false,
    input: { connectorId: "linear", operationId: "linear.issue.create", arguments: { title: "Demo", body: "Body" } } })).rejects.toThrow("AUTHORIZATION");
  expect(writes()).toBe(0);
});
it("never repeats creation when read-back fails", async () => {
  const {service,writes} = fixture(true); await service.select("alice", "team");
  const a = service.adapter;
  const request = { accountId: "alice", operationId: "linear.issue.create", binding: (await a.binding!("alice", "linear.issue.create"))!, idempotencyKey: "unknown", signal: new AbortController().signal, authorize: async () => true,
    input: { connectorId: "linear", operationId: "linear.issue.create", arguments: { title: "Demo", body: "Body" } } };
  await expect(a.execute(request)).rejects.toThrow("UNKNOWN_OUTCOME");
  await expect(a.execute(request)).rejects.toThrow("UNKNOWN_OUTCOME"); expect(writes()).toBe(1);
});
