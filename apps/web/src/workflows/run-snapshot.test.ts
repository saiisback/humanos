import { expect, it } from "vitest";
import { loadRunSnapshot } from "./run-snapshot";

it("starts output loading without waiting for status and starts approval loading without waiting for outputs", async () => {
  let finishRun!: (value: string) => void;
  let finishOutputs!: (value: string[]) => void;
  const run = new Promise<string>(resolve => { finishRun = resolve; });
  const outputs = new Promise<string[]>(resolve => { finishOutputs = resolve; });
  const events: string[] = [];
  const loading = loadRunSnapshot(
    () => { events.push("status"); return run; },
    () => { events.push("outputs"); return outputs; },
    async value => { events.push(`approval:${value}`); return "review"; },
  );
  expect(events).toEqual(["status", "outputs"]);
  finishRun("ready");
  await Promise.resolve(); await Promise.resolve();
  expect(events).toEqual(["status", "outputs", "approval:ready"]);
  finishOutputs(["draft"]);
  expect(await loading).toEqual({ run: "ready", outputs: ["draft"], preview: "review" });
});

it("propagates an output failure instead of presenting a successful snapshot", async () => {
  await expect(loadRunSnapshot(async () => "ready", async () => { throw new Error("offline"); }, async () => null)).rejects.toThrow("offline");
});
