import * as v from "valibot";
import {
  hashCanonical, WorkflowReceiptSchema,
  type BlockType, type Capability, type ErrorClass, type JsonValue, type WorkflowReceipt,
} from "@humanos/schemas";
import { createDefaultCatalog, type EffectClass } from "@humanos/workflows";
import { validateEffectResult, type EffectAction, type EffectResult } from "@humanos/tools";
import type { StepExecutionContext, StepExecutionResult } from "./types.js";
import { linearOperation } from "./mcp/operations.js";

export interface ConnectorOperation {
  readonly id: string;
  readonly blockType: BlockType;
  readonly capability: Capability;
  readonly effect: EffectClass;
  readonly scopes: readonly string[];
  readonly input: v.GenericSchema;
  readonly output: v.GenericSchema;
  readonly destination: (input: Record<string, JsonValue>) => string;
  readonly summary: string;
}
export interface ConnectorExecutionResult {
  readonly output: JsonValue;
  readonly providerReference: string | null;
}
export interface ConnectorExecutionInput {
  readonly accountId: string;
  readonly operationId: string;
  readonly input: Record<string, JsonValue>;
  /** Public identity material (e.g. email sender) the user confirmed; adapters must refuse on mismatch. */
  readonly binding: Record<string, JsonValue>;
  readonly idempotencyKey: string;
  readonly signal: AbortSignal;
  /** Final full workflow authority check, including account session and ENS state. */
  readonly authorize?: () => Promise<boolean>;
}
export interface ConnectorAdapter {
  readonly id: string;
  readonly label: string;
  readonly operations: readonly ConnectorOperation[];
  connection(accountId: string, operationId: string): Promise<{ status: "connected" | "missing" | "revoked" }>;
  /** Non-secret material the provider applies on the user's behalf and that the user must see before confirming. */
  binding?(accountId: string, operationId: string): Promise<Record<string, JsonValue> | null>;
  execute(input: ConnectorExecutionInput): Promise<ConnectorExecutionResult>;
  reconcile(input: ConnectorExecutionInput): Promise<ConnectorExecutionResult | null>;
}
export class ConnectorProviderError extends Error {
  constructor(readonly errorClass: ErrorClass) { super(errorClass); }
}
function providerStatusError(status: number, write: boolean): ConnectorProviderError {
  if (status === 401 || status === 403) return new ConnectorProviderError("AUTHORIZATION");
  if (status === 400 || status === 422) return new ConnectorProviderError("VALIDATION");
  if (status === 429) return new ConnectorProviderError("TRANSIENT");
  if (status === 408 || (write && status === 409)) return new ConnectorProviderError(write ? "UNKNOWN_OUTCOME" : "TRANSIENT");
  if (status >= 500) return new ConnectorProviderError(write ? "UNKNOWN_OUTCOME" : "TRANSIENT");
  return new ConnectorProviderError("REJECTION");
}
const catalog = createDefaultCatalog();
function assertAuditedOperation(adapter: ConnectorAdapter, operation: ConnectorOperation): void {
  if (operation.blockType === "connector.call") {
    if (adapter.id === "linear" && operation.id === linearOperation.id) {
      if (operation.capability !== linearOperation.capability || operation.effect !== linearOperation.effect || operation.input !== linearOperation.input || operation.output !== linearOperation.output) throw new Error("OPERATION_POLICY_MISMATCH");
      return;
    }
    if (adapter.id !== "resend" || operation.id !== "email.send" || operation.capability !== "email.send" ||
        operation.effect !== "irreversible_write" || operation.input !== emailInput || operation.output !== emailOutput)
      throw new Error("OPERATION_POLICY_MISMATCH");
    return;
  }
  let block;
  try { block = catalog.get(operation.blockType); }
  catch { throw new Error("OPERATION_POLICY_MISMATCH"); }
  if (operation.id !== block.type || operation.capability !== block.capability || operation.effect !== block.effect ||
      operation.input !== block.input || operation.output !== block.output || block.executor !== "connector")
    throw new Error("OPERATION_POLICY_MISMATCH");
}
type Registered = { adapter: ConnectorAdapter; operation: ConnectorOperation };
function auditedSnapshot(adapter: ConnectorAdapter): ConnectorAdapter {
  const operations = Object.freeze(adapter.operations.map((operation): ConnectorOperation => {
    const audited = operation.blockType === "connector.call"
      ? adapter.id === "linear" ? linearOperation : { input: emailInput, output: emailOutput }
      : catalog.get(operation.blockType);
    return Object.freeze({
      id: operation.id, blockType: operation.blockType, capability: operation.capability,
      effect: operation.effect, scopes: Object.freeze([...operation.scopes]),
      input: audited.input, output: audited.output, destination: operation.destination,
      summary: operation.summary,
    });
  }));
  const connection = adapter.connection;
  const binding = adapter.binding;
  const execute = adapter.execute;
  const reconcile = adapter.reconcile;
  return Object.freeze({
    id: adapter.id, label: adapter.label, operations,
    connection: (accountId: string, operationId: string) => connection(accountId, operationId),
    binding: async (accountId: string, operationId: string) => {
      const value = binding ? await binding(accountId, operationId) : null;
      return value ? Object.freeze(structuredClone(value)) : {};
    },
    execute: (input: ConnectorExecutionInput) => execute(input),
    reconcile: (input: ConnectorExecutionInput) => reconcile(input),
  });
}
export class ConnectorRegistry {
  private readonly adapters = new Map<string, ConnectorAdapter>();
  private readonly operations = new Map<string, Registered>();
  register(adapter: ConnectorAdapter): void {
    if (!/^[a-z][a-z0-9._-]{0,63}$/.test(adapter.id) || !adapter.label.trim() || adapter.label.length > 128) throw new Error("INVALID_CONNECTOR");
    if (this.adapters.has(adapter.id)) throw new Error("DUPLICATE_CONNECTOR");
    if (adapter.operations.length === 0) throw new Error("INVALID_CONNECTOR");
    const localOperations = new Set<string>();
    const localBlocks = new Set<BlockType>();
    for (const operation of adapter.operations) {
      if (!/^[a-z][a-z0-9._-]{0,63}$/.test(operation.id) || this.operations.has(operation.id) || localOperations.has(operation.id)) throw new Error("DUPLICATE_OPERATION");
      localOperations.add(operation.id);
      if (operation.blockType !== "connector.call") {
        if (localBlocks.has(operation.blockType) || [...this.operations.values()].some((item) => item.operation.blockType === operation.blockType)) throw new Error("DUPLICATE_OPERATION");
        localBlocks.add(operation.blockType);
      }
      assertAuditedOperation(adapter, operation);
      if (operation.scopes.length > 16 || operation.scopes.some((scope) => !/^[a-z][a-z0-9._:-]{0,63}$/.test(scope))) throw new Error("INVALID_OPERATION");
    }
    const snapshot = auditedSnapshot(adapter);
    this.adapters.set(snapshot.id, snapshot);
    for (const operation of snapshot.operations) this.operations.set(operation.id, Object.freeze({ adapter: snapshot, operation }));
  }
  resolve(context: StepExecutionContext): Registered | null {
    if (context.node.type === "connector.call") {
      const connectorId = context.input.connectorId, operationId = context.input.operationId;
      if (typeof connectorId !== "string" || typeof operationId !== "string") return null;
      const found = this.operations.get(operationId);
      return found?.adapter.id === connectorId && found.operation.blockType === "connector.call" ? found : null;
    }
    const found = [...this.operations.values()].find(({ operation }) => operation.blockType === context.node.type);
    return found ?? null;
  }
  list(): readonly ConnectorAdapter[] { return [...this.adapters.values()]; }
  get(connectorId: string, operationId: string): Registered | null {
    const found = this.operations.get(operationId);
    return found?.adapter.id === connectorId ? found : null;
  }
}

export type ExternalRoute =
  | { kind: "connector"; connectorId: string; operationId: string }
  | { kind: "connection_required"; connectorId: string; label: string; scopes: readonly string[]; status: "missing" | "revoked" }
  | { kind: "browser" }
  | { kind: "revoked" }
  | { kind: "unsupported" };
export interface ConnectorRoutingDependencies {
  readonly registry: ConnectorRegistry;
  authorize(context: StepExecutionContext): Promise<boolean>;
  browserAvailable?(context: StepExecutionContext): Promise<boolean>;
}
export interface ExactDispatch {
  readonly runId: string;
  readonly stepRunId: string;
  readonly connectorId: string;
  readonly operationId: string;
  readonly destination: string;
  readonly inputHash: string;
  readonly binding: Record<string, JsonValue>;
  readonly idempotencyKey: string;
}
export interface ConnectorDispatchDependencies extends ConnectorRoutingDependencies {
  /** Server-side confirmation check/consumption, normally via runner dispatchConfirmed. */
  confirmDispatch?(exact: ExactDispatch, context: StepExecutionContext): Promise<boolean>;
  clock?: () => Date;
}

function authorizedCapability(context: StepExecutionContext, operation: ConnectorOperation): boolean {
  return context.version.requiredCapabilities.includes(operation.capability);
}
export async function routeExternalStep(context: StepExecutionContext, deps: ConnectorRoutingDependencies): Promise<ExternalRoute> {
  if (!(await deps.authorize(context))) return { kind: "revoked" };
  const found = deps.registry.resolve(context);
  if (!found) {
    if (context.version.browserFallbackAllowed && deps.browserAvailable && await deps.browserAvailable(context)) return { kind: "browser" };
    return { kind: "unsupported" };
  }
  if (!authorizedCapability(context, found.operation)) return { kind: "revoked" };
  const status = await found.adapter.connection(context.actor.accountId, found.operation.id);
  if (status.status !== "connected") return {
    kind: "connection_required", connectorId: found.adapter.id, label: found.adapter.label,
    scopes: [...found.operation.scopes], status: status.status,
  };
  return { kind: "connector", connectorId: found.adapter.id, operationId: found.operation.id };
}

function parseInput(context: StepExecutionContext, operation: ConnectorOperation): Record<string, JsonValue> {
  return structuredClone(v.parse(operation.input, context.input)) as Record<string, JsonValue>;
}
function receiptFor(context: StepExecutionContext, operation: ConnectorOperation, connectorId: string, input: Record<string, JsonValue>, result: ConnectorExecutionResult, clock: () => Date): WorkflowReceipt {
  const providerReference = result.providerReference;
  if (providerReference !== null && (typeof providerReference !== "string" || providerReference.length === 0 || providerReference.length > 256)) throw new Error("INVALID_PROVIDER_RECEIPT");
  return v.parse(WorkflowReceiptSchema, {
    id: hashCanonical([context.run.id, context.step.id, context.idempotencyKey]),
    runId: context.run.id, stepRunId: context.step.id, executor: "connector",
    destination: operation.destination(input), summary: operation.summary,
    requestHash: hashCanonical(input), outputHash: hashCanonical(result.output),
    executedAt: clock().toISOString(), idempotencyKey: context.idempotencyKey,
    providerReference, finalUrl: null, successEvidence: null,
    metadata: { connectorId, operationId: operation.id },
  });
}
function validateResult(operation: ConnectorOperation, result: ConnectorExecutionResult): ConnectorExecutionResult {
  return { output: v.parse(operation.output, result.output) as JsonValue, providerReference: result.providerReference };
}
export async function dispatchConnectorStep(context: StepExecutionContext, route: ExternalRoute, deps: ConnectorDispatchDependencies): Promise<StepExecutionResult> {
  if (route.kind !== "connector") throw new Error(route.kind === "connection_required" ? "CONNECTION_REQUIRED" : "UNSUPPORTED_CONNECTOR_ROUTE");
  const found = deps.registry.get(route.connectorId, route.operationId);
  if (!found || deps.registry.resolve(context)?.operation !== found.operation) throw new Error("UNSUPPORTED_CONNECTOR_ROUTE");
  if (!authorizedCapability(context, found.operation) || !(await deps.authorize(context))) throw new Error("AUTHORIZATION_REVOKED");
  const status = await found.adapter.connection(context.actor.accountId, found.operation.id);
  if (status.status !== "connected") throw new Error("CONNECTION_REQUIRED");
  const input = parseInput(context, found.operation);
  const binding = structuredClone(await found.adapter.binding!(context.actor.accountId, found.operation.id) ?? {}) as Record<string, JsonValue>;
  const exact: ExactDispatch = {
    runId: context.run.id, stepRunId: context.step.id, connectorId: found.adapter.id,
    operationId: found.operation.id, destination: found.operation.destination(input),
    inputHash: hashCanonical(input), binding: structuredClone(binding), idempotencyKey: context.idempotencyKey,
  };
  if (found.operation.effect !== "read" && found.operation.effect !== "pure" &&
      (!deps.confirmDispatch || !(await deps.confirmDispatch(exact, context)))) throw new Error("CONFIRMATION_REQUIRED");
  // The gate may await user action. Check authority and connection again at the effect boundary.
  if (!authorizedCapability(context, found.operation) || !(await deps.authorize(context))) throw new Error("AUTHORIZATION_REVOKED");
  if ((await found.adapter.connection(context.actor.accountId, found.operation.id)).status !== "connected") throw new Error("CONNECTION_REQUIRED");
  // Identity material (e.g. sender) must still be exactly what the user confirmed.
  if (hashCanonical(await found.adapter.binding!(context.actor.accountId, found.operation.id) ?? {}) !== hashCanonical(binding))
    throw new ConnectorProviderError("CONFIRMATION");
  if (context.signal.aborted) throw new Error("DISPATCH_ABORTED");
  const result = validateResult(found.operation, await found.adapter.execute({
    accountId: context.actor.accountId, operationId: found.operation.id,
    input: structuredClone(input), binding: structuredClone(binding), idempotencyKey: context.idempotencyKey, signal: context.signal,
    authorize: () => deps.authorize(context),
  }));
  return { output: result.output, receipt: receiptFor(context, found.operation, found.adapter.id, input, result, deps.clock ?? (() => new Date())) };
}
export async function reconcileConnectorStep(context: StepExecutionContext, connectorId: string, operationId: string, deps: ConnectorDispatchDependencies): Promise<StepExecutionResult | null> {
  const found = deps.registry.get(connectorId, operationId);
  if (!found || deps.registry.resolve(context)?.operation !== found.operation) throw new Error("UNSUPPORTED_CONNECTOR_ROUTE");
  if (!authorizedCapability(context, found.operation) || !(await deps.authorize(context))) throw new Error("AUTHORIZATION_REVOKED");
  if ((await found.adapter.connection(context.actor.accountId, found.operation.id)).status !== "connected") throw new Error("CONNECTION_REQUIRED");
  if (context.signal.aborted) throw new Error("DISPATCH_ABORTED");
  const input = parseInput(context, found.operation);
  const binding = await found.adapter.binding!(context.actor.accountId, found.operation.id) ?? {};
  const raw = await found.adapter.reconcile({ accountId: context.actor.accountId, operationId, input, binding, idempotencyKey: context.idempotencyKey, signal: context.signal });
  if (!raw) return null;
  const result = validateResult(found.operation, raw);
  return { output: result.output, receipt: receiptFor(context, found.operation, connectorId, input, result, deps.clock ?? (() => new Date())) };
}

const short = v.pipe(v.string(), v.minLength(1), v.maxLength(256));
const text = v.pipe(v.string(), v.minLength(1), v.maxLength(10000));
const searchInput = catalog.get("research.web").input;
const searchOutput = catalog.get("research.web").output;
export function createBraveSearchAdapter(config: {
  credentials(accountId: string): Promise<{ apiKey: string } | null>;
  fetch?: typeof fetch;
}): ConnectorAdapter {
  const transport = config.fetch ?? fetch;
  return {
    id: "brave", label: "Brave Search", operations: [{
      id: "research.web", blockType: "research.web", capability: "web.search", effect: "read",
      scopes: ["web.search"], input: searchInput, output: searchOutput,
      destination: () => "brave:web-search", summary: "Research web sources",
    }],
    connection: async (accountId) => ({ status: (await config.credentials(accountId))?.apiKey ? "connected" : "missing" }),
    execute: async ({ accountId, input, signal }) => {
      const credentials = await config.credentials(accountId);
      if (!credentials?.apiKey) throw new Error("CONNECTION_REQUIRED");
      const url = new URL("https://api.search.brave.com/res/v1/web/search");
      url.searchParams.set("q", String(input.query));
      url.searchParams.set("count", "5");
      let response: Response;
      try { response = await transport(url, { headers: { "x-subscription-token": credentials.apiKey, accept: "application/json" }, redirect: "error", signal }); }
      catch { throw new ConnectorProviderError("TRANSIENT"); }
      if (!response.ok) throw providerStatusError(response.status, false);
      let raw;
      try { raw = v.parse(v.object({ web: v.object({ results: v.array(v.object({ url: text, title: text, description: v.string() })) }) }), await response.json()); }
      catch { throw new ConnectorProviderError("TRANSIENT"); }
      return { output: { sources: raw.web.results.slice(0, 5).map((item) => ({ url: item.url, title: item.title, excerpt: item.description || item.title })) }, providerReference: null };
    },
    reconcile: async () => null,
  };
}

const emailInput = v.strictObject({
  connectorId: v.literal("resend"), operationId: v.literal("email.send"),
  arguments: v.strictObject({ to: v.pipe(v.string(), v.email()), subject: short, body: text }),
});
const emailOutput = v.strictObject({ receiptId: short });
export function createResendEmailAdapter(config: {
  credentials(accountId: string): Promise<{ apiKey: string; from: string } | null>;
  fetch?: typeof fetch;
}): ConnectorAdapter {
  const transport = config.fetch ?? fetch;
  return {
    id: "resend", label: "Resend Email", operations: [{
      id: "email.send", blockType: "connector.call", capability: "email.send", effect: "irreversible_write",
      scopes: ["email.send"], input: emailInput, output: emailOutput,
      destination: (input) => String((input.arguments as Record<string, JsonValue>).to), summary: "Send email",
    }],
    connection: async (accountId) => ({ status: (await config.credentials(accountId))?.apiKey ? "connected" : "missing" }),
    binding: async (accountId) => {
      const credentials = await config.credentials(accountId);
      return credentials?.from ? { sender: credentials.from } : null;
    },
    execute: async ({ accountId, input, binding, idempotencyKey, signal }) => {
      const credentials = await config.credentials(accountId);
      if (!credentials?.apiKey) throw new Error("CONNECTION_REQUIRED");
      // Never send from an identity other than the one shown in the exact confirmation.
      if (binding.sender !== credentials.from) throw new ConnectorProviderError("CONFIRMATION");
      const args = v.parse(emailInput, input).arguments;
      let response: Response;
      try {
        response = await transport("https://api.resend.com/emails", {
          method: "POST", headers: { Authorization: `Bearer ${credentials.apiKey}`, "Content-Type": "application/json", "Idempotency-Key": idempotencyKey },
          body: JSON.stringify({ from: credentials.from, to: [args.to], subject: args.subject, text: args.body }),
          redirect: "error", signal,
        });
      } catch { throw new ConnectorProviderError("UNKNOWN_OUTCOME"); }
      if (!response.ok) throw providerStatusError(response.status, true);
      let result;
      try { result = v.parse(v.object({ id: short }), await response.json()); }
      catch { throw new ConnectorProviderError("UNKNOWN_OUTCOME"); }
      return { output: { receiptId: result.id }, providerReference: result.id };
    },
    // Resend's idempotency window is bounded; an unknown send is never replayed here.
    reconcile: async () => null,
  };
}

/** Existing application/calendar demo transport. It is not an OAuth calendar provider. */
export function createDemoEffectAdapter(config: {
  effect: { execute(action: EffectAction): Promise<EffectResult>; reconcile(action: EffectAction): Promise<EffectResult> };
  connection(accountId: string, operationId: string): Promise<{ status: "connected" | "missing" | "revoked" }>;
}): ConnectorAdapter {
  const catalog = createDefaultCatalog();
  const operations: ConnectorOperation[] = [
    {
      id: "application.submit", blockType: "application.submit", capability: "application.submit", effect: "irreversible_write",
      scopes: ["application.submit"], input: catalog.get("application.submit").input, output: catalog.get("application.submit").output,
      destination: (input) => `application:${String(input.applicationId)}`, summary: "Submit application",
    },
    {
      id: "calendar.create", blockType: "calendar.create", capability: "calendar.create", effect: "reversible_write",
      scopes: ["calendar.create"], input: catalog.get("calendar.create").input, output: catalog.get("calendar.create").output,
      destination: () => "demo:calendar", summary: "Create demo calendar event",
    },
  ];
  const actionFor = (input: ConnectorExecutionInput): EffectAction => {
    const type = input.operationId === "calendar.create" ? "CREATE_CALENDAR_EVENT" :
      input.operationId === "application.submit" ? "SUBMIT_APPLICATION" : null;
    if (!type) throw new Error("UNSUPPORTED_OPERATION");
    return { id: input.idempotencyKey, payloadHash: hashCanonical(input.input), payload: input.input, type };
  };
  const convert = (input: ConnectorExecutionInput, result: EffectResult): ConnectorExecutionResult => {
    const verified = validateEffectResult(actionFor(input), result);
    return { output: input.operationId === "calendar.create" ? { eventId: verified.externalId } : { receiptId: verified.externalId }, providerReference: verified.externalId };
  };
  return {
    id: "humanos-demo", label: "HumanOS Demo Service", operations,
    connection: config.connection,
    execute: async (input) => convert(input, await config.effect.execute(actionFor(input))),
    reconcile: async (input) => convert(input, await config.effect.reconcile(actionFor(input))),
  };
}
