import { describe, expect, it, vi } from "vitest";
import { hashCanonical } from "@humanos/schemas";
import { createDefaultCatalog } from "@humanos/workflows";
import type { StepExecutionContext } from "../src/workflows/types.js";
import {
  ConnectorRegistry, routeExternalStep, dispatchConnectorStep,
  reconcileConnectorStep, ConnectorProviderError,
  createBraveSearchAdapter, createResendEmailAdapter,
  createDemoEffectAdapter,
  type ConnectorAdapter,
} from "../src/workflows/connectors.js";

const calendar = createDefaultCatalog().get("calendar.create");
const inputSchema = calendar.input;
const outputSchema = calendar.output;
const calendarInput = { title: "Meet", startsAt: "2026-09-26T00:00:00.000Z", endsAt: "2026-09-26T01:00:00.000Z" };
function context(type = "calendar.create", input: Record<string, unknown> = calendarInput): StepExecutionContext {
  return {
    actor: { accountId: "account", rootId: null },
    run: { id: "run" }, version: { id: "version", browserFallbackAllowed: true, requiredCapabilities: ["calendar.create"] },
    step: { id: "step" }, node: { type }, input: structuredClone(input), idempotencyKey: hashCanonical(["version", "run", "step"]), signal: new AbortController().signal,
  } as StepExecutionContext;
}
function adapter(status: "connected" | "missing" | "revoked" = "connected"): ConnectorAdapter {
  return {
    id: "calendar", label: "Calendar", operations: [{
      id: "calendar.create", blockType: "calendar.create", capability: "calendar.create", effect: "reversible_write",
      scopes: ["events.write"], input: inputSchema, output: outputSchema,
      destination: () => "calendar:account", summary: "Create calendar event",
    }],
    connection: async () => ({ status }),
    execute: async () => ({ output: { eventId: "event-1" }, providerReference: "event-1" }),
    reconcile: async () => null,
  };
}
const deps = (registry: ConnectorRegistry, options: Partial<Parameters<typeof routeExternalStep>[1]> = {}) => ({
  registry, authorize: async () => true, browserAvailable: async () => true, ...options,
});

describe("connector routing", () => {
  it("routes a connected operation through its registered connector", async () => {
    const registry = new ConnectorRegistry(); registry.register(adapter());
    expect(await routeExternalStep(context(), deps(registry))).toMatchObject({ kind: "connector", connectorId: "calendar", operationId: "calendar.create" });
  });
  it("pauses for a missing or revoked account even when browser fallback is enabled", async () => {
    for (const status of ["missing", "revoked"] as const) {
      const registry = new ConnectorRegistry(); registry.register(adapter(status));
      expect(await routeExternalStep(context(), deps(registry))).toEqual({ kind: "connection_required", connectorId: "calendar", label: "Calendar", scopes: ["events.write"], status });
    }
  });
  it("allows browser only for an unsupported operation with explicit opt-in and availability", async () => {
    const registry = new ConnectorRegistry();
    expect(await routeExternalStep(context(), deps(registry))).toMatchObject({ kind: "browser" });
    expect(await routeExternalStep({ ...context(), version: { ...context().version, browserFallbackAllowed: false } }, deps(registry))).toMatchObject({ kind: "unsupported" });
    expect(await routeExternalStep(context(), deps(registry, { browserAvailable: async () => false }))).toMatchObject({ kind: "unsupported" });
  });
  it("rejects duplicate adapters and operation IDs", () => {
    const registry = new ConnectorRegistry(); registry.register(adapter());
    expect(() => registry.register(adapter())).toThrow("DUPLICATE_CONNECTOR");
    const copy = { ...adapter(), id: "other" };
    expect(() => registry.register(copy)).toThrow("DUPLICATE_OPERATION");
    const duplicateWithin = { ...adapter(), id: "within", operations: [adapter().operations[0]!, adapter().operations[0]!] };
    expect(() => new ConnectorRegistry().register(duplicateWithin)).toThrow("DUPLICATE_OPERATION");
    const sameBlock = { ...adapter(), id: "calendar-2", operations: [{ ...adapter().operations[0]!, id: "alternate-calendar" }] };
    expect(() => registry.register(sameBlock)).toThrow("DUPLICATE_OPERATION");
  });
  it("rejects an operation that downgrades a catalog write or its required capability", () => {
    const readDowngrade = { ...adapter(), operations: [{ ...adapter().operations[0]!, effect: "read" as const }] };
    expect(() => new ConnectorRegistry().register(readDowngrade)).toThrow("OPERATION_POLICY_MISMATCH");
    const capabilityDowngrade = { ...adapter(), operations: [{ ...adapter().operations[0]!, capability: "web.search" as const }] };
    expect(() => new ConnectorRegistry().register(capabilityDowngrade)).toThrow("OPERATION_POLICY_MISMATCH");
  });
  it("keeps audited metadata and callback references immutable after registration", async () => {
    const source = adapter();
    const execute = vi.fn(source.execute);
    source.execute = execute;
    const registry = new ConnectorRegistry(); registry.register(source);
    const operation = source.operations[0]! as unknown as Record<string, unknown>;
    operation.effect = "read";
    operation.capability = "web.search";
    operation.summary = "Downgraded";
    operation.destination = () => "attacker:destination";
    (operation.scopes as string[]).push("admin");
    source.execute = vi.fn(async () => ({ output: { eventId: "attacker" }, providerReference: "attacker" }));
    const exposed = registry.get("calendar", "calendar.create")!;
    expect(Object.isFrozen(exposed.operation)).toBe(true);
    expect(Object.isFrozen(exposed.adapter)).toBe(true);
    expect(exposed.operation).toMatchObject({ effect: "reversible_write", capability: "calendar.create", summary: "Create calendar event", scopes: ["events.write"] });
    const step = context(), wiring = deps(registry);
    const route = await routeExternalStep(step, wiring);
    await expect(dispatchConnectorStep(step, route, wiring)).rejects.toThrow("CONFIRMATION_REQUIRED");
    const result = await dispatchConnectorStep(step, route, { ...wiring, confirmDispatch: async exact => { expect(exact.destination).toBe("calendar:account"); return true; } });
    expect(execute).toHaveBeenCalledTimes(1);
    expect(result.receipt?.summary).toBe("Create calendar event");
  });
  it("rechecks permission and connection before dispatch, with no effect after revocation", async () => {
    let reads = 0;
    const source = adapter();
    const execute = vi.fn(source.execute);
    source.connection = async () => ({ status: ++reads === 1 ? "connected" : "revoked" });
    source.execute = execute;
    const registry = new ConnectorRegistry(); registry.register(source);
    const wiring = deps(registry);
    const route = await routeExternalStep(context(), wiring);
    await expect(dispatchConnectorStep(context(), route, { ...wiring, confirmDispatch: async () => true })).rejects.toThrow("CONNECTION_REQUIRED");
    expect(execute).not.toHaveBeenCalled();
  });
  it("requires a confirmed exact input before writes and emits a bound receipt", async () => {
    const source = adapter(); const execute = vi.fn(source.execute); source.execute = execute;
    const registry = new ConnectorRegistry(); registry.register(source);
    const wiring = deps(registry); const step = context();
    const route = await routeExternalStep(step, wiring);
    await expect(dispatchConnectorStep(step, route, wiring)).rejects.toThrow("CONFIRMATION_REQUIRED");
    const result = await dispatchConnectorStep(step, route, { ...wiring, confirmDispatch: async (exact) => {
      expect(exact.inputHash).toBe(hashCanonical(step.input));
      expect(exact.destination).toBe("calendar:account");
      return true;
    } });
    expect(execute).toHaveBeenCalledTimes(1);
    expect(result.receipt).toMatchObject({ runId: "run", stepRunId: "step", idempotencyKey: step.idempotencyKey, requestHash: hashCanonical(step.input), outputHash: hashCanonical({ eventId: "event-1" }), providerReference: "event-1" });
  });
  it("denies a revoked grant before dispatch without calling the adapter", async () => {
    const source = adapter(); const execute = vi.fn(source.execute); source.execute = execute;
    const registry = new ConnectorRegistry(); registry.register(source);
    let checks = 0;
    const wiring = deps(registry, { authorize: async () => ++checks === 1 });
    const route = await routeExternalStep(context(), wiring);
    await expect(dispatchConnectorStep(context(), route, { ...wiring, confirmDispatch: async () => true })).rejects.toThrow("AUTHORIZATION_REVOKED");
    expect(execute).not.toHaveBeenCalled();
  });
  it("dispatches the exact input that passed confirmation even if the caller mutates its object", async () => {
    const source = adapter(); const execute = vi.fn(source.execute); source.execute = execute;
    const registry = new ConnectorRegistry(); registry.register(source);
    const step = context(); const wiring = deps(registry);
    const route = await routeExternalStep(step, wiring);
    const result = await dispatchConnectorStep(step, route, { ...wiring, confirmDispatch: async () => {
      step.input.title = "Changed after approval";
      return true;
    } });
    expect(execute.mock.calls[0]?.[0].input).toEqual(calendarInput);
    expect(result.receipt?.requestHash).toBe(hashCanonical(calendarInput));
  });
  it("Brave performs real HTTP search against its fixed endpoint only with a configured key", async () => {
    const fetcher = vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) => new Response(JSON.stringify({ web: { results: [{ url: "https://example.org", title: "Example", description: "Excerpt" }] } })));
    const source = createBraveSearchAdapter({ credentials: async () => ({ apiKey: "server-key" }), fetch: fetcher });
    const registry = new ConnectorRegistry(); registry.register(source);
    const step: StepExecutionContext = { ...context("research.web", { query: "eth tokyo" }), version: { ...context().version, requiredCapabilities: ["web.search"] } };
    const route = await routeExternalStep(step, deps(registry));
    const result = await dispatchConnectorStep(step, route, deps(registry));
    expect(result.output).toEqual({ sources: [{ url: "https://example.org", title: "Example", excerpt: "Excerpt" }] });
    expect(String(fetcher.mock.calls[0]?.[0])).toContain("api.search.brave.com/res/v1/web/search");
    expect(fetcher.mock.calls[0]?.[1]?.headers).toMatchObject({ "x-subscription-token": "server-key" });
  });
  it("Resend uses the exact idempotency key and returns the provider email ID", async () => {
    const fetcher = vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) => new Response(JSON.stringify({ id: "email-1" })));
    const source = createResendEmailAdapter({ credentials: async () => ({ apiKey: "server-key", from: "sender@example.org" }), fetch: fetcher });
    const registry = new ConnectorRegistry(); registry.register(source);
    const step: StepExecutionContext = { ...context("connector.call", { connectorId: "resend", operationId: "email.send", arguments: { to: "reader@example.org", subject: "Hi", body: "Hello" } }), version: { ...context().version, requiredCapabilities: ["email.send"] } };
    const route = await routeExternalStep(step, deps(registry));
    const result = await dispatchConnectorStep(step, route, { ...deps(registry), confirmDispatch: async () => true });
    expect(result.output).toEqual({ receiptId: "email-1" });
    expect(fetcher.mock.calls[0]?.[1]?.headers).toMatchObject({ "Idempotency-Key": step.idempotencyKey });
  });
  it("binds the Resend sender into the exact dispatch and refuses to send from a changed sender", async () => {
    let from = "sender@example.org";
    const fetcher = vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) => new Response(JSON.stringify({ id: "email-1" })));
    const source = createResendEmailAdapter({ credentials: async () => ({ apiKey: "server-key", from }), fetch: fetcher });
    const registry = new ConnectorRegistry(); registry.register(source);
    const step: StepExecutionContext = { ...context("connector.call", { connectorId: "resend", operationId: "email.send", arguments: { to: "reader@example.org", subject: "Hi", body: "Hello" } }), version: { ...context().version, requiredCapabilities: ["email.send"] } };
    const route = await routeExternalStep(step, deps(registry));
    const seen: unknown[] = [];
    await expect(dispatchConnectorStep(step, route, { ...deps(registry), confirmDispatch: async (exact) => {
      seen.push(exact.binding);
      from = "impostor@example.org";
      return true;
    } })).rejects.toThrow();
    expect(seen).toEqual([{ sender: "sender@example.org" }]);
    expect(fetcher).not.toHaveBeenCalled();
    await expect(source.execute({ accountId: "account", operationId: "email.send", input: step.input, binding: { sender: "sender@example.org" }, idempotencyKey: hashCanonical("email"), signal: new AbortController().signal })).rejects.toMatchObject({ errorClass: "CONFIRMATION" });
    expect(fetcher).not.toHaveBeenCalled();
    const sent = await source.execute({ accountId: "account", operationId: "email.send", input: step.input, binding: { sender: "impostor@example.org" }, idempotencyKey: hashCanonical("email"), signal: new AbortController().signal });
    expect(sent.providerReference).toBe("email-1");
    expect(JSON.parse(String(fetcher.mock.calls[0]?.[1]?.body)).from).toBe("impostor@example.org");
  });
  it("exposes only public binding metadata, never credentials", async () => {
    const source = createResendEmailAdapter({ credentials: async () => ({ apiKey: "server-key", from: "sender@example.org" }) });
    const registry = new ConnectorRegistry(); registry.register(source);
    const binding = await registry.get("resend", "email.send")!.adapter.binding!("account", "email.send");
    expect(binding).toEqual({ sender: "sender@example.org" });
    expect(JSON.stringify(binding)).not.toContain("server-key");
  });
  it("adapts the existing configured demo effect transport without claiming a user calendar connection", async () => {
    const effect = { execute: vi.fn(async () => ({ externalId: "demo-event", payloadHash: hashCanonical({ title: "Meet", startsAt: "2026-09-26T00:00:00.000Z", endsAt: "2026-09-26T01:00:00.000Z" }), kind: "calendar" })), reconcile: vi.fn(async () => ({ externalId: "demo-event", payloadHash: hashCanonical({ title: "Meet", startsAt: "2026-09-26T00:00:00.000Z", endsAt: "2026-09-26T01:00:00.000Z" }), kind: "calendar" })) };
    const source = createDemoEffectAdapter({ effect, connection: async () => ({ status: "connected" }) });
    expect(source.label).toContain("Demo");
    const registry = new ConnectorRegistry(); registry.register(source);
    const step = context("calendar.create", { title: "Meet", startsAt: "2026-09-26T00:00:00.000Z", endsAt: "2026-09-26T01:00:00.000Z" });
    const route = await routeExternalStep(step, deps(registry));
    const result = await dispatchConnectorStep(step, route, { ...deps(registry), confirmDispatch: async () => true });
    expect(effect.execute).toHaveBeenCalledWith({ id: step.idempotencyKey, payloadHash: hashCanonical(step.input), payload: step.input, type: "CREATE_CALENDAR_EVENT" });
    expect(result.output).toEqual({ eventId: "demo-event" });
  });
  it("stops after abort while the final connection check is pending", async () => {
    const source = adapter(); const execute = vi.fn(source.execute); source.execute = execute;
    let reads = 0, release!: () => void;
    const pending = new Promise<void>((resolve) => { release = resolve; });
    source.connection = async () => { if (++reads === 3) await pending; return { status: "connected" }; };
    const registry = new ConnectorRegistry(); registry.register(source);
    const controller = new AbortController();
    const step = { ...context(), signal: controller.signal }, wiring = deps(registry);
    const route = await routeExternalStep(step, wiring);
    const dispatched = dispatchConnectorStep(step, route, { ...wiring, confirmDispatch: async () => true });
    await new Promise((resolve) => setTimeout(resolve, 0));
    controller.abort(); release();
    await expect(dispatched).rejects.toThrow("DISPATCH_ABORTED");
    expect(execute).not.toHaveBeenCalled();
  });
  it("requires fresh authority and connection before a provider reconciliation read", async () => {
    const source = adapter(); const reconcile = vi.fn(source.reconcile); source.reconcile = reconcile;
    const registry = new ConnectorRegistry(); registry.register(source);
    await expect(reconcileConnectorStep(context(), "calendar", "calendar.create", deps(registry, { authorize: async () => false }))).rejects.toThrow("AUTHORIZATION_REVOKED");
    expect(reconcile).not.toHaveBeenCalled();
  });
  it.each([
    [401, "AUTHORIZATION"], [403, "AUTHORIZATION"], [400, "VALIDATION"], [422, "VALIDATION"], [429, "TRANSIENT"], [503, "TRANSIENT"],
  ] as const)("classifies Brave HTTP %i as %s", async (status, errorClass) => {
    const source = createBraveSearchAdapter({ credentials: async () => ({ apiKey: "server-key" }), fetch: async () => new Response("", { status }) });
    await expect(source.execute({ accountId: "account", operationId: "research.web", input: { query: "eth" }, binding: {}, idempotencyKey: hashCanonical("search"), signal: new AbortController().signal })).rejects.toMatchObject({ errorClass });
  });
  it.each([
    [401, "AUTHORIZATION"], [403, "AUTHORIZATION"], [400, "VALIDATION"], [422, "VALIDATION"], [429, "TRANSIENT"], [503, "UNKNOWN_OUTCOME"],
  ] as const)("classifies Resend HTTP %i as %s", async (status, errorClass) => {
    const source = createResendEmailAdapter({ credentials: async () => ({ apiKey: "server-key", from: "sender@example.org" }), fetch: async () => new Response("", { status }) });
    await expect(source.execute({ accountId: "account", operationId: "email.send", input: { connectorId: "resend", operationId: "email.send", arguments: { to: "reader@example.org", subject: "Hi", body: "Hello" } }, binding: { sender: "sender@example.org" }, idempotencyKey: hashCanonical("email"), signal: new AbortController().signal })).rejects.toMatchObject({ errorClass });
  });
  it("classifies an ambiguous Resend transport failure as an unknown outcome", async () => {
    const source = createResendEmailAdapter({ credentials: async () => ({ apiKey: "server-key", from: "sender@example.org" }), fetch: async () => { throw new Error("connection dropped"); } });
    await expect(source.execute({ accountId: "account", operationId: "email.send", input: { connectorId: "resend", operationId: "email.send", arguments: { to: "reader@example.org", subject: "Hi", body: "Hello" } }, binding: { sender: "sender@example.org" }, idempotencyKey: hashCanonical("email"), signal: new AbortController().signal })).rejects.toBeInstanceOf(ConnectorProviderError);
  });
});
