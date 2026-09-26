import { expect, it } from "vitest";
import { createGuardedMcpFetch, openReviewedMcpSession } from "../src/workflows/mcp/client.js";

it("binds credentials to the exact provider endpoint and refuses redirects", async () => {
  const calls: Array<{url: string; init: RequestInit | undefined}> = [];
  const guarded = createGuardedMcpFetch("linear", async (url, init) => {
    calls.push({url: String(url), init}); return new Response("{}", { status: 200 });
  });
  await expect(guarded("https://evil.example/mcp", {})).rejects.toThrow("MCP_ENDPOINT_NOT_ALLOWED");
  expect(calls).toHaveLength(0);
  await guarded("https://mcp.linear.app/mcp", { method: "POST" });
  expect(calls[0]?.init?.redirect).toBe("error");
});

it("bounds response streams before SDK parsing, including unbounded chunked streams", async () => {
  let cancelled = false;
  const guarded = createGuardedMcpFetch("linear", async () => new Response(new ReadableStream({
    pull(controller) { controller.enqueue(new Uint8Array(600000)); },
    cancel() { cancelled = true; },
  })));
  const response = await guarded("https://mcp.linear.app/mcp");
  await expect(response.text()).rejects.toThrow("MCP_RESPONSE_TOO_LARGE");
  expect(cancelled).toBe(true);
});

it("redacts transport failures rather than surfacing secrets from remote exceptions", async () => {
  const guarded = createGuardedMcpFetch("notion", async () => { throw new Error("Bearer fixture-secret"); });
  await expect(guarded("https://mcp.notion.com/mcp")).rejects.toThrow("MCP_TRANSPORT_FAILED");
});

it("uses the SDK handshake, verifies schemas, and never dispatches an unreviewed tool", async () => {
  const methods: string[] = [];
  const schema = { type: "object" as const, properties: {} };
  const wire: typeof fetch = async (_url, init) => {
    if (init?.method === "GET") return new Response(null, { status: 405 });
    const message = JSON.parse(String(init?.body));
    methods.push(message.method);
    if (message.id === undefined) return new Response(null, { status: 202 });
    const result = message.method === "initialize"
      ? { protocolVersion: "2025-03-26", capabilities: { tools: {} }, serverInfo: { name: "fixture", version: "1" } }
      : message.method === "tools/list" ? { tools: [{ name: "fixture-read", inputSchema: schema }] }
      : { content: [{ type: "text", text: '{"id":"fixture-result"}' }] };
    return Response.json({ jsonrpc: "2.0", id: message.id, result });
  };
  const session = await openReviewedMcpSession("linear", "fixture-token", [{ name: "fixture-read", inputSchema: schema }], wire);
  try {
    await expect(session.call("delete-everything", {}, new AbortController().signal)).rejects.toThrow("MCP_TOOL_NOT_REVIEWED");
    expect(methods).not.toContain("tools/call");
    expect(await session.call("fixture-read", {}, new AbortController().signal)).toEqual({ id: "fixture-result" });
    expect(methods.filter(m => m === "tools/call")).toHaveLength(1);
  } finally { await session.close(); }
});
