import { describe, expect, it, vi } from "vitest";
import type { WorkflowSelection } from "@humanos/schemas";
import type { AssemblyInput, WorkflowSelector } from "../src/index.js";
import { assembleWorkflow, computeCandidates, createDefaultCatalog, AssemblyReviewError, ASSEMBLY_THRESHOLDS } from "../src/index.js";

const catalog = createDefaultCatalog();
it("supplies the whole server-authored sequence for evaluating partial steps", async () => {
  const seen: unknown[] = [];
  const select: WorkflowSelector["select"] = async input => {
    seen.push((input as unknown as Record<string, unknown>).plannedSteps);
    return {selectedCandidateId: input.candidates[0]!.id, parameters: {}, confidence: 1, alignment: 1, risk: 0, injection: 0, needsReview: false, reasonCodes: []};
  };
  await assembleWorkflow({...base(), completionSequence: ["research.web", "content.generate"]}, {select}, catalog);
  expect(seen).toEqual([["research.web", "content.generate"], ["research.web", "content.generate"]]);
});
const base = () => ({
  goal: "Find sources and draft a short note",
  draft: { nodes: [] },
  allowedCapabilities: ["web.search"] as const,
  inputs: {
    "research.web": { value: { query: "eth tokyo" } },
    "content.generate": { value: { brief: { instruction: "Draft a note", context: {}, outputSchema: "text", maxCharacters: 100 } }, parameterOptions: { "brief.outputSchema": ["text", "email"] as const } },
  },
});
const scripted = (choices: readonly string[], overrides: Partial<WorkflowSelection> = {}): WorkflowSelector => {
  let turn = 0;
  return { select: async ({ candidates }) => {
    const wanted = choices[turn++];
    const selectedCandidateId = candidates.find((candidate) => candidate.type === wanted)?.id ?? "invented";
    return { selectedCandidateId, parameters: {}, confidence: 0.95, alignment: 0.95, risk: 0.05, injection: 0,
      needsReview: false, reasonCodes: [], ...overrides };
  } };
};

describe("workflow assembly", () => {
  it("ends an audited sequence deterministically after every block passes Jev without fabricating a completion decision", async () => {
    const select = vi.fn(scripted(["content.generate"]).select);
    const result = await assembleWorkflow({ ...base(), completionSequence: ["content.generate"] }, { select }, catalog);
    expect(select).toHaveBeenCalledTimes(1);
    expect(result.graph.nodes.map(n => n.type)).toEqual(["content.generate"]);
    expect(result.trace.map(t => t.selectedType)).toEqual(["content.generate"]);
    await expect(assembleWorkflow({ ...base(), completionSequence: ["content.generate"] }, scripted(["content.generate"], { injection: 0.5 }), catalog)).rejects.toThrow("REVIEW_REQUIRED");
  });
  it("offers one deterministic candidate per available catalog type", () => {
    const input = base();
    const first = computeCandidates(input, catalog);
    expect(first.map((candidate) => candidate.type)).toEqual(["content.generate", "research.web"]);
    expect(computeCandidates(input, catalog)).toEqual(first);
    expect(first.find((candidate) => candidate.type === "research.web")?.parameterOptions).toEqual({});
  });

  it("assembles only offered nodes and retains the original draft", async () => {
    const input = base();
    const result = await assembleWorkflow(input, scripted(["research.web", "content.generate", "complete"]), catalog);
    expect(result.graph.nodes.map((node) => node.type)).toEqual(["research.web", "content.generate"]);
    expect(result.trace).toHaveLength(3);
    expect(result.trace.every((item) => /^0x[\da-f]{64}$/.test(item.decisionHash))).toBe(true);
    expect(input.draft.nodes).toEqual([]);
  });

  it("binds research output into the content brief context", async () => {
    const input = base();
    const configured = {
      ...input,
      inputs: { ...input.inputs, "content.generate": {
        value: { brief: { instruction: "Draft from sources", context: { $ref: "assembly_node_1.sources" }, outputSchema: "text", maxCharacters: 100 } },
      } },
    };
    expect(computeCandidates(configured, catalog).map((candidate) => candidate.type)).not.toContain("content.generate");
    const result = await assembleWorkflow(configured, scripted(["research.web", "content.generate", "complete"]), catalog);
    expect(result.graph.nodes[1]?.input.brief).toEqual({ instruction: "Draft from sources", context: { $ref: "assembly_node_1.sources" }, outputSchema: "text", maxCharacters: 100 });
  });

  it("rejects an invented choice without mutating the draft", async () => {
    const input = base();
    await expect(assembleWorkflow(input, scripted(["shell.exec"]), catalog)).rejects.toThrow("INVALID_SELECTION");
    expect(input.draft.nodes).toEqual([]);
  });

  it("explains a review stop with bounded diagnostics and unchanged thresholds", async () => {
    const failure = await assembleWorkflow(base(), scripted(["research.web"], { confidence: 0.49, needsReview: true, reasonCodes: ["ambiguous_destination", "<img src=x onerror=alert(1)>"] }), catalog).catch(error => error);
    expect(failure).toBeInstanceOf(AssemblyReviewError);
    expect(failure.message).toBe("REVIEW_REQUIRED");
    expect(failure.diagnostics).toMatchObject({ turn: 0, proposedStep: "research.web", failedChecks: ["needs_review", "confidence"], confidence: 0.49 });
    expect(failure.diagnostics.reasonCodes[0]).toBe("ambiguous_destination");
    expect(failure.diagnostics.reasonCodes.join(" ")).not.toMatch(/[<>=()]/);
    expect(ASSEMBLY_THRESHOLDS).toEqual({ minConfidence: 0.7, minAlignment: 0.7, maxRisk: 0.3, maxInjection: 0.1 });
  });

  it("fails closed on a low confidence or flagged choice", async () => {
    for (const overrides of [{ confidence: 0.49 }, { needsReview: true }, { injection: 0.9 }]) {
      await expect(assembleWorkflow(base(), scripted(["research.web"], overrides), catalog)).rejects.toThrow("REVIEW_REQUIRED");
    }
  });

  it("does not offer missing capability or fabricated input blocks", () => {
    const input = { ...base(), allowedCapabilities: [] };
    expect(computeCandidates(input, catalog).map((candidate) => candidate.type)).toEqual(["content.generate"]);
    expect(computeCandidates({ ...input, inputs: {} }, catalog)).toEqual([]);
  });

  it("rejects arbitrary text parameter options before invoking the selector", async () => {
    const input = base();
    const poisoned = { ...input, inputs: { ...input.inputs, "content.generate": { ...input.inputs["content.generate"], parameterOptions: { outputSchema: ["secret-token"] } } } };
    await expect(assembleWorkflow(poisoned as unknown as AssemblyInput, scripted(["content.generate"]), catalog)).rejects.toThrow("INVALID_PARAMETER_OPTIONS");
  });

  it("rejects a selected parameter outside its offered choices", async () => {
    const selector = scripted(["content.generate"], { parameters: { "brief.outputSchema": "form_fields" } });
    await expect(assembleWorkflow(base(), selector, catalog)).rejects.toThrow("INVALID_PARAMETERS");
  });

  it("offers browser fallback only for an explicit unsupported effect and opt-in", () => {
    const input = { ...base(), allowedCapabilities: ["web.search", "application.submit"] as const,
      inputs: { ...base().inputs, "browser.navigate": { value: { url: "https://example.org/apply" } } } };
    const offered = (state: AssemblyInput) => computeCandidates(state, catalog).map((candidate) => candidate.type);
    expect(offered(input)).not.toContain("browser.navigate");
    expect(offered({ ...input, browserFallbackAllowed: true })).not.toContain("browser.navigate");
    expect(offered({ ...input, browserFallbackAllowed: true, unsupportedExternalEffect: true })).toContain("browser.navigate");
  });

  it("times out a selector that never returns within the total assembly budget", async () => {
    vi.useFakeTimers();
    try {
      const result = assembleWorkflow(base(), { select: () => new Promise(() => {}) }, catalog);
      const rejection = expect(result).rejects.toThrow("ASSEMBLY_TIMEOUT");
      await vi.advanceTimersByTimeAsync(60_000);
      await rejection;
    } finally { vi.useRealTimers(); }
  });

  it("uses a unique generated node ID when the draft already contains an assembly ID", async () => {
    const draft = { nodes: [{ id: "assembly_node_2", type: "human.confirm" as const, blockVersion: "1.0.0", dependsOn: [], input: {}, capability: null, timeoutMs: 1000, maxAttempts: 1 }] };
    const result = await assembleWorkflow({ ...base(), draft }, scripted(["research.web", "complete"]), catalog);
    expect(result.graph.nodes.map((node) => node.id)).toEqual(["assembly_node_2", "assembly_node_3"]);
  });

  it("passes evolving block history to Jev each turn", async () => {
    const histories: unknown[] = [];
    const delegate = scripted(["research.web", "content.generate", "complete"]);
    await assembleWorkflow(base(), { select: (request) => {
      histories.push(request.history);
      return delegate.select(request);
    } }, catalog);
    expect(histories).toEqual([[], ["research.web"], ["research.web", "content.generate"]]);
  });

  it("rejects parameter choices that cannot form a valid block input", () => {
    const input = base();
    const invalid = { ...input, inputs: { ...input.inputs, "content.generate": {
      ...input.inputs["content.generate"], parameterOptions: { "brief.maxCharacters": [-1, 100] },
    } } };
    expect(() => computeCandidates(invalid, catalog)).toThrow("INVALID_PARAMETER_OPTIONS");
  });

  it("does not offer a string input bound to an array output", () => {
    const first = { id: "research", type: "research.web" as const, blockVersion: "1.0.0", dependsOn: [], input: { query: "eth tokyo" }, capability: "web.search" as const, timeoutMs: 1000, maxAttempts: 1 };
    const state = { ...base(), draft: { nodes: [first] }, inputs: { "content.transform": {
      value: { brief: { instruction: "Reword", context: {}, outputSchema: "text", maxCharacters: 100 }, sourceRef: { $ref: "research.sources" } },
    } } };
    expect(computeCandidates(state, catalog).map((candidate) => candidate.type)).not.toContain("content.transform");
  });

  it("returns a typed error when no configured input is available", async () => {
    await expect(assembleWorkflow({ ...base(), inputs: {} }, scripted(["complete"]), catalog)).rejects.toThrow("NO_CANDIDATES");
  });

  it("rejects a draft that contains a capability absent from assembly policy", async () => {
    const draft = { nodes: [{ id: "research", type: "research.web" as const, blockVersion: "1.0.0", dependsOn: [], input: { query: "eth tokyo" }, capability: "web.search" as const, timeoutMs: 1000, maxAttempts: 1 }] };
    const input = { ...base(), draft, allowedCapabilities: [] };
    expect(() => computeCandidates(input, catalog)).toThrow("DISALLOWED_DRAFT");
    await expect(assembleWorkflow(input, scripted(["complete"]), catalog)).rejects.toThrow("DISALLOWED_DRAFT");
  });

  it("rejects a draft browser node without both fallback policy gates", async () => {
    const draft = { nodes: [{ id: "browser", type: "browser.navigate" as const, blockVersion: "1.0.0", dependsOn: [], input: { url: "https://example.org" }, capability: null, timeoutMs: 1000, maxAttempts: 1 }] };
    const input = { ...base(), draft };
    await expect(assembleWorkflow(input, scripted(["complete"]), catalog)).rejects.toThrow("DISALLOWED_DRAFT");
    await expect(assembleWorkflow({ ...input, browserFallbackAllowed: true }, scripted(["complete"]), catalog)).rejects.toThrow("DISALLOWED_DRAFT");
    await expect(assembleWorkflow({ ...input, browserFallbackAllowed: true, unsupportedExternalEffect: true }, scripted(["complete"]), catalog)).resolves.toMatchObject({ graph: draft });
  });

  it("offers text-to-string binding after generated text", () => {
    const draft = { nodes: [{ id: "draft_text", type: "content.generate" as const, blockVersion: "1.0.0", dependsOn: [],
      input: { brief: { instruction: "Draft", context: {}, outputSchema: "text", maxCharacters: 100 } }, capability: null, timeoutMs: 1000, maxAttempts: 1 }] };
    const input = { ...base(), draft, inputs: { "content.transform": { value: {
      brief: { instruction: "Rewrite", context: {}, outputSchema: "text", maxCharacters: 100 }, sourceRef: { $ref: "draft_text.text" },
    } } } };
    expect(computeCandidates(input, catalog).map((candidate) => candidate.type)).toContain("content.transform");
  });

  it("binds the authored goal into decision hashes", async () => {
    const one = await assembleWorkflow(base(), scripted(["research.web", "complete"]), catalog);
    const two = await assembleWorkflow({ ...base(), goal: "Find sources about a different topic" }, scripted(["research.web", "complete"]), catalog);
    expect(one.trace[0]?.decisionHash).not.toBe(two.trace[0]?.decisionHash);
    expect(one.trace[0]?.stateHash).not.toBe(two.trace[0]?.stateHash);
  });
});
