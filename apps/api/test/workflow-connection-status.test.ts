import { expect, it } from "vitest";
import * as v from "valibot";
import { WorkflowConnectionsResponseSchema } from "@humanos/schemas";
import { ConnectorRegistry, createBraveSearchAdapter, createResendEmailAdapter } from "../src/workflows/connectors.js";
import { describeWorkflowConnections, connectorSetupFromEnv, describeBrowser } from "../src/workflows/connection-status.js";

it("reports the browser as connected only with the driver enabled and an audited site installed", () => {
  expect(describeBrowser(false, ["Site"]).status).toBe("disabled");
  expect(describeBrowser(true, [])).toMatchObject({ status: "setup_required" });
  expect(describeBrowser(true, [])?.setup).toContain("audited recipe");
  expect(describeBrowser(true, ["Reserve a table"])).toMatchObject({ status: "connected", setup: null });
});

const owner = "11155111:0x1111111111111111111111111111111111111111";
const other = "11155111:0x2222222222222222222222222222222222222222";
function registryFor(env: Record<string, string | undefined>) {
  const bound = env.CONNECTOR_ACCOUNT_ID?.toLowerCase();
  const registry = new ConnectorRegistry();
  registry.register(createBraveSearchAdapter({ credentials: async id => bound === id.toLowerCase() && env.BRAVE_SEARCH_API_KEY ? { apiKey: env.BRAVE_SEARCH_API_KEY } : null }));
  registry.register(createResendEmailAdapter({ credentials: async id => bound === id.toLowerCase() && env.RESEND_API_KEY && env.RESEND_FROM_EMAIL ? { apiKey: env.RESEND_API_KEY, from: env.RESEND_FROM_EMAIL } : null }));
  return registry;
}
const browserDisabled = { status: "disabled" as const, detail: "Browser workflows are off.", setup: "Enable the local browser driver." };

it("reports connected only for the bound account and never returns credentials", async () => {
  const env = { CONNECTOR_ACCOUNT_ID: owner, BRAVE_SEARCH_API_KEY: "brave-secret-value", RESEND_API_KEY: "resend-secret-value", RESEND_FROM_EMAIL: "sender@example.org" };
  const mine = await describeWorkflowConnections({ accountId: owner, registry: registryFor(env), setup: connectorSetupFromEnv(env), models: true, browser: browserDisabled });
  v.parse(WorkflowConnectionsResponseSchema, mine);
  expect(mine.connections.find(c => c.id === "brave")).toMatchObject({ status: "connected", capabilities: ["web.search"] });
  expect(mine.connections.find(c => c.id === "resend")).toMatchObject({ status: "connected", publicIdentity: "sender@example.org", capabilities: ["email.send"] });
  expect(JSON.stringify(mine)).not.toMatch(/secret-value/);
  const theirs = await describeWorkflowConnections({ accountId: other, registry: registryFor(env), setup: connectorSetupFromEnv(env), models: true, browser: browserDisabled });
  expect(theirs.connections.find(c => c.id === "brave")?.status).toBe("not_connected");
  expect(theirs.connections.find(c => c.id === "resend")).toMatchObject({ status: "not_connected", publicIdentity: null });
  expect(theirs.connections.find(c => c.id === "resend")?.setup).toContain(other);
});

it("shows setup requirements instead of fake connected state when server credentials are absent", async () => {
  const env = { CONNECTOR_ACCOUNT_ID: owner, RESEND_API_KEY: "resend-secret-value" };
  const result = await describeWorkflowConnections({ accountId: owner, registry: registryFor(env), setup: connectorSetupFromEnv(env), models: true, browser: browserDisabled });
  expect(result.connections.find(c => c.id === "brave")).toMatchObject({ status: "setup_required" });
  expect(result.connections.find(c => c.id === "brave")?.setup).toContain("BRAVE_SEARCH_API_KEY");
  const email = result.connections.find(c => c.id === "resend")!;
  expect(email.status).toBe("setup_required");
  expect(email.setup).toContain("RESEND_FROM_EMAIL");
  expect(email.setup).not.toContain("resend-secret-value");
  expect(result.connections.find(c => c.id === "browser")).toMatchObject({ status: "disabled", kind: "browser" });
  expect(result.connections.find(c => c.id === "opencode")).toMatchObject({ status: "connected", kind: "model" });
});
