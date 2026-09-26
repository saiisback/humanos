import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { assertEndpoint, assertToolContract, decodeResult, MAX_MCP_RESPONSE_BYTES, type McpProvider, type ReviewedTool } from "./policy.js";

/** Internal only: callers must supply checked-in, reviewed provider contracts, never model output. */
export async function openReviewedMcpSession(provider: McpProvider, token: string, contracts: readonly ReviewedTool[], request: typeof fetch = fetch) {
  if (!token.trim() || !contracts.length) throw new Error("MCP_SETUP_REQUIRED");
  const reviewed = new Map(structuredClone(contracts).map(tool => [tool.name, tool]));
  const client = new Client({ name: "humanos", version: "0.1.0" });
  const transport = new StreamableHTTPClientTransport(new URL(assertEndpoint(provider)), {
    requestInit: { headers: { Authorization: `Bearer ${token}` } },
    fetch: createGuardedMcpFetch(provider, request),
    reconnectionOptions: { maxRetries: 0, initialReconnectionDelay: 1000, maxReconnectionDelay: 1000, reconnectionDelayGrowFactor: 1 },
  });
  try {
    // SDK 1.30.1 declares optional Transport.sessionId more narrowly than its
    // own HTTP implementation under exactOptionalPropertyTypes. Runtime SDK
    // handshake is covered by the transport test; keep this adaptation local.
    await client.connect(transport as Parameters<Client["connect"]>[0], { timeout: 15000 });
    const listing = await client.listTools({}, { timeout: 15000 });
    for (const expected of reviewed.values()) {
      const actual = listing.tools.find(tool => tool.name === expected.name);
      if (!actual) throw new Error("MCP_SCHEMA_CHANGED");
      assertToolContract(expected, actual);
    }
  } catch {
    await client.close().catch(() => {});
    throw new Error("MCP_SETUP_REQUIRED");
  }
  return {
    async call(name: string, args: Record<string, unknown>, signal: AbortSignal): Promise<unknown> {
      if (!reviewed.has(name)) throw new Error("MCP_TOOL_NOT_REVIEWED");
      signal.throwIfAborted();
      let result: unknown;
      try { result = await client.callTool({ name, arguments: args }, undefined, { signal, timeout: 30000 }); }
      catch { throw new Error("MCP_UNKNOWN_OUTCOME"); }
      return decodeResult(result);
    },
    close: () => client.close(),
  };
}

/** Exact endpoint pinning prevents credential-forwarding redirects and arbitrary MCP hosts. */
export function createGuardedMcpFetch(provider: McpProvider, request: typeof fetch = fetch): typeof fetch {
  const endpoint = assertEndpoint(provider);
  return async (input, init) => {
    const url = input instanceof Request ? input.url : String(input);
    if (url !== endpoint) throw new Error("MCP_ENDPOINT_NOT_ALLOWED");
    let response: Response;
    try {
      response = await request(input, { ...init, redirect: "error" });
    } catch {
      throw new Error("MCP_TRANSPORT_FAILED");
    }
    if (!response.body) return response;
    const reader = response.body.getReader();
    let total = 0;
    const body = new ReadableStream<Uint8Array>({
      async pull(controller) {
        try {
          const chunk = await reader.read();
          if (chunk.done) { controller.close(); return; }
          total += chunk.value.byteLength;
          if (total > MAX_MCP_RESPONSE_BYTES) {
            await reader.cancel();
            controller.error(new Error("MCP_RESPONSE_TOO_LARGE"));
            return;
          }
          controller.enqueue(chunk.value);
        } catch { controller.error(new Error("MCP_TRANSPORT_FAILED")); }
      },
      cancel(reason) { return reader.cancel(reason); },
    });
    return new Response(body, { status: response.status, statusText: response.statusText, headers: response.headers });
  };
}
