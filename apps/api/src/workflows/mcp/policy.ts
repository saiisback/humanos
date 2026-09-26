import { hashCanonical } from "@humanos/schemas";

export type McpProvider = "linear" | "notion";
const endpoints = new Map<McpProvider, string>([
  ["linear", "https://mcp.linear.app/mcp"], ["notion", "https://mcp.notion.com/mcp"],
]);
export const MAX_MCP_RESPONSE_BYTES = 1024 * 1024;
export function assertEndpoint(provider: string): string {
  const endpoint = endpoints.get(provider as McpProvider);
  if (!endpoint) throw new Error("MCP_PROVIDER_NOT_ALLOWED");
  return endpoint;
}

export interface ToolSchema { name: string; inputSchema: Record<string, unknown>; outputSchema?: Record<string, unknown> | undefined }
export type ReviewedTool = ToolSchema | { name: string; schemaHash: string };
export function assertToolContract(expected: ReviewedTool, actual: ToolSchema): void {
  if ("schemaHash" in expected) {
    if (expected.name !== actual.name || expected.schemaHash !== hashCanonical({ input: actual.inputSchema, output: actual.outputSchema ?? null })) throw new Error("MCP_SCHEMA_CHANGED");
    return;
  }
  if (expected.name !== actual.name || hashCanonical(expected.inputSchema) !== hashCanonical(actual.inputSchema) ||
      hashCanonical(expected.outputSchema ?? null) !== hashCanonical(actual.outputSchema ?? null)) {
    throw new Error("MCP_SCHEMA_CHANGED");
  }
}

export function decodeResult(result: unknown): unknown {
  if (!result || typeof result !== "object") throw new Error("MCP_INVALID_RESULT");
  if (Buffer.byteLength(JSON.stringify(result), "utf8") > MAX_MCP_RESPONSE_BYTES) throw new Error("MCP_RESPONSE_TOO_LARGE");
  const record = result as Record<string, unknown>;
  if (record.isError === true) throw new Error("MCP_TOOL_ERROR");
  if (record.structuredContent && typeof record.structuredContent === "object") return record.structuredContent;
  if (!Array.isArray(record.content) || record.content.length !== 1 || record.content[0]?.type !== "text") throw new Error("MCP_INVALID_RESULT");
  try { return JSON.parse(record.content[0].text); }
  catch { throw new Error("MCP_INVALID_RESULT"); }
}

export function validateReceiptUrl(provider: McpProvider, value: string): string {
  let url: URL;
  try { url = new URL(value); } catch { throw new Error("MCP_INVALID_RECEIPT_URL"); }
  const hosts = provider === "linear" ? ["linear.app"] : provider === "notion" ? ["www.notion.so", "notion.so"] : [];
  if (url.protocol !== "https:" || url.username || url.password || url.port || !hosts.includes(url.hostname)) {
    throw new Error("MCP_INVALID_RECEIPT_URL");
  }
  return url.href;
}
