import { describe, expect, it } from "vitest";
import { requestJson, type ModelConfig } from "../src/transport.js";
import { createContentGenerator } from "../src/index.js";
import type { ModelUsageAttempt } from "../src/usage.js";

describe("provider attempt accounting", () => {
  it("accounts for invalid-output recovery as a separate charged request", async () => {
    const events: ModelUsageAttempt[] = [];
    let calls = 0;
    const result = await createContentGenerator({ apiKey: "x", retries: 0,
      fetch: async () => Response.json({ model: "deepseek-v4.1-flash", usage: { prompt_tokens: 10, completion_tokens: 3 }, choices: [{ finish_reason: "stop", message: { content: ++calls === 1 ? '{"broken":true}' : "Hello" } }] }),
      onAttempt: async event => { events.push(event); },
    }).generate({ instruction: "Write a greeting", context: {}, outputSchema: "text", maxCharacters: 20 });
    expect(result).toEqual({ outputSchema: "text", text: "Hello" });
    const completed = events.filter(event => event.status === "completed");
    expect(completed).toHaveLength(2);
    expect(completed[0]?.requestId).not.toBe(completed[1]?.requestId);
    expect(completed.reduce((sum, event) => sum + (event.inputTokens ?? 0), 0)).toBe(20);
  });
  it("marks a timeout as unknown rather than a free failed call", async () => {
    const events: Array<{ status: string; inputTokens: number | null }> = [];
    await expect(requestJson({ apiKey: "x", timeoutMs: 5, fetch: () => new Promise(() => {}),
      onAttempt: async event => { events.push(event); } }, "https://example.com", { model: "test" })).rejects.toMatchObject({ code: "MODEL_TIMEOUT" });
    expect(events.map(event => event.status)).toEqual(["started", "unknown"]);
    expect(events[1]?.inputTokens).toBeNull();
  });
  it("retains usage from every retry and does not leak request content", async () => {
    const events: any[] = [];
    let calls = 0;
    const config: ModelConfig = { apiKey: "private", retries: 1,
      fetch: async () => ++calls === 1 ? new Response("", { status: 429 }) : Response.json({ model: "deepseek-test", usage: { prompt_tokens: 20, completion_tokens: 5 } }),
      onAttempt: async (event: any) => { events.push(event); },
    } as ModelConfig;
    await requestJson(config, "https://example.com", { model: "deepseek-test", messages: ["private prompt"] });
    expect(events.map(e => e.status)).toEqual(["started", "failed", "started", "completed"]);
    expect(events[3]).toMatchObject({ inputTokens: 20, outputTokens: 5, attempt: 2 });
    expect(events[0].attemptId).toBe(events[1].attemptId);
    expect(events[0].requestId).toBe(events[3].requestId);
    expect(events[0].attemptId).not.toBe(events[3].attemptId);
    expect(JSON.stringify(events)).not.toContain("private");
  });
  it.each([
    [undefined, null, null],
    [{ input_tokens: 0, output_tokens: 0 }, 0, 0],
    [{ prompt_tokens: -1, completion_tokens: 4 }, null, 4],
    [{ input_tokens: 1.5, output_tokens: Number.MAX_SAFE_INTEGER + 1 }, null, null],
  ])("distinguishes reported zero from unavailable usage", async (usage, input, output) => {
    const events: any[] = [];
    await requestJson({ apiKey: "x", fetch: async () => Response.json({ usage }), onAttempt: async (e: any) => { events.push(e); } } as ModelConfig,
      "https://example.com", { model: "jev-test" });
    expect(events.at(-1)).toMatchObject({ inputTokens: input, outputTokens: output });
  });
  it("does not retry a paid response when recording its completion fails", async () => {
    let calls = 0;
    await expect(requestJson({ apiKey: "x", fetch: async () => { calls++; return Response.json({ usage: { input_tokens: 2, output_tokens: 3 } }); },
      onAttempt: async (e: any) => { if(e.status === "completed") throw new Error("database unavailable"); } } as ModelConfig,
      "https://example.com", { model: "jev-test" })).rejects.toThrow();
    expect(calls).toBe(1);
  });
  it("does not dispatch when the started record cannot persist", async () => {
    let calls = 0;
    await expect(requestJson({ apiKey: "x", fetch: async () => { calls++; return Response.json({}); }, onAttempt: async () => { throw new Error("database unavailable"); } } as ModelConfig,
      "https://example.com", { model: "jev-test" })).rejects.toThrow();
    expect(calls).toBe(0);
  });
});
