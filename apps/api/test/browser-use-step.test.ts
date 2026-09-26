import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { spawn, type ChildProcess } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readdirSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { Database, WorkflowStore } from "@humanos/database";
import { createDefaultCatalog } from "@humanos/workflows";
import { hashCanonical, type BrowserWorkerResult, type RunConfirmation, type WorkflowReceipt, type WorkflowVersion } from "@humanos/schemas";
import { createWorkflowService } from "../src/workflows/service.js";
import { createWorkflowRunner } from "../src/workflows/runner.js";
import { createWorkflowConfirmations } from "../src/workflows/confirmations.js";
import { createBrowserUseStep } from "../src/workflows/browser-use-step.js";
import { createBrowserUseClient, BrowserUseClientError, type BrowserUseClient, type BrowserUseRequest } from "../src/workflows/browser-use-client.js";
import { BrowserUsePolicyRegistry } from "../src/workflows/browser-use-policy.js";
import type { StepExecutionContext } from "../src/workflows/types.js";

// Isolated schema per file; controlled local fixtures only. No live site, account or email.
const schema = `test_browser_use_step_${Date.now()}`;
const db = new Database(process.env.TEST_DATABASE_URL ?? "postgresql://saikarthik@127.0.0.1:55432/humanos", { schema });
const store = new WorkflowStore(db), registry = createDefaultCatalog();
const actor = { accountId: "11155111:0x1111111111111111111111111111111111111111", rootId: null };
const other = { accountId: "11155111:0x2222222222222222222222222222222222222222", rootId: null };
const FIELDS = { name: "Ada Lovelace", party_size: "2", email: "ada@example.com" };
const service = createWorkflowService({ newWorkflowAuthority: "account", /* Legacy account-workflow fixture. */ db, store, registry,
  selector: { async select(input) { return { selectedCandidateId: input.candidates.find(c => c.type === "complete")?.id ?? input.candidates[0]!.id, parameters: {}, confidence: 1, alignment: 1, risk: 0, injection: 0, needsReview: false, reasonCodes: [] }; } },
  assemblyInput: async () => ({ allowedCapabilities: [], inputs: {} }),
});

function policyRegistry(origin = "http://fixture.humanos.test:8123") {
  const policies = new BrowserUsePolicyRegistry({ allowFixtures: true });
  policies.register({ id: "fixture-restaurant", label: "Controlled fixture restaurant (test only)", origin, fixtureOnly: true, fields: [
    { name: "name", label: "Reservation name", maxLength: 80 },
    { name: "party_size", label: "Party size", maxLength: 2, pattern: /^[1-9][0-9]?$/ },
    { name: "email", label: "Contact email", maxLength: 120 },
  ] });
  return policies;
}

beforeAll(async () => {
  await db.migrate();
  for (const a of [actor, other])
    await db.insert("accounts", { id: a.accountId, address: `0x${a.accountId.slice(-40)}`, chainId: 11155111, createdAt: new Date().toISOString() });
});
afterAll(async () => {
  await db.query(`DROP SCHEMA "${schema}" CASCADE`);
  await db.close();
});

async function bookingRun(payload: Record<string, string> = { ...FIELDS, preferred_time: "19:00" }) {
  const draft = await service.createDraft(actor, null, "Book a table");
  const version: WorkflowVersion = { ...draft.versions[0]!, browserFallbackAllowed: true, graph: { nodes: [
    { id: "review", type: "human.confirm", blockVersion: "1.0.0", dependsOn: [], input: {}, capability: null, timeoutMs: 60000, maxAttempts: 1 },
    { id: "book", type: "browser.submit", blockVersion: "1.0.0", dependsOn: ["review"], input: { destination: "browser-use:fixture-restaurant", payload }, capability: "application.submit", timeoutMs: 120000, maxAttempts: 3 },
  ] } };
  version.graphHash = hashCanonical(version.graph);
  await store.updateVersion(version);
  await service.activate(actor, draft.workflow.id, version.id, version.graphHash);
  return (await service.runNow(actor, draft.workflow.id, {})).run.id;
}

/** Scripted stand-in for the worker, recording every command it receives. */
function scriptedClient(script: { prepared?: () => { material: string[]; value: { amount: string; currency: string } | null }; submit?: (request: BrowserUseRequest) => "ok" | "unknown" | "crash" | "not_sent"; inspect?: () => "none" | "found"; observe?: () => "ok" | "login"; failPrepareAt?: number } = {}) {
  const calls: string[] = [];
  let ref = 0;
  let prepares = 0;
  const factory = () => {
    let action = 1, revision = 0, closedSession = false;
    const sessionId = `bus-${++ref}`;
    const reply = (status: string, payload: unknown): BrowserWorkerResult => ({ protocolVersion: 1, accountId: actor.accountId, runId: "r", sessionId, actionId: action++, observationRevision: revision, status, payload } as unknown as BrowserWorkerResult);
    const client: BrowserUseClient = {
      sessionId, get revision() { return revision; }, get nextActionId() { return action; }, get alive() { return !closedSession; },
      async request(request: BrowserUseRequest) {
        calls.push(request.command);
        switch (request.command) {
          case "start": return reply("ready", { runtime: { name: "browser-use", version: "0.13.10" }, policyId: "fixture-restaurant", origin: "http://fixture.humanos.test:8123", profile: "dedicated" });
          case "observe":
            revision++;
            if (script.observe?.() === "login") return reply("observed", { origin: "http://fixture.humanos.test:8123", path: "/book", title: "Sign in", loginRequired: true, facts: [], candidates: [] });
            return reply("observed", { origin: "http://fixture.humanos.test:8123", path: "/book", title: "Book a table", loginRequired: false, facts: [], candidates: [
              { id: "select:slot-1900", kind: "select", label: "19:00", targetId: "slot-1900", policyId: "fixture-restaurant", observationRevision: revision },
              { id: "select:slot-2000", kind: "select", label: "20:00", targetId: "slot-2000", policyId: "fixture-restaurant", observationRevision: revision },
            ] });
          case "act": revision++; return reply("acted", {});
          case "prepare": {
            if (++prepares === script.failPrepareAt) throw new BrowserUseClientError("CLOSED");
            revision++;
            const { material, value } = script.prepared?.() ?? { material: ["Sakura Kitchen", "Friday 19:00", "Deposit JPY 1,000"], value: { amount: "1000", currency: "JPY" } };
            const fields = { ...(request.payload as { fields: Record<string, string> }).fields, slot: "1900" };
            return reply("prepared", { destination: "http://fixture.humanos.test:8123/reserve", fields, material, value, materialHash: hashCanonical({ fields, material, value }) });
          }
          case "submit": {
            const mode = script.submit?.(request) ?? "ok";
            if (mode === "crash") throw new BrowserUseClientError("CLOSED");
            if (mode === "unknown") return reply("failed", { code: "UNKNOWN_OUTCOME", message: "The booking outcome must be checked." });
            if (mode === "not_sent") return reply("failed", { code: "BROWSER", message: "The booking request was not sent." });
            return reply("submitted", { providerReference: "R-ABC123", finalUrl: "http://fixture.humanos.test:8123/confirmed/R-ABC123", successEvidence: "reference R-ABC123" });
          }
          case "inspect_receipt":
            return script.inspect?.() === "found"
              ? reply("submitted", { providerReference: "R-ABC123", finalUrl: "http://fixture.humanos.test:8123/confirmed/R-ABC123", successEvidence: "reference R-ABC123" })
              : reply("unavailable", { reason: "NO_RECEIPT", message: "No booking confirmation is visible." });
          default: return reply("closed", {});
        }
      },
      async close() { closedSession = true; calls.push("close"); },
    };
    return client;
  };
  return { calls, factory: vi.fn(factory) };
}

function harness(options: { client: () => BrowserUseClient; authorize?: (context: StepExecutionContext) => Promise<boolean>; clock?: () => Date; policies?: BrowserUsePolicyRegistry; executionSignal?: AbortSignal }) {
  let step!: ReturnType<typeof createBrowserUseStep>;
  const confirmations = createWorkflowConfirmations({ store, requiresConfirmation: type => registry.get(type).requiresConfirmation, prepare: c => step.prepare(c), ...(options.clock ? { clock: options.clock } : {}) });
  const authorize = options.authorize ?? (async () => true);
  step = createBrowserUseStep({ client: () => options.client(), policies: options.policies ?? policyRegistry(), authorize, confirmations, store, ...(options.clock ? { clock: options.clock } : {}) });
  const runner = createWorkflowRunner({ store, registry, content: { generate: vi.fn() }, workerId: `bu-${Math.random()}`, authorize, dispatchConfirmed: confirmations.probeApproved,
    ...(options.clock ? { clock: options.clock } : {}),
    executors: { "human.confirm": { execute: confirmations.confirmNode }, "browser.submit": {
      execute: context => step.executor.execute({ ...context, signal: options.executionSignal ?? context.signal }),
    } } });
  return { step, confirmations, runner };
}
async function drain(runner: { tick(): Promise<boolean> }) { for (let i = 0; i < 6 && await runner.tick(); i++); }
const pending = async (runId: string) => (await store.list<RunConfirmation>("workflow_confirmations")).filter(c => c.runId === runId && c.status === "PENDING");
const run = async (runId: string) => service.runDetail(actor, runId);
async function approve(confirmations: ReturnType<typeof createWorkflowConfirmations>, runId: string) {
  const [confirmation] = await pending(runId);
  expect(confirmation).toBeDefined();
  await confirmations.confirm(actor, runId, confirmation!.id, confirmation!.payloadHash);
  return confirmation!;
}

describe("Browser Use step through the durable runner", () => {
  it("prepares, pauses with zero submissions, then submits once after exact approval with a bound receipt", async () => {
    const runId = await bookingRun();
    const worker = scriptedClient();
    const h = harness({ client: worker.factory });
    await drain(h.runner);
    expect((await run(runId)).run.status).toBe("CONFIRMATION_REQUIRED");
    expect(worker.calls).not.toContain("submit");
    const [confirmation] = await pending(runId);
    const preview = await h.confirmations.preview(actor, confirmation!.id);
    expect(preview.preview).toMatchObject({ destination: "http://fixture.humanos.test:8123/reserve",
      payload: { fields: { ...FIELDS, slot: "1900" }, material: ["Sakura Kitchen", "Friday 19:00", "Deposit JPY 1,000"], value: { amount: "1000", currency: "JPY" } },
      binding: { executor: "browser-use", policyId: "fixture-restaurant", origin: "http://fixture.humanos.test:8123" } });
    await approve(h.confirmations, runId);
    await drain(h.runner);
    const detail = await run(runId);
    expect(detail.run.status).toBe("COMPLETED");
    expect(worker.calls.filter(c => c === "submit")).toHaveLength(1);
    const receipts = (await store.list<WorkflowReceipt>("workflow_receipts")).filter(r => r.runId === runId);
    expect(receipts).toHaveLength(1);
    expect(receipts[0]).toMatchObject({ executor: "browser", providerReference: "R-ABC123", destination: "http://fixture.humanos.test:8123/reserve" });
    expect(receipts[0]!.metadata).toMatchObject({ policyId: "fixture-restaurant", executor: "browser-use" });
    expect((receipts[0]!.metadata as { materialHash: string }).materialHash).toMatch(/^0x[0-9a-f]{64}$/);
    // Measured metrics only: 4 worker actions (start/observe/act/prepare), exact time match so no Jev call, no token/cost fields.
    const metadata = receipts[0]!.metadata as Record<string, unknown>;
    expect(metadata).toMatchObject({ preparationActions: 4, jevCalls: 0 });
    expect(metadata.preparationMs).toBeTypeOf("number");
    expect(metadata.submitMs).toBeTypeOf("number");
    expect(Object.keys(metadata).some(key => /token|cost|usage/i.test(key))).toBe(false);
    // Every session was closed; no browser left running.
    expect(worker.calls.filter(c => c === "start").length).toBe(worker.calls.filter(c => c === "close").length);
  });

  it("requires a fresh review when price or terms change after approval", async () => {
    const runId = await bookingRun();
    let deposit = "1,000";
    const worker = scriptedClient({ prepared: () => ({ material: ["Sakura Kitchen", "Friday 19:00", `Deposit JPY ${deposit}`], value: { amount: deposit.replace(",", ""), currency: "JPY" } }) });
    const h = harness({ client: worker.factory });
    await drain(h.runner);
    const first = await approve(h.confirmations, runId);
    deposit = "5,000";
    await drain(h.runner);
    expect((await run(runId)).run.status).toBe("CONFIRMATION_REQUIRED");
    expect(worker.calls).not.toContain("submit");
    const [fresh] = await pending(runId);
    expect(fresh!.payloadHash).not.toBe(first.payloadHash);
  });

  it("an expired approval is never used", async () => {
    const runId = await bookingRun();
    let now = Date.now();
    const worker = scriptedClient();
    const h = harness({ client: worker.factory, clock: () => new Date(now) });
    await drain(h.runner);
    now += 6 * 60 * 1000;
    const [confirmation] = await pending(runId);
    await expect(h.confirmations.confirm(actor, runId, confirmation!.id, confirmation!.payloadHash)).rejects.toThrow("CONFIRMATION_UNAVAILABLE");
    expect(worker.calls).not.toContain("submit");
  });

  it("does not submit when approval expires during the final authority check", async () => {
    const runId = await bookingRun();
    let now = Date.now();
    const worker = scriptedClient();
    const h = harness({ client: worker.factory, clock: () => new Date(now), authorize: async context => {
      const claimed = await db.query("SELECT 1 FROM workflow_dispatch_claims WHERE step_id=$1", [context.step.id]);
      if (claimed.rowCount) now += 2_000;
      return true;
    } });
    await drain(h.runner);
    const confirmation = await approve(h.confirmations, runId);
    now = Date.parse(confirmation.expiresAt) - 1_000;
    await drain(h.runner);
    expect(worker.calls).not.toContain("submit");
    expect((await run(runId)).run.status).toBe("RECONCILIATION_REQUIRED");
  });

  it("caps the worker permit at the confirmed approval expiry", async () => {
    const runId = await bookingRun();
    let now = Date.now();
    let permitExpiry: string | undefined;
    const worker = scriptedClient({ submit: request => {
      if (request.command === "submit") permitExpiry = request.payload.permit.expiresAt;
      return "ok";
    } });
    const h = harness({ client: worker.factory, clock: () => new Date(now) });
    await drain(h.runner);
    const confirmation = await approve(h.confirmations, runId);
    now = Date.parse(confirmation.expiresAt) - 30_000;
    await drain(h.runner);
    expect((await run(runId)).run.status).toBe("COMPLETED");
    expect(permitExpiry).toBe(confirmation.expiresAt);
  });

  it("another account cannot see or approve the booking", async () => {
    const runId = await bookingRun();
    const worker = scriptedClient();
    const h = harness({ client: worker.factory });
    await drain(h.runner);
    const [confirmation] = await pending(runId);
    await expect(h.confirmations.preview(other, confirmation!.id)).rejects.toThrow("NOT_FOUND");
    await expect(h.confirmations.confirm(other, runId, confirmation!.id, confirmation!.payloadHash)).rejects.toThrow("NOT_FOUND");
    expect(worker.calls).not.toContain("submit");
  });

  it("revoked authority (account session or ENS agent) during preparation stops before any submission", async () => {
    const runId = await bookingRun();
    const worker = scriptedClient();
    // Authority is revoked once the post-approval re-verification of the held session has run
    // (the second `prepare`), i.e. before the dispatch permit is issued.
    const h = harness({ client: worker.factory, authorize: async () => worker.calls.filter(c => c === "prepare").length < 2 });
    await drain(h.runner);
    await approve(h.confirmations, runId);
    await drain(h.runner);
    expect((await run(runId)).run.status).toBe("REVOKED");
    expect(worker.calls).not.toContain("submit");
  });

  it("duplicate executions after one approval submit at most once", async () => {
    const runId = await bookingRun();
    const worker = scriptedClient();
    const h = harness({ client: worker.factory });
    await drain(h.runner);
    await approve(h.confirmations, runId);
    await Promise.all([drain(h.runner), drain(harness({ client: worker.factory }).runner)]);
    expect(worker.calls.filter(c => c === "submit").length).toBeLessThanOrEqual(1);
  });

  it("a crash before the dispatch claim retries safely without submitting", async () => {
    const runId = await bookingRun();
    // Preparations: 1 = review preview (session then held; the approval probe reuses it without a
    // worker call), 2 = the booking step's in-session re-verification (pre-claim).
    const worker = scriptedClient({ failPrepareAt: 2 });
    const h = harness({ client: worker.factory });
    await drain(h.runner);
    await approve(h.confirmations, runId);
    await drain(h.runner);
    expect(worker.calls).not.toContain("submit");
    const detail = await run(runId);
    expect(detail.run.status).toBe("RETRY_SCHEDULED");
    expect(detail.steps.find(s => s.blockId === "book")).toMatchObject({ status: "RETRY_SCHEDULED", errorClass: "TRANSIENT" });
  });

  it("a crash after the claim needs reconciliation and is never resubmitted", async () => {
    const runId = await bookingRun();
    const worker = scriptedClient({ submit: () => "crash" });
    const h = harness({ client: worker.factory });
    await drain(h.runner);
    await approve(h.confirmations, runId);
    await drain(h.runner);
    await drain(h.runner);
    const detail = await run(runId);
    expect(detail.run.status).toBe("RECONCILIATION_REQUIRED");
    expect(worker.calls.filter(c => c === "submit")).toHaveLength(1);
  });

  it("an ambiguous outcome inspects the receipt read-only before asking for reconciliation", async () => {
    const unknown = await bookingRun();
    const worker = scriptedClient({ submit: () => "unknown" });
    const h = harness({ client: worker.factory });
    await drain(h.runner);
    await approve(h.confirmations, unknown);
    await drain(h.runner);
    expect((await run(unknown)).run.status).toBe("RECONCILIATION_REQUIRED");
    expect(worker.calls.slice(worker.calls.indexOf("submit"))).toEqual(["submit", "inspect_receipt", "close"]);

    const found = await bookingRun();
    const recovered = scriptedClient({ submit: () => "unknown", inspect: () => "found" });
    const h2 = harness({ client: recovered.factory });
    await drain(h2.runner);
    await approve(h2.confirmations, found);
    await drain(h2.runner);
    expect((await run(found)).run.status).toBe("COMPLETED");
    expect(recovered.calls.filter(c => c === "submit")).toHaveLength(1);
  });

  it("does not inspect an ambiguous submission after authority is revoked", async () => {
    const runId = await bookingRun();
    let allowed = true;
    const worker = scriptedClient({ submit: () => { allowed = false; return "unknown"; }, inspect: () => "found" });
    const h = harness({ client: worker.factory, authorize: async () => allowed });
    await drain(h.runner);
    await approve(h.confirmations, runId);
    await drain(h.runner);
    expect((await run(runId)).run.status).toBe("RECONCILIATION_REQUIRED");
    expect(worker.calls).not.toContain("inspect_receipt");
    expect(worker.calls.filter(c => c === "submit")).toHaveLength(1);
  });

  it("keeps the original cancellation signal during receipt inspection", async () => {
    const runId = await bookingRun();
    const controller = new AbortController();
    const worker = scriptedClient({ submit: () => "unknown", inspect: () => "found" });
    let inspectionCancelled = false;
    const h = harness({ executionSignal: controller.signal, client: () => {
      const client = worker.factory();
      return { ...client, get revision() { return client.revision; }, get nextActionId() { return client.nextActionId; },
        request: async (request, signal) => {
          if (request.command === "inspect_receipt") {
            controller.abort();
            inspectionCancelled = signal.aborted;
            if (signal.aborted) throw new BrowserUseClientError("ABORTED");
          }
          return client.request(request, signal);
        },
      };
    } });
    await drain(h.runner);
    await approve(h.confirmations, runId);
    await drain(h.runner);
    expect(inspectionCancelled).toBe(true);
    expect((await run(runId)).run.status).toBe("RECONCILIATION_REQUIRED");
  });

  it("login walls, missing details and unknown sites pause with a useful reason instead of guessing", async () => {
    const login = await bookingRun();
    const walled = scriptedClient({ observe: () => "login" });
    await drain(harness({ client: walled.factory }).runner);
    expect((await run(login)).run).toMatchObject({ status: "CONNECTION_REQUIRED" });
    expect((await run(login)).run.pauseReason).toMatch(/sign in/i);

    const missing = await bookingRun({ name: "Ada Lovelace", preferred_time: "19:00" });
    const unused = scriptedClient();
    await drain(harness({ client: unused.factory }).runner);
    expect((await run(missing)).run).toMatchObject({ status: "INPUT_REQUIRED" });
    expect((await run(missing)).run.pauseReason).toMatch(/party size.*contact email|contact email.*party size/i);
    expect(unused.factory).not.toHaveBeenCalled();

    const unknownSite = await bookingRun();
    const none = scriptedClient();
    await drain(harness({ client: none.factory, policies: new BrowserUsePolicyRegistry() }).runner);
    expect((await run(unknownSite)).run.status).toBe("CONNECTION_REQUIRED");
    expect(none.factory).not.toHaveBeenCalled();
  });
});

// Real worker + Browser Use + fixture through the durable runner.
const workerDir = resolve(import.meta.dirname, "../../browser-worker");
const python = join(workerDir, ".venv/bin/python");
const chromiumRoot = join(homedir(), "Library/Caches/ms-playwright");
const chromium = existsSync(chromiumRoot) ? readdirSync(chromiumRoot).filter(d => /^chromium-\d+$/.test(d)).sort().reverse()
  .map(d => join(chromiumRoot, d, "chrome-mac-arm64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing")).find(existsSync) : undefined;
(existsSync(python) && chromium ? describe : describe.skip)("real Browser Use worker through the durable runner", () => {
  let site: ChildProcess;
  let port = 0;
  const dir = mkdtempSync(join(tmpdir(), "bus-step-"));
  beforeAll(async () => {
    site = spawn(python, ["-m", "tests.fixture_site"], { cwd: workerDir, stdio: ["ignore", "pipe", "ignore"] });
    port = await new Promise<number>(done => site.stdout!.once("data", (chunk: Buffer) => done(Number(/PORT (\d+)/.exec(String(chunk))![1]))));
    mkdirSync(join(dir, "home"), { recursive: true });
  });
  afterAll(() => { site?.kill(); });
  const ledger = async () => (await (await fetch(`http://127.0.0.1:${port}/__control/ledger`)).json()) as { writes: { method: string; path: string; body: string }[]; reservations: Record<string, Record<string, string>> };

  it("zero writes while preparing and awaiting approval, then exactly one reservation", async () => {
    const origin = `http://fixture.humanos.test:${port}`;
    const runId = await bookingRun();
    const h = harness({ policies: policyRegistry(origin), client: () => createBrowserUseClient({ accountId: actor.accountId, runId }, {
      command: python, cwd: workerDir, home: join(dir, "home"),
      env: { HUMANOS_BROWSER_PROFILE_ROOT: join(dir, "profiles"), HUMANOS_BROWSER_CHROMIUM: chromium!, HUMANOS_BROWSER_FIXTURE_ORIGIN: origin },
    }) });
    await drain(h.runner);
    expect((await run(runId)).run.status).toBe("CONFIRMATION_REQUIRED");
    expect((await ledger()).writes).toEqual([]);
    await approve(h.confirmations, runId);
    await drain(h.runner);
    expect((await run(runId)).run.status).toBe("COMPLETED");
    const after = await ledger();
    expect(after.writes.map(w => `${w.method} ${w.path}`)).toEqual(["POST /reserve"]);
    expect(Object.values(after.reservations)).toEqual([{ ...FIELDS, slot: "1900" }]);
  }, 180000);
});
