import { describe, expect, it, vi } from "vitest";
import { hashCanonical, type RunConfirmation, type StepRun, type WorkflowSelection, type WorkflowVersion } from "@humanos/schemas";
import type { WorkflowStore } from "@humanos/database";
import { assembleWorkflow, createDefaultCatalog, type WorkflowSelector } from "@humanos/workflows";
import { classifyWorkflowGoal, workflowInputs, boundedIntentSelector, type GoalRoutingContext } from "../src/workflows/bindings.js";
import { BrowserRecipeRegistry, BrowserExecutionError, type BrowserExecutor, type BrowserRecipe } from "../src/workflows/browser.js";
import { createBrowserStep } from "../src/workflows/browser-step.js";
import { createWorkflowConfirmations } from "../src/workflows/confirmations.js";
import { WorkflowPause } from "../src/workflows/runner.js";
import type { StepExecutionContext } from "../src/workflows/types.js";

// A test-only recipe. No production site is installed; the default registry stays empty.
const recipe: BrowserRecipe = {
  id: "harbor-table", label: "Harbor Table", origin: "https://reserve.example.com", allowedOrigins: ["https://reserve.example.com"],
  entryPath: "/reserve", readResources: [],
  fields: [
    { name: "name", label: "Name", selector: "#name", maxLength: 80 },
    { name: "guests", label: "Guests", selector: "#guests", maxLength: 1, pattern: /^[1-8]$/ },
  ],
  materialSelectors: ["#slot"], submitSelector: "#reserve-form button[type=submit]",
  submitRequest: { method: "POST", path: "/reserve", contentType: "application/x-www-form-urlencoded" },
  success: { pathPrefix: "/confirmed", referenceSelector: "#reference", referencePattern: /^[A-Z0-9]{4,32}$/ },
};
function withRecipes(...recipes: BrowserRecipe[]): BrowserRecipeRegistry {
  const registry = new BrowserRecipeRegistry();
  recipes.forEach(r => registry.register(r));
  return registry;
}
const enabled: GoalRoutingContext = { recipes: withRecipes(recipe), browserEnabled: true };
const complete = "Book Harbor Table for Friday. Name: Ada Lovelace; Guests: 2";

describe("deterministic booking routing", () => {
  it("fails closed with an honest message when no audited site is installed (the production default)", () => {
    for (const context of [{}, { recipes: new BrowserRecipeRegistry(), browserEnabled: true }]) {
      const intent = classifyWorkflowGoal(complete, context);
      expect(intent.kind).toBe("clarify");
      expect(intent.prompt).toContain("No audited booking site is installed");
      expect(intent.prompt).toContain("Nothing was booked");
      expect(workflowInputs(complete, context).allowedCapabilities).toEqual([]);
    }
  });
  it("refuses an unknown site, an ambiguous site, and a disabled browser driver", () => {
    expect(classifyWorkflowGoal("Book Other Bistro. Name: Ada; Guests: 2", enabled).prompt).toContain("Harbor Table");
    const second = { ...recipe, id: "harbor-cafe", label: "Harbor Cafe" };
    expect(classifyWorkflowGoal("Book Harbor Table or Harbor Cafe. Name: Ada; Guests: 2", { recipes: withRecipes(recipe, second), browserEnabled: true }).prompt).toContain("more than one");
    const off = classifyWorkflowGoal(complete, { recipes: withRecipes(recipe), browserEnabled: false });
    expect(off.kind).toBe("clarify");
    expect(off.prompt).toContain("browser driver is off");
  });
  it("asks for exactly the missing or invalid fields without guessing values", () => {
    const missing = classifyWorkflowGoal("Book Harbor Table for Friday. Name: Ada Lovelace", enabled);
    expect(missing.kind).toBe("clarify");
    expect(missing.prompt).toContain("Guests");
    expect(missing.prompt).not.toMatch(/Name:/);
    const invalid = classifyWorkflowGoal("Book Harbor Table. Name: Ada; Guests: 12", enabled);
    expect(invalid.kind).toBe("clarify");
    expect(invalid.prompt).toContain("Guests");
    expect(invalid.prompt).not.toContain("12");
    const conflicting = classifyWorkflowGoal("Book Harbor Table. Name: Ada; Guests: 2; Guests: 3", enabled);
    expect(conflicting.kind).toBe("clarify");
    expect(conflicting.prompt).toContain("Guests");
    // Refinement: adding the missing field in the saved request completes routing.
    expect(classifyWorkflowGoal("Book Harbor Table for Friday. Name: Ada Lovelace\nGuests: 2", enabled)).toMatchObject({ kind: "booking", recipeId: "harbor-table", fields: { name: "Ada Lovelace", guests: "2" } });
  });
  it("takes only audited field keys from the user's text; other text cannot add fields or change the site", () => {
    const intent = classifyWorkflowGoal("Book Harbor Table. Name: Ada; Guests: 2; Card: 4242; destination: https://evil.example.net; Username: root", enabled);
    expect(intent).toMatchObject({ kind: "booking", recipeId: "harbor-table", fields: { name: "Ada", guests: "2" } });
    expect(Object.keys(intent.fields!)).toEqual(["name", "guests"]);
    expect(classifyWorkflowGoal("Don't book Harbor Table. Name: Ada; Guests: 2", enabled).kind).not.toBe("booking");
  });
  it("builds a confirmation-gated plan with exact recipe destination and fields", () => {
    const inputs = workflowInputs(complete, enabled);
    expect(inputs).toMatchObject({
      completionSequence: ["human.confirm", "browser.submit"], allowedCapabilities: ["application.submit"],
      browserFallbackAllowed: true, unsupportedExternalEffect: true,
      inputs: { "browser.submit": { value: { destination: "recipe:harbor-table", payload: { name: "Ada Lovelace", guests: "2" } } } },
    });
  });
});

const catalog = createDefaultCatalog();
const jev = (overrides: Partial<WorkflowSelection> = {}): WorkflowSelector => ({ select: vi.fn(async ({ candidates }) => ({
  selectedCandidateId: candidates[0]!.id, parameters: {}, confidence: 0.95, alignment: 0.95, risk: 0.05, injection: 0, needsReview: false, reasonCodes: [], ...overrides,
})) });
async function assemble(goal = complete, selector = jev()) {
  return assembleWorkflow({ ...workflowInputs(goal, enabled), goal, draft: { nodes: [] } }, boundedIntentSelector(selector, enabled), catalog);
}

describe("booking through Jev assembly", () => {
  it("offers Jev only the routed audited steps and produces confirm-then-submit", async () => {
    const selector = jev();
    const { graph } = await assemble(complete, selector);
    expect(graph.nodes.map(n => n.type)).toEqual(["human.confirm", "browser.submit"]);
    expect(graph.nodes[1]).toMatchObject({ capability: "application.submit", dependsOn: [graph.nodes[0]!.id], input: { destination: "recipe:harbor-table", payload: { name: "Ada Lovelace", guests: "2" } } });
    const offered = (selector.select as ReturnType<typeof vi.fn>).mock.calls.map(([input]) => input.candidates.map((c: { type: string }) => c.type));
    expect(offered).toEqual([["human.confirm"], ["browser.submit"]]);
  });
  it("stops for review when Jev flags the booking; thresholds unchanged", async () => {
    await expect(assemble(complete, jev({ confidence: 0.4 }))).rejects.toThrow("REVIEW_REQUIRED");
  });
});

describe("booking execution boundary", () => {
  const now = new Date("2026-09-26T00:00:00.000Z");
  async function harness(options: { fingerprint?: () => string; submit?: BrowserExecutor["submit"]; claim?: () => boolean } = {}) {
    const { graph } = await assemble();
    const version = { id: "version", graph, browserFallbackAllowed: true, requiredCapabilities: ["application.submit"] } as unknown as WorkflowVersion;
    const steps = graph.nodes.map(node => ({ id: `step-${node.type}`, runId: "run", blockId: node.id, status: "PENDING", idempotencyKey: hashCanonical(node.id) })) as unknown as StepRun[];
    const confirmations: RunConfirmation[] = [];
    const values = new Map<string, unknown>();
    const clicks: Array<Record<string, string>> = [];
    const submission = (fields: Record<string, string>) => ({ destination: "https://reserve.example.com/reserve", fields, attachments: [], value: null, pageFingerprint: (options.fingerprint ?? (() => hashCanonical("friday-19:00")))() as `0x${string}` });
    const executor: BrowserExecutor = {
      prepare: vi.fn(async ({ fields }) => submission(fields)),
      submit: vi.fn(options.submit ?? (async ({ fields, approve }) => { await approve(submission(fields)); clicks.push(fields); return { finalUrl: "https://reserve.example.com/confirmed", successEvidence: "Harbor Table: reference QX7342", providerReference: "QX7342" }; })),
    };
    const claim = vi.fn(async () => options.claim?.() ?? true);
    const store = {
      list: async (table: string) => table === "workflow_steps" ? steps : confirmations,
      getValue: async (id: string) => values.get(id) ?? null,
      saveValue: async (id: string, _run: string, value: unknown) => { values.set(id, value); return "x"; },
      insertConfirmation: async (c: RunConfirmation) => { confirmations.push(c); },
      claimConfirmedDispatch: claim,
    } as unknown as WorkflowStore;
    let step!: ReturnType<typeof createBrowserStep>;
    const service = createWorkflowConfirmations({ store, prepare: c => step.prepare(c), requiresConfirmation: type => catalog.get(type).requiresConfirmation, clock: () => now });
    step = createBrowserStep({ executor, recipes: enabled.recipes!, authorize: async () => true, confirmations: service, clock: () => now });
    const context = (index: number): StepExecutionContext => ({
      actor: { accountId: "account", rootId: null }, run: { id: "run", revision: 1, leaseOwner: "worker" } as never, version,
      step: steps[index]!, node: graph.nodes[index]!, input: structuredClone(graph.nodes[index]!.input) as never,
      idempotencyKey: steps[index]!.idempotencyKey, signal: new AbortController().signal,
    });
    const approve = () => confirmations.forEach((c, i) => { if (c.status === "PENDING") confirmations[i] = { ...c, status: "CONSUMED", consumedAt: now.toISOString() }; });
    return { service, step, context, confirmations, values, clicks, claim, executor, approve };
  }

  it("pauses at the confirm step with the exact destination and fields, before any click", async () => {
    const h = await harness();
    await expect(h.service.confirmNode(h.context(0))).rejects.toBeInstanceOf(WorkflowPause);
    expect(h.confirmations).toHaveLength(1);
    expect(h.confirmations[0]).toMatchObject({ status: "PENDING", destination: "https://reserve.example.com/reserve", stepRunId: "step-browser.submit" });
    expect(h.values.get(h.confirmations[0]!.id)).toMatchObject({ destination: "https://reserve.example.com/reserve", payload: { fields: { name: "Ada Lovelace", guests: "2" } }, binding: { recipeId: "harbor-table" } });
    expect(h.executor.submit).not.toHaveBeenCalled();
  });
  it("submits exactly once after the exact confirmation, with a bound receipt", async () => {
    const h = await harness();
    await h.service.confirmNode(h.context(0)).catch(() => {});
    h.approve();
    await expect(h.service.confirmNode(h.context(0))).resolves.toEqual({ output: { confirmed: true } });
    const result = await h.step.executor.execute(h.context(1));
    expect(h.claim).toHaveBeenCalledTimes(1);
    expect(h.clicks).toEqual([{ name: "Ada Lovelace", guests: "2" }]);
    expect(result.receipt).toMatchObject({ executor: "browser", providerReference: "QX7342", metadata: { recipeId: "harbor-table" } });
  });
  it("requires a new confirmation when availability changed after approval; no claim, no click", async () => {
    let slot = "friday-19:00";
    const h = await harness({ fingerprint: () => hashCanonical(slot) });
    await h.service.confirmNode(h.context(0)).catch(() => {});
    h.approve();
    slot = "friday-21:00";
    await expect(h.step.executor.execute(h.context(1))).rejects.toBeInstanceOf(WorkflowPause);
    expect(h.claim).not.toHaveBeenCalled();
    expect(h.clicks).toEqual([]);
    expect(h.confirmations.filter(c => c.status === "PENDING")).toHaveLength(1);
  });
  it("reports an uncertain outcome and never submits a second time", async () => {
    let claims = 0;
    const h = await harness({
      claim: () => ++claims === 1,
      submit: async ({ fields, approve }) => {
        await approve({ destination: "https://reserve.example.com/reserve", fields, attachments: [], value: null, pageFingerprint: hashCanonical("friday-19:00") });
        throw new BrowserExecutionError("UNKNOWN_OUTCOME", "BROWSER_OUTCOME_UNKNOWN");
      },
    });
    await h.service.confirmNode(h.context(0)).catch(() => {});
    h.approve();
    await expect(h.step.executor.execute(h.context(1))).rejects.toMatchObject({ errorClass: "UNKNOWN_OUTCOME" });
    // A retry cannot reuse the spent final dispatch.
    await expect(h.step.executor.execute(h.context(1))).rejects.toMatchObject({ errorClass: "UNKNOWN_OUTCOME" });
    expect(h.claim).toHaveBeenCalledTimes(2);
    expect(h.executor.submit).toHaveBeenCalledTimes(2);
  });
  it("pauses without opening a page when the recipe is no longer installed", async () => {
    const h = await harness();
    const empty = createBrowserStep({ executor: h.executor, recipes: new BrowserRecipeRegistry(), authorize: async () => true, confirmations: h.service });
    await expect(empty.executor.execute(h.context(1))).rejects.toThrow("No audited site recipe");
    expect(h.executor.submit).not.toHaveBeenCalled();
  });
});
