import { describe, expect, it } from "vitest";
import { assertEndpoint, assertToolContract, decodeResult, validateReceiptUrl } from "../src/workflows/mcp/policy.js";

describe("MCP trust boundary (synthetic fixtures, not provider acceptance)", () => {
  it("rejectsUnknownEndpoint", () => {
    expect(assertEndpoint("linear")).toBe("https://mcp.linear.app/mcp");
    expect(() => assertEndpoint("https://localhost/mcp")).toThrow("MCP_PROVIDER_NOT_ALLOWED");
    expect(() => assertEndpoint("toString")).toThrow("MCP_PROVIDER_NOT_ALLOWED");
  });
  it("rejectsChangedToolSchema", () => {
    const schema = { type: "object", properties: { title: { type: "string" } }, required: ["title"] };
    expect(() => assertToolContract({ name: "fixture-create", inputSchema: schema }, { name: "fixture-create", inputSchema: schema })).not.toThrow();
    expect(() => assertToolContract({ name: "fixture-create", inputSchema: schema }, { name: "fixture-create", inputSchema: { type: "object" } })).toThrow("MCP_SCHEMA_CHANGED");
    expect(() => assertToolContract({ name: "fixture-create", inputSchema: schema }, { name: "delete", inputSchema: schema })).toThrow("MCP_SCHEMA_CHANGED");
  });
  it("rejectsToolErrorAndOversizedResponse", () => {
    expect(() => decodeResult({ isError: true, content: [{ type: "text", text: "secret provider detail" }] })).toThrow("MCP_TOOL_ERROR");
    expect(() => decodeResult({ content: [{ type: "text", text: "x".repeat(1048577) }] })).toThrow("MCP_RESPONSE_TOO_LARGE");
    expect(decodeResult({ content: [{ type: "text", text: '{"id":"fixture-1"}' }] })).toEqual({ id: "fixture-1" });
    expect(() => decodeResult({ content: [{ type: "text", text: "not json" }] })).toThrow("MCP_INVALID_RESULT");
  });
  it("rejectsUntrustedResultUrl", () => {
    expect(validateReceiptUrl("linear", "https://linear.app/team/issue/TEST-1")).toBe("https://linear.app/team/issue/TEST-1");
    for (const url of ["javascript:alert(1)", "https://linear.app.evil.com/issue/1", "https://user:password@linear.app/issue/1", "http://linear.app/issue/1", "https://linear.app:444/issue/1"]) {
      expect(() => validateReceiptUrl("linear", url)).toThrow("MCP_INVALID_RECEIPT_URL");
    }
    expect(() => validateReceiptUrl("notion", "https://linear.app/issue/1")).toThrow("MCP_INVALID_RECEIPT_URL");
  });
});
