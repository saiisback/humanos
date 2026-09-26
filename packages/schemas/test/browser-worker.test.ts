import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  BROWSER_WORKER_MAX_MESSAGE_BYTES,
  createBrowserWorkerScope,
  parseBrowserWorkerCommand,
  parseBrowserWorkerResult,
  encodeBrowserWorkerMessage,
} from "../src/browser-worker.js";
import { hashCanonical } from "../src/canonicalize.js";

// Shared with the Python worker's tests so both sides accept and reject the same messages.
const vectors = JSON.parse(readFileSync(new URL("../../../apps/browser-worker/tests/fixtures/protocol-vectors.json", import.meta.url), "utf8"));
const scope = vectors.scope as { accountId: string; runId: string; sessionId: string };
const line = (value: unknown) => JSON.stringify(value);

describe("browser worker protocol", () => {
  it("accepts every shared valid command and round-trips it byte-for-byte", () => {
    for (const command of vectors.validCommands) {
      const parsed = parseBrowserWorkerCommand(line(command));
      expect(parsed).toEqual(command);
      expect(encodeBrowserWorkerMessage(parsed)).toBe(`${line(command)}\n`);
    }
  });

  it.each(vectors.invalidCommands as { why: string; value: unknown }[])(
    "rejects $why", ({ value }) => {
      expect(() => parseBrowserWorkerCommand(line(value))).toThrow();
    });

  it("rejects oversized and malformed frames before parsing", () => {
    const big = { ...vectors.validCommands[3], payload: { fields: { name: "x".repeat(BROWSER_WORKER_MAX_MESSAGE_BYTES) } } };
    expect(() => parseBrowserWorkerCommand(line(big))).toThrow("MESSAGE_TOO_LARGE");
    expect(() => parseBrowserWorkerCommand("{not json")).toThrow();
    expect(() => parseBrowserWorkerCommand(`${line(vectors.validCommands[1])}\n${line(vectors.validCommands[1])}`)).toThrow();
  });

  it("binds results to the exact account, run, session and action", () => {
    const [ready, observed] = vectors.validResults;
    expect(parseBrowserWorkerResult(line(ready), { ...scope, actionId: 1 }).status).toBe("ready");
    expect(parseBrowserWorkerResult(line(observed), { ...scope, actionId: 2 }).status).toBe("observed");
    for (const expected of [
      { ...scope, accountId: "11155111:0x2222222222222222222222222222222222222222", actionId: 1 },
      { ...scope, runId: "run-2", actionId: 1 },
      { ...scope, sessionId: "bus-other", actionId: 1 },
      { ...scope, actionId: 9 },
    ]) expect(() => parseBrowserWorkerResult(line(ready), expected)).toThrow("SCOPE_MISMATCH");
    expect(() => parseBrowserWorkerResult(line({ ...ready, payload: { ...ready.payload, runtime: { name: "agent", version: "1" } } }), { ...scope, actionId: 1 })).toThrow();
    expect(() => parseBrowserWorkerResult(line({ ...observed, payload: { ...observed.payload, script: "x" } }), { ...scope, actionId: 2 })).toThrow();
  });

  it("rejects candidates observed at another revision", () => {
    const observed = vectors.validResults[1];
    const stale = { ...observed, payload: { ...observed.payload, candidates: [{ ...observed.payload.candidates[0], observationRevision: 0 }] } };
    expect(() => parseBrowserWorkerResult(line(stale), { ...scope, actionId: 2 })).toThrow("STALE_CANDIDATE");
  });

  it("scope issues strictly increasing action ids and refuses repeats or stale revisions", () => {
    const channel = createBrowserWorkerScope(scope);
    const start = channel.command("start", { policyId: "fixture-restaurant" });
    expect(start).toMatchObject({ ...scope, actionId: 1, observationRevision: 0, protocolVersion: 1 });
    channel.accept(parseBrowserWorkerResult(line(vectors.validResults[0]), channel.expecting(start)));
    const observe = channel.command("observe", {});
    expect(observe.actionId).toBe(2);
    channel.accept(parseBrowserWorkerResult(line(vectors.validResults[1]), channel.expecting(observe)));
    expect(channel.revision).toBe(1);
    // A replayed earlier result, or a result for a request never sent, is refused.
    expect(() => channel.accept(parseBrowserWorkerResult(line(vectors.validResults[1]), channel.expecting(observe)))).toThrow("REPLAYED_ACTION");
    // A revision that goes backwards means the worker's view is stale.
    const act = channel.command("act", { candidateId: "select:slot-1900" });
    const regressed = { ...vectors.validResults[1], actionId: act.actionId, observationRevision: 0, payload: { ...vectors.validResults[1].payload, candidates: [] } };
    expect(() => channel.accept(parseBrowserWorkerResult(line(regressed), channel.expecting(act)))).toThrow("STALE_OBSERVATION");
  });

  it("uses the same canonical hash as the Python worker", () => {
    expect(hashCanonical(vectors.canonicalHash.value)).toBe(vectors.canonicalHash.sha256);
  });
});
