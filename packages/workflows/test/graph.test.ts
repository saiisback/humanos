import { describe, expect, it } from "vitest";
import type { JsonValue, WorkflowGraph, WorkflowNode } from "@humanos/schemas";
import { createDefaultCatalog, validateWorkflowGraph } from "../src/index.js";

const node = (id: string, type: WorkflowNode["type"], dependsOn: string[], input: Record<string, JsonValue> = {}): WorkflowNode => ({ id, type, blockVersion: "1.0.0", dependsOn, input, capability: null, timeoutMs: 1000, maxAttempts: 3 });
const graph = (...nodes: WorkflowNode[]): WorkflowGraph => ({ nodes });

describe("graph validation", () => {
  it("topologically orders dependencies", () => {
    const result = validateWorkflowGraph(graph(node("b", "control.join", ["a"]), node("a", "control.join", [])), createDefaultCatalog());
    expect(result.order.map((item) => item.id)).toEqual(["a", "b"]);
  });
  it.each([
    graph(node("a", "control.join", ["b"]), node("b", "control.join", ["a"])),
    graph(node("a", "control.join", ["missing"])),
    graph(node("a", "control.join", []), node("b", "control.join", [])),
    graph(node("a", "browser.submit", [], { destination: "https://example.com", payload: {} })),
    graph(node("a", "control.join", []), node("b", "control.join", ["a", "a"])),
    graph(node("a", "control.join", []), node("b", "control.join", ["a"], { value: { $ref: "missing.value" } })),
  ])("rejects invalid graph %#", (candidate) => {
    expect(() => validateWorkflowGraph(candidate, createDefaultCatalog())).toThrow();
  });
  it("requires confirmation to dominate a submit", () => {
    const candidate = graph(node("root", "control.join", []), node("confirm", "human.confirm", ["root"]), node("work", "control.join", ["root"]), { ...node("submit", "browser.submit", ["work"], { destination: "https://example.com", payload: {} }), capability: "application.submit" });
    expect(() => validateWorkflowGraph(candidate, createDefaultCatalog())).toThrow("CONFIRMATION_REQUIRED");
  });
  it("rejects an extra executable field alongside a bound reference", () => {
    const candidate = graph(node("a", "human.input", [], { prompt: "What?" }), node("b", "control.branch", ["a"], { valueRef: { $ref: "a.value" }, equals: "yes", shell: "run" }));
    expect(() => validateWorkflowGraph(candidate, createDefaultCatalog())).toThrow("INVALID_BLOCK_INPUT");
  });
  it("accepts a reference to an ancestor output field", () => {
    const candidate = graph(node("a", "human.input", [], { prompt: "What?" }), node("b", "control.branch", ["a"], { valueRef: { $ref: "a.value" }, equals: "yes" }));
    expect(validateWorkflowGraph(candidate, createDefaultCatalog()).order.map((item) => item.id)).toEqual(["a", "b"]);
  });
  it("rejects removing a required catalog capability", () => {
    const candidate = graph(node("a", "research.web", [], { query: "source" }));
    expect(() => validateWorkflowGraph(candidate, createDefaultCatalog())).toThrow("UNSUPPORTED_CAPABILITY");
  });
  it("binds the selected generated-content variant output", () => {
    const candidate = graph(
      node("a", "content.generate", [], { brief: { instruction: "write", context: {}, outputSchema: "text", maxCharacters: 100 } }),
      node("b", "control.branch", ["a"], { valueRef: { $ref: "a.text" }, equals: "yes" }),
    );
    expect(validateWorkflowGraph(candidate, createDefaultCatalog()).order.map((item) => item.id)).toEqual(["a", "b"]);
    const wrongVariant = graph(candidate.nodes[0]!, node("b", "control.branch", ["a"], { valueRef: { $ref: "a.body" }, equals: "yes" }));
    expect(() => validateWorkflowGraph(wrongVariant, createDefaultCatalog())).toThrow("UNBOUND_REFERENCE");
  });
  it("requires an approval ancestor before a calendar write", () => {
    const candidate = graph({ ...node("a", "calendar.create", [], { title: "Meet", startsAt: "2026-09-26T00:00:00.000Z", endsAt: "2026-09-26T01:00:00.000Z" }), capability: "calendar.create" });
    expect(() => validateWorkflowGraph(candidate, createDefaultCatalog())).toThrow("CONFIRMATION_REQUIRED");
  });
});
