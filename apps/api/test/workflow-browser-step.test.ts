import { expect, it, vi } from "vitest";
import { hashCanonical, type RunConfirmation } from "@humanos/schemas";
import type { WorkflowStore } from "@humanos/database";
import { createWorkflowConfirmations } from "../src/workflows/confirmations.js";
import { createBrowserStep } from "../src/workflows/browser-step.js";
import { BrowserRecipeRegistry, type BrowserExecutor, type BrowserRecipe } from "../src/workflows/browser.js";
import { WorkflowPause } from "../src/workflows/runner.js";
import type { StepExecutionContext } from "../src/workflows/types.js";

const recipe: BrowserRecipe = {
  id: "table-reserve", label: "Reserve a table", origin: "https://reserve.example.com", allowedOrigins: ["https://reserve.example.com"],
  entryPath: "/reserve", fields: [{ name: "name", label: "Name", selector: "#name", maxLength: 80 }], materialSelectors: ["#slot"],
  readResources: [],
  submitSelector: "#reserve-form button[type=submit]", submitRequest: { method: "POST", path: "/reserve", contentType: "application/x-www-form-urlencoded" },
  success: { pathPrefix: "/confirmed", referenceSelector: "#reference", referencePattern: /^[A-Z0-9]{4,32}$/ },
};
const now = new Date("2026-09-26T00:00:00.000Z");
function setup(options: { fallback?: boolean; fingerprint?: () => string; claim?: boolean; authorize?: () => boolean } = {}) {
  const recipes = new BrowserRecipeRegistry(); recipes.register(recipe);
  const clicks: string[] = [];
  const submission = () => ({ destination: "https://reserve.example.com/reserve", fields: { name: "Ada" }, attachments: [], value: null, pageFingerprint: (options.fingerprint ?? (() => hashCanonical("slot-19")))() as `0x${string}` });
  const executor: BrowserExecutor = {
    prepare: vi.fn(async () => submission()),
    submit: vi.fn(async ({ approve }) => { await approve(submission()); clicks.push("submit"); return { finalUrl: "https://reserve.example.com/confirmed", successEvidence: "Reserve a table: reference QX7342", providerReference: "QX7342" }; }),
  };
  const confirmations: RunConfirmation[] = [];
  const claim = vi.fn(async () => options.claim ?? true);
  const store = { list: async () => confirmations, claimConfirmedDispatch: claim, saveValue: async () => "x",
    insertConfirmation: async (c: RunConfirmation) => { confirmations.push(c); } } as unknown as WorkflowStore;
  const context = {
    actor: { accountId: "account", rootId: null }, run: { id: "run", revision: 1, leaseOwner: "worker" },
    version: { id: "version", browserFallbackAllowed: options.fallback ?? true }, node: { id: "node", type: "browser.submit" },
    step: { id: "step", idempotencyKey: hashCanonical("step") }, input: { destination: "recipe:table-reserve", payload: { name: "Ada" } },
    idempotencyKey: hashCanonical("step"), signal: new AbortController().signal,
  } as unknown as StepExecutionContext;
  let step!: ReturnType<typeof createBrowserStep>;
  const service = createWorkflowConfirmations({ store, prepare: c => step.prepare(c), clock: () => now });
  const authorize = vi.fn(async () => options.authorize?.() ?? true);
  step = createBrowserStep({ executor, recipes, authorize, confirmations: service, clock: () => now });
  const approveAll = () => confirmations.forEach((c, i) => { confirmations[i] = { ...c, status: "CONSUMED", consumedAt: now.toISOString() }; });
  return { step, executor, clicks, confirmations, claim, context, approveAll, authorize };
}

it("pauses honestly without opening a page when browser fallback is off or no recipe exists", async () => {
  const off = setup({ fallback: false });
  await expect(off.step.executor.execute(off.context)).rejects.toThrow("Browser fallback is off");
  expect(off.executor.submit).not.toHaveBeenCalled();
  const unknown = setup();
  await expect(unknown.step.executor.execute({ ...unknown.context, input: { destination: "https://evil.example.net", payload: { name: "Ada" } } })).rejects.toThrow("No audited site recipe");
  expect(unknown.executor.submit).not.toHaveBeenCalled();
});
it("stops before the click and records the exact live preview for confirmation", async () => {
  const s = setup();
  await expect(s.step.executor.execute(s.context)).rejects.toBeInstanceOf(WorkflowPause);
  expect(s.clicks).toEqual([]);
  expect(s.confirmations).toHaveLength(1);
  expect(s.confirmations[0]).toMatchObject({ status: "PENDING", destination: "https://reserve.example.com/reserve" });
  expect(s.claim).not.toHaveBeenCalled();
});
it("clicks exactly once after the matching confirmation is claimed, with a bound browser receipt", async () => {
  const s = setup();
  await s.step.executor.execute(s.context).catch(() => {});
  s.approveAll();
  const result = await s.step.executor.execute(s.context);
  expect(s.claim).toHaveBeenCalledTimes(1);
  expect(s.clicks).toEqual(["submit"]);
  expect(result.output).toEqual({ receiptId: "QX7342" });
  expect(result.receipt).toMatchObject({ executor: "browser", providerReference: "QX7342", finalUrl: "https://reserve.example.com/confirmed", requestHash: hashCanonical(s.context.input), idempotencyKey: s.context.idempotencyKey });
});
it("requires a new confirmation when material page state changed after approval", async () => {
  let slot = "slot-19";
  const s = setup({ fingerprint: () => hashCanonical(slot) });
  await s.step.executor.execute(s.context).catch(() => {});
  s.approveAll();
  slot = "slot-21";
  await expect(s.step.executor.execute(s.context)).rejects.toBeInstanceOf(WorkflowPause);
  expect(s.claim).not.toHaveBeenCalled();
  expect(s.clicks).toEqual([]);
  expect(s.confirmations.filter(c => c.status === "PENDING")).toHaveLength(1);
});
it("never clicks when the final dispatch was already claimed, and reports an unknown outcome", async () => {
  const s = setup({ claim: false });
  await s.step.executor.execute(s.context).catch(() => {});
  s.approveAll();
  await expect(s.step.executor.execute(s.context)).rejects.toMatchObject({ errorClass: "UNKNOWN_OUTCOME" });
  expect(s.clicks).toEqual([]);
});
it("never clicks when authority is revoked between the claim and the click", async () => {
  const s = setup();
  await s.step.executor.execute(s.context).catch(() => {});
  s.approveAll();
  // First check passes (before opening the page); the post-claim check sees the revocation.
  let checks = 0;
  s.authorize.mockImplementation(async () => ++checks === 1);
  await expect(s.step.executor.execute(s.context)).rejects.toMatchObject({ errorClass: "AUTHORIZATION" });
  expect(s.claim).toHaveBeenCalledTimes(1);
  expect(s.clicks).toEqual([]);
});
