import * as v from "valibot";
import { WorkflowConnectionsResponseSchema, type WorkflowConnection, type WorkflowConnectionsResponse } from "@humanos/schemas";
import type { ConnectorRegistry } from "./connectors.js";

export interface ConnectorSetup {
  /** True when the server holds credentials; says nothing about which account they belong to. */
  configured: boolean;
  detail: string;
  requirement: string;
}
export interface BrowserConnectionStatus {
  status: "connected" | "setup_required" | "disabled";
  detail: string;
  setup: string | null;
}

/** Setup text names environment variables only; values are never read into the response. */
export function connectorSetupFromEnv(env: Record<string, string | undefined>): Record<string, ConnectorSetup> {
  const present = (name: string) => !!env[name]?.trim();
  return {
    brave: {
      configured: present("BRAVE_SEARCH_API_KEY") && present("CONNECTOR_ACCOUNT_ID"),
      detail: "Real web search for research steps. Results are sources to read, not verified availability.",
      requirement: "Set BRAVE_SEARCH_API_KEY and CONNECTOR_ACCOUNT_ID in the private server environment, then restart the API.",
    },
    resend: {
      configured: present("RESEND_API_KEY") && present("RESEND_FROM_EMAIL") && present("CONNECTOR_ACCOUNT_ID"),
      detail: "Sends one email per confirmed step from the sender shown here. Every send needs your exact final confirmation.",
      requirement: "Set RESEND_API_KEY, a Resend-authorized RESEND_FROM_EMAIL, and CONNECTOR_ACCOUNT_ID in the private server environment, then restart the API.",
    },
  };
}

export function describeBrowser(driverEnabled: boolean, recipeLabels: readonly string[]): BrowserConnectionStatus {
  if (!driverEnabled) return {
    status: "disabled",
    detail: "HumanOS does not drive a browser on this server. Browser steps pause without opening a page.",
    setup: "Set HUMANOS_BROWSER_DRIVER=local-chromium (and optionally HUMANOS_BROWSER_PROFILE_DIR for a dedicated HumanOS profile) on the server. Your everyday browser is never used.",
  };
  if (!recipeLabels.length) return {
    status: "setup_required",
    detail: "The local browser driver is on, but no audited site is installed, so no site can be opened.",
    setup: "Choose a site to support. Its form fields, value, and success page must be reviewed and added as an audited recipe before HumanOS can fill or submit it.",
  };
  return {
    status: "connected",
    detail: `Audited sites: ${recipeLabels.join(", ")}. Every submission stops for your exact final confirmation.`,
    setup: null,
  };
}
export async function describeWorkflowConnections(input: {
  accountId: string;
  registry: ConnectorRegistry;
  setup: Record<string, ConnectorSetup>;
  models: boolean;
  browser: BrowserConnectionStatus;
}): Promise<WorkflowConnectionsResponse> {
  const connections: WorkflowConnection[] = [{
    id: "opencode", label: "Jev + DeepSeek (OpenCode)", kind: "model", capabilities: [],
    status: input.models ? "connected" : "setup_required",
    detail: "Jev selects audited workflow steps; DeepSeek writes content only. Neither can authorize an action.",
    setup: input.models ? null : "Set OPENCODE_API_KEY in the private server environment.",
    publicIdentity: null,
  }];
  for (const adapter of input.registry.list()) {
    const setup = input.setup[adapter.id];
    const operation = adapter.operations[0]!;
    const connected = (await Promise.all(adapter.operations.map(op => adapter.connection(input.accountId, op.id))))
      .every(status => status.status === "connected");
    const binding = connected ? await adapter.binding?.(input.accountId, operation.id) : null;
    const sender = binding && typeof binding.sender === "string" ? binding.sender : null;
    connections.push({
      id: adapter.id, label: adapter.label, kind: "connector",
      capabilities: [...new Set(adapter.operations.map(op => op.capability))],
      status: connected ? "connected" : setup?.configured ? "not_connected" : "setup_required",
      detail: setup?.detail ?? adapter.operations.map(op => op.summary).join(", "),
      setup: connected ? null : setup?.configured
        ? `Server credentials are not bound to this account. Set CONNECTOR_ACCOUNT_ID to ${input.accountId} on the server to use them.`
        : setup?.requirement ?? "This service needs server configuration.",
      publicIdentity: sender,
    });
  }
  connections.push({
    id: "browser", label: "Local browser (audited sites)", kind: "browser",
    capabilities: ["form.save", "application.submit"],
    status: input.browser.status, detail: input.browser.detail, setup: input.browser.setup, publicIdentity: null,
  });
  return v.parse(WorkflowConnectionsResponseSchema, { accountId: input.accountId, connections });
}
