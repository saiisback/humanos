import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import {
  BROWSER_WORKER_MAX_MESSAGE_BYTES, createBrowserWorkerScope, encodeBrowserWorkerMessage, parseBrowserWorkerResult,
  type BrowserWorkerCommandName, type BrowserWorkerPayload, type BrowserWorkerResult,
} from "@humanos/schemas";

/**
 * Runner-side bridge to the local Browser Use worker: one child process per browser
 * session, newline-framed JSON over pipes (never a network port). Errors carry codes
 * only; worker stderr is discarded so page text, cookies or typed values never surface.
 */
export type BrowserUseClientErrorCode = "UNAVAILABLE" | "TIMEOUT" | "ABORTED" | "PROTOCOL" | "CLOSED";
export class BrowserUseClientError extends Error {
  constructor(readonly code: BrowserUseClientErrorCode) { super(`BROWSER_WORKER_${code}`); }
}

export interface BrowserUseClientOptions {
  /** Server-configured interpreter (HUMANOS_BROWSER_WORKER_PYTHON); never request input. */
  command: string;
  args?: string[];
  cwd: string;
  /** Explicit worker configuration. The API process environment is never inherited. */
  env: Record<string, string>;
  /** Home directory for the browser process; defaults to the server user's. */
  home?: string;
  startupTimeoutMs?: number;
  actionTimeoutMs?: number;
}
export type BrowserUseRequest = { [C in BrowserWorkerCommandName]: { command: C; payload: BrowserWorkerPayload<C> } }[BrowserWorkerCommandName];
export interface BrowserUseClient {
  readonly sessionId: string;
  /** Latest observation revision accepted from the worker. */
  readonly revision: number;
  /** Action id of the next request (valid while no other request is queued). */
  readonly nextActionId: number;
  /** False once the worker exited, failed, or was closed; a dead session is never reused. */
  readonly alive: boolean;
  request(command: BrowserUseRequest, signal: AbortSignal): Promise<BrowserWorkerResult>;
  close(): Promise<void>;
}

/** Location of the Python worker package in this repository. */
export const BROWSER_WORKER_DIR = fileURLToPath(new URL("../../../browser-worker", import.meta.url));

export interface BrowserUseRuntimeConfig {
  enabled: boolean;
  python: string | null;
  profileRoot: string | null;
  chromium: string | null;
  headless: boolean;
}
/** Server configuration only: every path comes from the operator's environment, never a request. */
export function browserUseRuntimeConfig(env: NodeJS.ProcessEnv): BrowserUseRuntimeConfig {
  const value = (key: string) => env[key]?.trim() || null;
  return {
    enabled: env.HUMANOS_BROWSER_DRIVER === "browser-use",
    python: value("HUMANOS_BROWSER_WORKER_PYTHON"),
    profileRoot: value("HUMANOS_BROWSER_PROFILE_DIR"),
    chromium: value("HUMANOS_BROWSER_CHROMIUM"),
    headless: env.HUMANOS_BROWSER_HEADLESS === "true",
  };
}
/** Null unless the operator opted in and configured every required path. */
export function browserUseClientFactory(env: NodeJS.ProcessEnv): ((scope: { accountId: string; runId: string }) => BrowserUseClient) | null {
  const config = browserUseRuntimeConfig(env);
  if (!config.enabled || !config.python || !config.profileRoot || !config.chromium) return null;
  return scope => createBrowserUseClient(scope, {
    command: config.python!, cwd: BROWSER_WORKER_DIR,
    env: { HUMANOS_BROWSER_PROFILE_ROOT: config.profileRoot!, HUMANOS_BROWSER_CHROMIUM: config.chromium!,
      // Visible by default so the user can sign in and take over; headless only on request.
      HUMANOS_BROWSER_HEADLESS: config.headless ? "true" : "false" },
  });
}

export function createBrowserUseClient(scope: { accountId: string; runId: string }, options: BrowserUseClientOptions): BrowserUseClient {
  const sessionId = `bus-${randomUUID()}`;
  const channel = createBrowserWorkerScope({ ...scope, sessionId });
  const startupTimeout = options.startupTimeoutMs ?? 30_000;
  const actionTimeout = options.actionTimeoutMs ?? 30_000;
  let child: ChildProcessWithoutNullStreams | null = null;
  let processClosed: Promise<void> = Promise.resolve();
  let terminated = false;
  let closed = false;
  let buffer = "";
  let waiter: { resolve(line: string): void; reject(error: BrowserUseClientError): void } | null = null;
  let queue: Promise<unknown> = Promise.resolve();

  function terminateWorker(): void {
    if (!child || terminated) return;
    terminated = true;
    // POSIX detached spawning creates a private process group. Browser Use's
    // Chromium children inherit it, so killing Python alone would orphan them.
    // Signal only this owned group, once; never search by browser/process name or
    // schedule a later PID kill that could target a reused identifier.
    if (process.platform !== "win32" && child.pid) {
      try { process.kill(-child.pid, "SIGKILL"); }
      catch (error) { if ((error as NodeJS.ErrnoException).code !== "ESRCH") child.kill("SIGKILL"); }
    } else child.kill("SIGKILL");
  }

  function fail(code: BrowserUseClientErrorCode): BrowserUseClientError {
    const error = new BrowserUseClientError(code);
    if (!closed) {
      closed = true;
      terminateWorker();
    }
    waiter?.reject(error);
    waiter = null;
    return error;
  }
  function spawnWorker(): ChildProcessWithoutNullStreams {
    const env: Record<string, string> = {
      PATH: process.env.PATH ?? "/usr/bin:/bin",
      HOME: options.home ?? process.env.HOME ?? "",
      ...options.env,
    };
    const worker = spawn(options.command, options.args ?? ["-m", "humanos_browser.worker"], {
      cwd: options.cwd, env, stdio: "pipe", detached: process.platform !== "win32",
    });
    processClosed = new Promise(resolve => worker.once("close", () => resolve()));
    worker.on("error", () => fail("UNAVAILABLE"));
    worker.on("exit", () => { if (!closed) fail("CLOSED"); });
    worker.stderr.resume(); // drained, never logged: may echo page or site data
    worker.stdout.setEncoding("utf8");
    worker.stdout.on("data", (chunk: string) => {
      buffer += chunk;
      let index: number;
      while ((index = buffer.indexOf("\n")) >= 0) {
        const line = buffer.slice(0, index);
        buffer = buffer.slice(index + 1);
        if (!waiter) return void fail("PROTOCOL"); // unsolicited output
        const current = waiter;
        waiter = null;
        current.resolve(line);
      }
      if (Buffer.byteLength(buffer, "utf8") > BROWSER_WORKER_MAX_MESSAGE_BYTES) fail("PROTOCOL");
    });
    worker.stdin.on("error", () => fail("CLOSED"));
    return worker;
  }

  async function exchange(request: BrowserUseRequest, signal: AbortSignal): Promise<BrowserWorkerResult> {
    if (closed) throw new BrowserUseClientError("CLOSED");
    if (signal.aborted) throw fail("ABORTED");
    const starting = !child;
    if (starting && request.command !== "start") throw new BrowserUseClientError("PROTOCOL");
    child ??= spawnWorker();
    const sent = channel.command(request.command, request.payload as never);
    const line = await new Promise<string>((resolve, reject) => {
      const timer = setTimeout(() => fail("TIMEOUT"), starting ? startupTimeout : actionTimeout);
      const onAbort = () => fail("ABORTED");
      signal.addEventListener("abort", onAbort, { once: true });
      const done = () => { clearTimeout(timer); signal.removeEventListener("abort", onAbort); };
      waiter = { resolve: value => { done(); resolve(value); }, reject: error => { done(); reject(error); } };
      child!.stdin.write(encodeBrowserWorkerMessage(sent), error => { if (error) fail("CLOSED"); });
    });
    try {
      return channel.accept(parseBrowserWorkerResult(line, channel.expecting(sent)));
    } catch {
      throw fail("PROTOCOL");
    }
  }

  return {
    sessionId,
    get revision() { return channel.revision; },
    get nextActionId() { return channel.nextActionId; },
    get alive() { return !closed; },
    request(request, signal) {
      // One outstanding request per session: action ids and revisions stay strictly ordered.
      const next = queue.then(() => exchange(request, signal));
      queue = next.catch(() => undefined);
      return next;
    },
    async close() {
      if (closed || !child) { closed = true; await processClosed; return; }
      try {
        await this.request({ command: "close", payload: {} }, AbortSignal.timeout(Math.min(actionTimeout, 10_000)));
      } catch { /* killed below */ }
      closed = true;
      terminateWorker();
      await processClosed;
    },
  };
}
