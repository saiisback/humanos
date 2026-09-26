import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { Database, WorkflowStore } from "@humanos/database";
import { createDefaultCatalog } from "@humanos/workflows";
import { hashCanonical, type BrowserWorkerResult, type RunConfirmation, type WorkflowVersion } from "@humanos/schemas";
import { createWorkflowService } from "../src/workflows/service.js";
import { createWorkflowRunner } from "../src/workflows/runner.js";
import { createWorkflowConfirmations } from "../src/workflows/confirmations.js";
import { createBrowserUseStep } from "../src/workflows/browser-use-step.js";
import { BrowserUseClientError, type BrowserUseClient, type BrowserUseRequest } from "../src/workflows/browser-use-client.js";
import { BrowserUsePolicyRegistry } from "../src/workflows/browser-use-policy.js";
import type { StepExecutionContext } from "../src/workflows/types.js";

// Session lifecycle through the real runner and an isolated Postgres schema; scripted worker only.
const schema = `test_browser_use_lifecycle_${Date.now()}`;
const db = new Database(process.env.TEST_DATABASE_URL ?? "postgresql://saikarthik@127.0.0.1:55432/humanos", { schema });
const store = new WorkflowStore(db), registry = createDefaultCatalog();
const actor = { accountId: "11155111:0x1111111111111111111111111111111111111111", rootId: null };
const FIELDS = { name: "Ada Lovelace", party_size: "2", email: "ada@example.com" };
const service = createWorkflowService({ newWorkflowAuthority: "account", /* Legacy account-workflow fixture. */ db, store, registry,
  selector: { async select(input) { return { selectedCandidateId: input.candidates[0]!.id, parameters: {}, confidence: 1, alignment: 1, risk: 0, injection: 0, needsReview: false, reasonCodes: [] }; } },
  assemblyInput: async () => ({ allowedCapabilities: [], inputs: {} }),
});
const policies = new BrowserUsePolicyRegistry({ allowFixtures: true });
policies.register({ id: "fixture-restaurant", label: "Fixture", origin: "http://fixture.humanos.test:8123", fixtureOnly: true, fields: [
  { name: "name", label: "Reservation name", maxLength: 80 },
  { name: "party_size", label: "Party size", maxLength: 2, pattern: /^[1-9][0-9]?$/ },
  { name: "email", label: "Contact email", maxLength: 120 },
] });

beforeAll(async () => {
  await db.migrate();
  await db.insert("accounts", { id: actor.accountId, address: `0x${actor.accountId.slice(-40)}`, chainId: 11155111, createdAt: new Date().toISOString() });
});
afterAll(async () => {
  await db.query(`DROP SCHEMA "${schema}" CASCADE`);
  await db.close();
});

async function bookingRun() {
  const draft = await service.createDraft(actor, null, "Book a table");
  const version: WorkflowVersion = { ...draft.versions[0]!, browserFallbackAllowed: true, graph: { nodes: [
    { id: "review", type: "human.confirm", blockVersion: "1.0.0", dependsOn: [], input: {}, capability: null, timeoutMs: 60000, maxAttempts: 1 },
    { id: "book", type: "browser.submit", blockVersion: "1.0.0", dependsOn: ["review"], input: { destination: "browser-use:fixture-restaurant", payload: { ...FIELDS, preferred_time: "19:00" } }, capability: "application.submit", timeoutMs: 120000, maxAttempts: 3 },
  ] } };
  version.graphHash = hashCanonical(version.graph);
  await store.updateVersion(version);
  await service.activate(actor, draft.workflow.id, version.id, version.graphHash);
  return (await service.runNow(actor, draft.workflow.id, {})).run.id;
}

/** Scripted worker sessions; each factory call is one browser process. */
function worker(options: { login?: () => boolean; deposit?: () => string } = {}) {
  const sessions: { id: string; calls: string[]; closed: boolean; permits: unknown[]; kill(): void }[] = [];
  const factory = vi.fn((): BrowserUseClient => {
    let action = 1, revision = 0, alive = true;
    const session = { id: `bus-${sessions.length + 1}`, calls: [] as string[], closed: false, permits: [] as unknown[], kill: () => { alive = false; } };
    sessions.push(session);
    const reply = (status: string, payload: unknown) => ({ protocolVersion: 1, accountId: actor.accountId, runId: "r", sessionId: session.id, actionId: action++, observationRevision: revision, status, payload }) as unknown as BrowserWorkerResult;
    return {
      sessionId: session.id, get revision() { return revision; }, get nextActionId() { return action; }, get alive() { return alive && !session.closed; },
      async request(request: BrowserUseRequest) {
        if (!alive || session.closed) throw new BrowserUseClientError("CLOSED");
        session.calls.push(request.command);
        switch (request.command) {
          case "start": return reply("ready", { runtime: { name: "browser-use", version: "0.13.10" }, policyId: "fixture-restaurant", origin: "http://fixture.humanos.test:8123", profile: "dedicated" });
          case "observe":
            revision++;
            return reply("observed", { origin: "http://fixture.humanos.test:8123", path: "/book", title: "Book", loginRequired: options.login?.() ?? false, facts: [],
              candidates: options.login?.() ? [] : [{ id: "select:slot-1900", kind: "select", label: "19:00", targetId: "slot-1900", policyId: "fixture-restaurant", observationRevision: revision }] });
          case "act": revision++; return reply("acted", {});
          case "prepare": {
            revision++;
            const deposit = options.deposit?.() ?? "1000";
            const fields = { ...(request.payload as { fields: Record<string, string> }).fields, slot: "1900" };
            const material = ["Sakura Kitchen", `Deposit JPY ${deposit}`];
            return reply("prepared", { destination: "http://fixture.humanos.test:8123/reserve", fields, material, value: { amount: deposit, currency: "JPY" }, materialHash: hashCanonical({ fields, material }) });
          }
          case "submit":
            session.permits.push((request.payload as { permit: unknown }).permit);
            return reply("submitted", { providerReference: "R-ABC123", finalUrl: "http://fixture.humanos.test:8123/confirmed/R-ABC123", successEvidence: "reference R-ABC123" });
          case "inspect_receipt": return reply("unavailable", { reason: "NO_RECEIPT", message: "none" });
          default: return reply("closed", {});
        }
      },
      async close() { session.closed = true; },
    };
  });
  return { sessions, factory, submits: () => sessions.flatMap(s => s.calls).filter(c => c === "submit").length };
}

function harness(client: () => BrowserUseClient, options: { visibleWindow?: boolean; handoffHoldMs?: number; authorize?: (c: StepExecutionContext) => Promise<boolean> } = {}) {
  let step!: ReturnType<typeof createBrowserUseStep>;
  const confirmations = createWorkflowConfirmations({ store, requiresConfirmation: type => registry.get(type).requiresConfirmation, prepare: c => step.prepare(c) });
  const authorize = vi.fn(options.authorize ?? (async () => true));
  step = createBrowserUseStep({ client: () => client(), policies, authorize, confirmations, store,
    visibleWindow: options.visibleWindow ?? true, ...(options.handoffHoldMs ? { handoffHoldMs: options.handoffHoldMs } : {}) });
  const runner = createWorkflowRunner({ store, registry, content: { generate: vi.fn() }, workerId: `lc-${Math.random()}`, authorize, dispatchConfirmed: confirmations.probeApproved,
    executors: { "human.confirm": { execute: confirmations.confirmNode }, "browser.submit": step.executor } });
  return { step, confirmations, runner, authorize };
}
async function drain(runner: { tick(): Promise<boolean> }) { for (let i = 0; i < 6 && await runner.tick(); i++); }
const detail = (runId: string) => service.runDetail(actor, runId);
const pending = async (runId: string) => (await store.list<RunConfirmation>("workflow_confirmations")).filter(c => c.runId === runId && c.status === "PENDING");
async function approve(h: ReturnType<typeof harness>, runId: string) {
  const [confirmation] = await pending(runId);
  await h.confirmations.confirm(actor, runId, confirmation!.id, confirmation!.payloadHash);
  return confirmation!;
}

describe("login / CAPTCHA handoff session", () => {
  it("keeps the account/run-scoped window open, then reauthorizes and re-observes the same session on resume", async () => {
    const runId = await bookingRun();
    let needsLogin = true;
    const w = worker({ login: () => needsLogin });
    const h = harness(w.factory);
    await drain(h.runner);
    const paused = await detail(runId);
    expect(paused.run.status).toBe("CONNECTION_REQUIRED");
    expect(paused.run.pauseReason).toMatch(/sign in .*HumanOS browser window/i);
    expect(w.sessions).toHaveLength(1);
    expect(w.sessions[0]!.closed).toBe(false);

    needsLogin = false;
    await service.resume(actor, runId);
    const authorizationsBefore = h.authorize.mock.calls.length;
    await drain(h.runner);
    expect((await detail(runId)).run.status).toBe("CONFIRMATION_REQUIRED");
    // Same browser process: the user's sign-in is used, nothing is replayed blindly.
    expect(w.factory).toHaveBeenCalledTimes(1);
    expect(w.sessions[0]!.calls.filter(c => c === "start")).toHaveLength(1);
    expect(w.sessions[0]!.calls.filter(c => c === "observe")).toHaveLength(2);
    expect(h.authorize.mock.calls.length).toBeGreaterThan(authorizationsBefore);
    expect(w.submits()).toBe(0);
    h.step.releaseAll();
  });

  it("never points the user at a window that does not exist", async () => {
    const runId = await bookingRun();
    const w = worker({ login: () => true });
    const h = harness(w.factory, { visibleWindow: false });
    await drain(h.runner);
    const paused = await detail(runId);
    expect(paused.run.status).toBe("CONNECTION_REQUIRED");
    expect(paused.run.pauseReason).toMatch(/sign in/i);
    expect(paused.run.pauseReason).toMatch(/no visible browser window/i);
    expect(w.sessions[0]!.closed).toBe(true);
  });

  it("closes an expired handoff window and says so when the user resumes", async () => {
    const runId = await bookingRun();
    const w = worker({ login: () => true });
    const h = harness(w.factory, { handoffHoldMs: 50 });
    await drain(h.runner);
    await new Promise(resolve => setTimeout(resolve, 120));
    expect(w.sessions[0]!.closed).toBe(true);
    await service.resume(actor, runId);
    await drain(h.runner);
    const paused = await detail(runId);
    expect(w.sessions).toHaveLength(2);
    expect(paused.run.pauseReason).toMatch(/earlier HumanOS browser window was closed/i);
    h.step.releaseAll();
  });

  it("cleans up the held window when the run is cancelled", async () => {
    const runId = await bookingRun();
    const w = worker({ login: () => true });
    const h = harness(w.factory);
    await drain(h.runner);
    expect(w.sessions[0]!.closed).toBe(false);
    await service.cancel(actor, runId);
    await h.step.sweep();
    expect(w.sessions[0]!.closed).toBe(true);
  });

  it("closes a paused window when its authority expires or is revoked without a resume", async () => {
    const runId = await bookingRun();
    let allowed = true;
    const w = worker({ login: () => true });
    const h = harness(w.factory, { authorize: async () => allowed });
    await drain(h.runner);
    expect(w.sessions[0]!.closed).toBe(false);
    allowed = false;
    await h.step.sweep();
    expect(w.sessions[0]!.closed).toBe(true);
    expect(w.submits()).toBe(0);
    await h.step.releaseAll();
  });
});

describe("session-bound confirmation", () => {
  it("binds the approval to the reviewed session and revision and submits in that same session", async () => {
    const runId = await bookingRun();
    const w = worker();
    const h = harness(w.factory);
    await drain(h.runner);
    const [confirmation] = await pending(runId);
    const { preview } = await h.confirmations.preview(actor, confirmation!.id);
    expect(preview).toMatchObject({ binding: { executor: "browser-use", sessionId: "bus-1", reviewedRevision: 3 } });
    await approve(h, runId);
    await drain(h.runner);
    expect((await detail(runId)).run.status).toBe("COMPLETED");
    expect(w.factory).toHaveBeenCalledTimes(1);
    expect(w.submits()).toBe(1);
    expect(w.sessions[0]!.permits[0]).toMatchObject({ sessionId: "bus-1" });
    expect(w.sessions[0]!.closed).toBe(true);
  });

  it("a lost session (restart) never reuses the earlier approval and asks for a new review in a new session", async () => {
    const runId = await bookingRun();
    const w = worker();
    const before = harness(w.factory);
    await drain(before.runner);
    const approved = await approve(before, runId);
    // Simulated server restart: a new step instance has no live browser session.
    before.step.releaseAll();
    const after = harness(w.factory);
    await drain(after.runner);
    expect((await detail(runId)).run.status).toBe("CONFIRMATION_REQUIRED");
    expect(w.submits()).toBe(0);
    const [fresh] = await pending(runId);
    expect(fresh!.payloadHash).not.toBe(approved.payloadHash);
    const { preview } = await after.confirmations.preview(actor, fresh!.id);
    expect(preview).toMatchObject({ binding: { sessionId: "bus-2" } });
    expect(JSON.stringify(preview)).toMatch(/earlier review was closed/i);
    after.step.releaseAll();
  });

  it("a worker that died while holding the reviewed session is treated as lost, not reused", async () => {
    const runId = await bookingRun();
    const w = worker();
    const h = harness(w.factory);
    await drain(h.runner);
    await approve(h, runId);
    w.sessions[0]!.kill();
    await drain(h.runner);
    expect((await detail(runId)).run.status).toBe("CONFIRMATION_REQUIRED");
    expect(w.submits()).toBe(0);
    expect(w.sessions).toHaveLength(2);
    h.step.releaseAll();
  });

  it("material that changes in the same session after approval requires a new review and keeps the window", async () => {
    const runId = await bookingRun();
    let deposit = "1000";
    const w = worker({ deposit: () => deposit });
    const h = harness(w.factory);
    await drain(h.runner);
    await approve(h, runId);
    deposit = "5000";
    await drain(h.runner);
    expect((await detail(runId)).run.status).toBe("CONFIRMATION_REQUIRED");
    expect(w.submits()).toBe(0);
    expect(w.factory).toHaveBeenCalledTimes(1);
    expect(w.sessions[0]!.closed).toBe(false);
    const [fresh] = await pending(runId);
    const { preview } = await h.confirmations.preview(actor, fresh!.id);
    expect(JSON.stringify(preview)).toContain("Deposit JPY 5000");
    h.step.releaseAll();
  });
});
