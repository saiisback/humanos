import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { spawn, type ChildProcess } from "node:child_process";
import { existsSync, mkdtempSync, mkdirSync, readdirSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { BrowserUseClientError, browserUseClientFactory, browserUseRuntimeConfig, createBrowserUseClient } from "../src/workflows/browser-use-client.js";

const scope = { accountId: "11155111:0x1111111111111111111111111111111111111111", runId: "run-1" };
const dir = mkdtempSync(join(tmpdir(), "bus-client-"));

/** A scripted stand-in worker for framing, timeout and scope failures. */
function fakeWorker(body: string): string {
  const file = join(dir, `worker-${Math.random().toString(36).slice(2)}.mjs`);
  writeFileSync(file, `import { createInterface } from "node:readline";
const rl = createInterface({ input: process.stdin });
const reply = (cmd, status, payload, extra = {}) => process.stdout.write(JSON.stringify({ protocolVersion: 1, accountId: cmd.accountId, runId: cmd.runId, sessionId: cmd.sessionId, actionId: cmd.actionId, observationRevision: cmd.observationRevision, status, payload, ...extra }) + "\\n");
const ready = cmd => reply(cmd, "ready", { runtime: { name: "browser-use", version: "0.13.10" }, policyId: "fixture-restaurant", origin: "https://fixture.example.com", profile: "dedicated" });
rl.on("line", line => { const cmd = JSON.parse(line); ${body} });`);
  return file;
}
const options = (script: string, extra: Partial<Parameters<typeof createBrowserUseClient>[1]> = {}) => ({
  command: process.execPath, args: [script], cwd: dir, env: { HUMANOS_BROWSER_PROFILE_ROOT: join(dir, "profiles") },
  startupTimeoutMs: 2000, actionTimeoutMs: 1000, ...extra,
});
const signal = () => new AbortController().signal;

describe("BrowserUseClient framing and isolation", () => {
  it("binds requests to one session and parses typed results", async () => {
    const client = createBrowserUseClient(scope, options(fakeWorker(`if (cmd.command === "start") ready(cmd); else reply(cmd, "closed", {});`)));
    const ready = await client.request({ command: "start", payload: { policyId: "fixture-restaurant" } }, signal());
    expect(ready).toMatchObject({ status: "ready", actionId: 1, sessionId: client.sessionId, ...scope });
    expect(client.sessionId).toMatch(/^bus-[0-9a-f-]{36}$/);
    await client.close();
  });

  it("passes only server configuration to the worker, never the API's secrets", async () => {
    process.env.OPENCODE_API_KEY = "sk-must-not-leak";
    const client = createBrowserUseClient(scope, options(fakeWorker(`reply(cmd, "handoff", { reason: "POLICY_BLOCKED", message: Object.keys(process.env).filter(k => !/^(PATH|HOME|HUMANOS_BROWSER_[A-Z_]+|__CF_USER_TEXT_ENCODING)$/.test(k)).join(",") || "none" });`)));
    const reply = await client.request({ command: "start", payload: { policyId: "fixture-restaurant" } }, signal());
    expect(reply.status === "handoff" && reply.payload.message).toBe("none");
    delete process.env.OPENCODE_API_KEY;
    await client.close();
  });

  it("rejects replies for another session or action and kills the worker", async () => {
    const client = createBrowserUseClient(scope, options(fakeWorker(`reply(cmd, "closed", {}, { sessionId: "bus-someone-else" });`)));
    await expect(client.request({ command: "start", payload: { policyId: "fixture-restaurant" } }, signal())).rejects.toMatchObject({ code: "PROTOCOL" });
    await expect(client.request({ command: "observe", payload: {} }, signal())).rejects.toMatchObject({ code: "CLOSED" });
  });

  it("bounds worker output and never surfaces raw worker text", async () => {
    const client = createBrowserUseClient(scope, options(fakeWorker(`process.stderr.write("secret-cookie=abc\\n"); process.stdout.write("x".repeat(300 * 1024));`)));
    const error = await client.request({ command: "start", payload: { policyId: "fixture-restaurant" } }, signal()).catch(e => e);
    expect(error).toBeInstanceOf(BrowserUseClientError);
    expect(error.code).toBe("PROTOCOL");
    expect(String(error.message)).not.toContain("secret");
  });

  it("times out startup and actions, and aborts on signal", async () => {
    const silent = createBrowserUseClient(scope, options(fakeWorker(`/* never replies */`), { startupTimeoutMs: 200 }));
    await expect(silent.request({ command: "start", payload: { policyId: "fixture-restaurant" } }, signal())).rejects.toMatchObject({ code: "TIMEOUT" });
    const slow = createBrowserUseClient(scope, options(fakeWorker(`if (cmd.command === "start") ready(cmd);`), { actionTimeoutMs: 200 }));
    await slow.request({ command: "start", payload: { policyId: "fixture-restaurant" } }, signal());
    await expect(slow.request({ command: "observe", payload: {} }, signal())).rejects.toMatchObject({ code: "TIMEOUT" });
    const aborted = createBrowserUseClient(scope, options(fakeWorker(`if (cmd.command === "start") ready(cmd);`)));
    await aborted.request({ command: "start", payload: { policyId: "fixture-restaurant" } }, signal());
    const controller = new AbortController();
    const pending = aborted.request({ command: "observe", payload: {} }, controller.signal);
    controller.abort();
    await expect(pending).rejects.toMatchObject({ code: "ABORTED" });
  });

  it("is disabled unless the operator opts in and configures every path", () => {
    const full = { HUMANOS_BROWSER_DRIVER: "browser-use", HUMANOS_BROWSER_WORKER_PYTHON: "/py", HUMANOS_BROWSER_PROFILE_DIR: "/profiles", HUMANOS_BROWSER_CHROMIUM: "/chrome" };
    expect(browserUseClientFactory({})).toBeNull();
    expect(browserUseClientFactory({ ...full, HUMANOS_BROWSER_DRIVER: "local-chromium" })).toBeNull();
    for (const key of ["HUMANOS_BROWSER_WORKER_PYTHON", "HUMANOS_BROWSER_PROFILE_DIR", "HUMANOS_BROWSER_CHROMIUM"] as const)
      expect(browserUseClientFactory({ ...full, [key]: " " })).toBeNull();
    expect(browserUseClientFactory(full)).toBeTypeOf("function");
    expect(browserUseRuntimeConfig(full).headless).toBe(false);
  });

  it("reports a missing runtime as unavailable rather than crashing", async () => {
    const client = createBrowserUseClient(scope, options("/nonexistent/worker.mjs", { command: "/nonexistent/python" }));
    await expect(client.request({ command: "start", payload: { policyId: "fixture-restaurant" } }, signal())).rejects.toMatchObject({ code: "UNAVAILABLE" });
  });
});

// Real worker + Browser Use + controlled local fixture. No live sites or accounts.
const workerDir = resolve(import.meta.dirname, "../../browser-worker");
const python = join(workerDir, ".venv/bin/python");
const chromiumRoot = join(homedir(), "Library/Caches/ms-playwright");
const chromium = existsSync(chromiumRoot) ? readdirSync(chromiumRoot).filter(d => /^chromium-\d+$/.test(d)).sort().reverse()
  .map(d => join(chromiumRoot, d, "chrome-mac-arm64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing")).find(existsSync) : undefined;
const realWorker = existsSync(python) && chromium ? describe : describe.skip;

realWorker("BrowserUseClient against the real Browser Use worker", () => {
  let site: ChildProcess;
  let port = 0;
  beforeAll(async () => {
    site = spawn(python, ["-m", "tests.fixture_site"], { cwd: workerDir, stdio: ["ignore", "pipe", "ignore"] });
    port = await new Promise<number>((done, fail) => {
      site.stdout!.once("data", (chunk: Buffer) => { const match = /PORT (\d+)/.exec(String(chunk)); if (match) done(Number(match[1])); else fail(new Error("no port")); });
    });
  });
  afterAll(() => { site?.kill(); });

  it("starts, observes and closes a Browser Use session", async () => {
    const home = join(dir, "home");
    mkdirSync(home, { recursive: true });
    const client = createBrowserUseClient(scope, {
      command: python, args: ["-m", "humanos_browser.worker"], cwd: workerDir, home,
      env: { HUMANOS_BROWSER_PROFILE_ROOT: join(dir, "real-profiles"), HUMANOS_BROWSER_CHROMIUM: chromium!, HUMANOS_BROWSER_FIXTURE_ORIGIN: `http://fixture.humanos.test:${port}` },
    });
    try {
      const ready = await client.request({ command: "start", payload: { policyId: "fixture-restaurant" } }, signal());
      expect(ready.status === "ready" && ready.payload.runtime).toEqual({ name: "browser-use", version: "0.13.10" });
      const observed = await client.request({ command: "observe", payload: {} }, signal());
      expect(observed.status === "observed" && observed.payload.candidates.map(c => c.id)).toEqual(["select:slot-1900", "select:slot-2000"]);
    } finally {
      await client.close();
    }
  }, 90000);
});
