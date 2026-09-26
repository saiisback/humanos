import { Database, WorkflowStore, WorkflowAgentStore, type SessionRecord } from "@humanos/database";
import type { WorkflowEnsPort } from "@humanos/ens";
import { createBrowserActionSelector, createContentGenerator, createWorkflowSelector } from "@humanos/models";
import { createDefaultCatalog } from "@humanos/workflows";
import { hashCanonical, type Workflow, type WorkflowVersion, type WorkflowRun, type WorkflowNode } from "@humanos/schemas";
import * as v from "valibot";
import { createWorkflowService } from "./service.js";
import { createWorkflowRunner, WorkflowPause, WorkflowExecutionError } from "./runner.js";
import { createWorkflowConfirmations } from "./confirmations.js";
import { ConnectorRegistry, createBraveSearchAdapter, createResendEmailAdapter, routeExternalStep, dispatchConnectorStep } from "./connectors.js";
import { boundedIntentSelector, workflowInputs, classifyWorkflowGoal } from "./bindings.js";
import { describeWorkflowConnections, connectorSetupFromEnv, describeBrowser } from "./connection-status.js";
import { createAuditedRecipeRegistry, createBrowserExecutor, createPlaywrightDriver } from "./browser.js";
import { createBrowserStep } from "./browser-step.js";
import { browserUseClientFactory } from "./browser-use-client.js";
import { createBrowserUsePolicyRegistry } from "./browser-use-policy.js";
import { browserUseDestination, createBrowserUseStep } from "./browser-use-step.js";
import type { StepExecutionContext, WorkflowExecutor } from "./types.js";
import type { WorkflowApi } from "./routes.js";
import { agentCapabilityFor, composeWorkflowAuthorizers, createWorkflowAgentAuthorizer, scheduleAuthorityCurrent } from "./agent-authorizer.js";
import { createWorkflowAgentReceipts } from "./agent-receipts.js";
import { createWorkflowAgentService } from "./agents.js";

export function createWorkflowAuthorizer(db: Database, store: WorkflowStore, registry: ReturnType<typeof createDefaultCatalog>, connectors: ConnectorRegistry) {
  return async (context: StepExecutionContext): Promise<boolean> => {
    if (context.signal.aborted || !context.run.executionSessionId) return false;
    const current = await store.get<WorkflowRun>("workflow_runs", context.run.id);
    if (!current || current.status !== "RUNNING" || current.revision !== context.run.revision ||
        current.leaseOwner !== context.run.leaseOwner || !current.leaseOwner ||
        !current.leaseExpiresAt || Date.parse(current.leaseExpiresAt) <= Date.now() ||
        current.executionSessionId !== context.run.executionSessionId || context.signal.aborted) return false;
    const session = await db.get<SessionRecord>("sessions", current.executionSessionId);
    if (!session || session.accountId !== context.actor.accountId || Date.parse(session.expiresAt) <= Date.now() || context.signal.aborted) return false;
    const workflow = await store.get<Workflow>("workflows", context.run.workflowId);
    const version = await store.get<WorkflowVersion>("workflow_versions", context.run.workflowVersionId);
    if (!workflow || workflow.accountId !== context.actor.accountId || workflow.rootId !== session.rootId ||
        workflow.status !== "ACTIVE" || !version?.activatedAt ||
        version.graphHash !== hashCanonical(context.version.graph) ||
        !await db.get("accounts", context.actor.accountId)) return false;
    // Mission-bound actions retain the existing ENS/JAW execution boundary.
    if (workflow.missionId) return false;
    const operation = connectors.resolve(context)?.operation;
    const capability = operation?.capability ?? registry.get(context.node.type).capability;
    return (!capability || version.requiredCapabilities.includes(capability)) && !context.signal.aborted;
  };
}
import { createWorkflowScheduler } from "./scheduler.js";

export function createWorkflowRuntime(db: Database, env: NodeJS.ProcessEnv, options: { ens?: WorkflowEnsPort | null } = {}): WorkflowApi & { start(signal: AbortSignal): Promise<void> } {
  const store = new WorkflowStore(db), registry = createDefaultCatalog(), connectors = new ConnectorRegistry();
  const agentStore = new WorkflowAgentStore(db), ens = options.ens ?? null;
  const owner = env.CONNECTOR_ACCOUNT_ID?.toLowerCase();
  connectors.register(createBraveSearchAdapter({ credentials: async accountId => owner === accountId.toLowerCase() && env.BRAVE_SEARCH_API_KEY ? { apiKey: env.BRAVE_SEARCH_API_KEY } : null }));
  connectors.register(createResendEmailAdapter({ credentials: async accountId => owner === accountId.toLowerCase() && env.RESEND_API_KEY && env.RESEND_FROM_EMAIL ? { apiKey: env.RESEND_API_KEY, from: env.RESEND_FROM_EMAIL } : null }));
  const capabilityForNode = (node: WorkflowNode) => node.type === "connector.call" ? connectors.get(String(node.input.connectorId), String(node.input.operationId))?.operation.capability ?? null : node.capability;
  // ENS-pinned runs need both the account/lease boundary and live agent authority; neither substitutes for the other.
  const authorize = composeWorkflowAuthorizers(createWorkflowAuthorizer(db, store, registry, connectors),
    createWorkflowAgentAuthorizer({ db, ens, capabilityFor: agentCapabilityFor(registry, capabilityForNode) }));
  // Opt-in local driver; a dedicated HumanOS profile, never the user's everyday browser.
  const driverEnabled = env.HUMANOS_BROWSER_DRIVER === "local-chromium";
  const recipes = createAuditedRecipeRegistry();
  const browserExecutor = driverEnabled ? createBrowserExecutor({ recipes, driver: createPlaywrightDriver({
    ...(env.HUMANOS_BROWSER_PROFILE_DIR?.trim() ? { profileDir: env.HUMANOS_BROWSER_PROFILE_DIR.trim() } : {}),
    headless: env.HUMANOS_BROWSER_HEADLESS !== "false",
  }) }) : null;
  let browser: ReturnType<typeof createBrowserStep> | null = null;
  // Opt-in local Browser Use worker; disabled unless explicitly selected and configured.
  const browserUseClients = browserUseClientFactory(env);
  const browserUsePolicies = createBrowserUsePolicyRegistry();
  let browserUse: ReturnType<typeof createBrowserUseStep> | null = null;
  const isBrowserUse = (context: StepExecutionContext) => browserUseDestination.test(String(context.input.destination));
  const confirmations = createWorkflowConfirmations({ store,
    requiresConfirmation: type => registry.get(type).requiresConfirmation,
    prepare: async context => {
      if (context.node.type === "browser.submit") return isBrowserUse(context) ? browserUse!.prepare(context) : browser!.prepare(context);
      const route = await routeExternalStep(context, { registry: connectors, authorize });
      if (route.kind === "revoked") throw new WorkflowExecutionError("AUTHORIZATION");
      if (route.kind !== "connector") throw new WorkflowPause("CONNECTION_REQUIRED", route.kind === "connection_required" ? `Connect ${route.label} with ${route.scopes.join(", ")} before preparing this action.` : "Connect an approved service for this action.");
      const { adapter, operation } = connectors.resolve(context)!;
      const payload = v.parse(operation.input, context.input) as StepExecutionContext["input"];
      const binding = await adapter.binding!(context.actor.accountId, operation.id) ?? {};
      return { destination: operation.destination(payload), payload, binding };
    },
  });
  browser = createBrowserStep({ executor: browserExecutor, recipes, authorize, confirmations });
  // Jev evaluates only finite, sanitized candidates; DeepSeek stays content-only.
  browserUse = createBrowserUseStep({ client: browserUseClients, policies: browserUsePolicies, authorize, confirmations, store,
    selector: { select: input => createBrowserActionSelector(models).select(input) } });
  const browserSubmit: WorkflowExecutor = { execute: context => (isBrowserUse(context) ? browserUse! : browser!).executor.execute(context) };
  const external: WorkflowExecutor = { async execute(context) {
    const route = await routeExternalStep(context, { registry: connectors, authorize });
    if (route.kind === "revoked") throw new WorkflowExecutionError("AUTHORIZATION");
    if (route.kind !== "connector") throw new WorkflowPause("CONNECTION_REQUIRED", route.kind === "connection_required" ? `Connect ${route.label} with ${route.scopes.join(", ")} to continue.` : "An approved service or browser workflow is required. No external action was taken.");
    try {
      return await dispatchConnectorStep(context, route, { registry: connectors, authorize,
        confirmDispatch: async (exact, current) => {
          let approved = false;
          await confirmations.dispatchConfirmed(current, async () => { approved = true; return { output: {} }; },
            prepared => prepared.destination === exact.destination && hashCanonical(prepared.payload) === exact.inputHash &&
              hashCanonical(prepared.binding ?? {}) === hashCanonical(exact.binding));
          return approved;
        },
      });
    } catch (error) {
      if (error instanceof Error && error.message === "CONNECTION_REQUIRED") throw new WorkflowPause("CONNECTION_REQUIRED", "Reconnect the approved service before continuing.");
      if (error instanceof Error && error.message === "AUTHORIZATION_REVOKED") throw new WorkflowExecutionError("AUTHORIZATION");
      throw error;
    }
  } };
  const models = { apiKey: env.OPENCODE_API_KEY!.trim(), timeoutMs: 20000 };
  // One routing context for candidate filtering, assembly inputs and diagnostics.
  const routing = { recipes, browserEnabled: driverEnabled };
  const service = createWorkflowService({ db, store, registry, selector: boundedIntentSelector(createWorkflowSelector(models), routing), assemblyInput: async goal => workflowInputs(goal, routing),
    describeGoal: goal => { const intent = classifyWorkflowGoal(goal, routing); return { intent: intent.kind, plannedSteps: [...intent.blocks], ...(intent.recipeId ? { recipeId: intent.recipeId } : {}) }; },
    capabilityForNode,
  });
  const runner = createWorkflowRunner({ store, registry, content: createContentGenerator(models), workerId: `local-${process.pid}`, authorize, dispatchConfirmed: confirmations.probeApproved,
    executors: { "research.web": external, "connector.call": external, "application.submit": external, "calendar.create": external, "browser.submit": browserSubmit, "human.confirm": { execute: confirmations.confirmNode } },
  });
  const scheduler = createWorkflowScheduler({ store, registry, authorityCurrent: (schedule, now) => scheduleAuthorityCurrent(db, schedule, now, ens) });
  const agents = createWorkflowAgentService({ db, store, agentStore, ens, capabilityForNode });
  const receipts = ens ? createWorkflowAgentReceipts({ db, agentStore, ens }) : null;
  const connections = (actor: { accountId: string }) => describeWorkflowConnections({
    accountId: actor.accountId, registry: connectors, setup: connectorSetupFromEnv(env), models: !!env.OPENCODE_API_KEY?.trim(),
    browser: describeBrowser(driverEnabled, recipes.list().map(recipe => recipe.label)),
  });
  return { service, store, agents, confirmations, connections,
    ...(env.FLUE_URL && env.FLUE_INTERNAL_SECRET ? { flue: { url: env.FLUE_URL, secret: env.FLUE_INTERNAL_SECRET } } : {}),
    start: async signal => { await Promise.all([runner.start(signal), scheduler.start(signal), agents.recover(signal), ...(receipts ? [receipts.start(signal)] : [])]); } };
}
