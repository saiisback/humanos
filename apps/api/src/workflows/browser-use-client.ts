import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { randomUUID } from "node:crypto";
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
  request(command: BrowserUseRequest, signal: AbortSignal): Promise<BrowserWorkerResult>;
  close(): Promise<void>;
}

export function createBrowserUseClient(scope: { accountId: string; runId: string }, options: BrowserUseClientOptions): BrowserUseClient {
  const sessionId = `bus-${randomUUID()}`;
  const channel = createBrowserWorkerScope({ ...scope, sessionId });
  const startupTimeout = options.startupTimeoutMs ?? 30_000;
  const actionTimeout = options.actionTimeoutMs ?? 30_000;
  let child: ChildProcessWithoutNullStreams | null = null;
  let closed = false;
  let buffer = "";
  let waiter: { resolve(line: string): void; reject(error: BrowserUseClientError): void } | null = null;
  let queue: Promise<unknown> = Promise.resolve();

  function fail(code: BrowserUseClientErrorCode): BrowserUseClientError {
    const error = new BrowserUseClientError(code);
    if (!closed) {
      closed = true;
      child?.kill("SIGKILL");
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
    const worker = spawn(options.command, options.args ?? ["-m", "humanos_browser.worker"], { cwd: options.cwd, env, stdio: "pipe" });
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
    request(request, signal) {
      // One outstanding request per session: action ids and revisions stay strictly ordered.
      const next = queue.then(() => exchange(request, signal));
      queue = next.catch(() => undefined);
      return next;
    },
    async close() {
      if (closed || !child) { closed = true; return; }
      try {
        await this.request({ command: "close", payload: {} }, AbortSignal.timeout(Math.min(actionTimeout, 10_000)));
      } catch { /* killed below */ }
      closed = true;
      child.kill("SIGTERM");
      const worker = child;
      setTimeout(() => worker.kill("SIGKILL"), 5000).unref();
    },
  };
}
