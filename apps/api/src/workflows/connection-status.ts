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

const BROWSER_USE_DISCLOSURE = "The browser runs on this computer in a dedicated HumanOS profile (never your everyday browser). Sanitized page text and option labels are sent to the configured Jev evaluator to choose among options; local execution is not local inference.";
/**
 * Browser Use worker status. Never "connected" from configuration alone: it also needs an
 * inspected production site policy and a worker that actually reported ready.
 */
export function describeBrowserUse(input: {
  enabled: boolean; configured: { python: boolean; profileRoot: boolean; chromium: boolean };
  siteLabels: readonly string[]; workerVerified: boolean; authority: "account" | "ens";
}): BrowserConnectionStatus {
  if (!input.enabled) return { status: "disabled", detail: "The local Browser Use worker is off. Booking steps pause without opening a page.",
    setup: "Set HUMANOS_BROWSER_DRIVER=browser-use with HUMANOS_BROWSER_WORKER_PYTHON, HUMANOS_BROWSER_PROFILE_DIR and HUMANOS_BROWSER_CHROMIUM on the server." };
  const missing = [
    ...(!input.configured.python ? ["HUMANOS_BROWSER_WORKER_PYTHON"] : []),
    ...(!input.configured.profileRoot ? ["HUMANOS_BROWSER_PROFILE_DIR"] : []),
    ...(!input.configured.chromium ? ["HUMANOS_BROWSER_CHROMIUM"] : []),
  ];
  if (missing.length) return { status: "setup_required", detail: `The Browser Use runtime is not configured. ${BROWSER_USE_DISCLOSURE}`,
    setup: `Set ${missing.join(", ")} in the private server environment (run \`uv sync\` in apps/browser-worker), then restart the API.` };
  if (!input.siteLabels.length) return { status: "setup_required", detail: `No booking site has been inspected and installed, so no site can be opened. ${BROWSER_USE_DISCLOSURE}`,
    setup: "Choose one restaurant booking site. Its preparation, terms, submission and confirmation must be inspected and added as a site policy." };
  if (!input.workerVerified) return { status: "setup_required", detail: `Sites: ${input.siteLabels.join(", ")}. The worker has not reported ready yet. ${BROWSER_USE_DISCLOSURE}`,
    setup: "Start a booking preparation to open the HumanOS browser and sign in to the site there." };
  return { status: "connected", detail: `Sites: ${input.siteLabels.join(", ")}. Authority: ${input.authority === "ens" ? "ENS-bound workflow agent" : "your account session only"}. Every booking stops for your exact final confirmation. ${BROWSER_USE_DISCLOSURE}`, setup: null };
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
