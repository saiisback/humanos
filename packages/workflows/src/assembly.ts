import * as v from "valibot";
import {
  hashCanonical, WorkflowGraphSchema, WorkflowSelectionSchema,
  type BlockType, type Capability, type JsonValue, type WorkflowAssemblyCandidate,
  type WorkflowGraph, type WorkflowNode,
} from "@humanos/schemas";
import type { BlockDefinition, BlockRegistry } from "./catalog.js";
import { validateWorkflowGraph } from "./graph.js";
import type { WorkflowSelector } from "./ports.js";

export type PublicParameter = number | boolean | null | "text" | "email" | "form_fields" | "short" | "medium" | "long";
export interface AssemblyBlockInput {
  readonly value: Readonly<Record<string, JsonValue>>;
  readonly parameterOptions?: Readonly<Record<string, readonly PublicParameter[]>>;
}
export interface AssemblyState {
  readonly goal: string;
  readonly draft: WorkflowGraph;
  readonly allowedCapabilities: readonly Capability[];
  readonly inputs: Readonly<Partial<Record<BlockType, AssemblyBlockInput>>>;
  readonly browserFallbackAllowed?: boolean;
  readonly unsupportedExternalEffect?: boolean;
  /** Server-authored recipe only. Every block is still selected/evaluated by Jev;
   * graph termination itself is a deterministic count/type invariant. */
  readonly completionSequence?: readonly BlockType[];
}
export type AssemblyInput = AssemblyState;
export interface AssemblyDecisionTrace {
  readonly turn: number;
  readonly stateHash: string;
  readonly candidatesHash: string;
  readonly decisionHash: string;
  readonly selectedType: BlockType | "complete";
}
export interface AssemblyResult {
  readonly graph: WorkflowGraph;
  readonly trace: readonly AssemblyDecisionTrace[];
}

/** Why Jev's decision was not accepted. Model-supplied codes are bounded data, never instructions. */
export interface AssemblyReviewDiagnostics {
  readonly turn: number;
  readonly proposedStep: BlockType | "complete";
  readonly failedChecks: readonly ("needs_review" | "confidence" | "alignment" | "risk" | "injection")[];
  readonly confidence: number;
  readonly alignment: number;
  readonly risk: number;
  readonly injection: number;
  readonly reasonCodes: readonly string[];
}
export class AssemblyReviewError extends Error {
  constructor(readonly diagnostics: AssemblyReviewDiagnostics) { super("REVIEW_REQUIRED"); }
}
export const ASSEMBLY_THRESHOLDS = Object.freeze({ minConfidence: 0.7, minAlignment: 0.7, maxRisk: 0.3, maxInjection: 0.1 });

const publicStrings = new Set(["text", "email", "form_fields", "short", "medium", "long"]);
const MAX_NODES = 64;
const MAX_DECISIONS = 80;
const MAX_DURATION_MS = 60_000;

function clone<T>(value: T): T { return structuredClone(value); }
function validParameter(value: unknown): value is PublicParameter {
  return value === null || typeof value === "boolean" ||
    (typeof value === "number" && Number.isFinite(value)) ||
    (typeof value === "string" && publicStrings.has(value));
}
function optionsFor(config: AssemblyBlockInput): Record<string, PublicParameter[]> {
  const entries = Object.entries(config.parameterOptions ?? {});
  if (entries.length > 16) throw new Error("INVALID_PARAMETER_OPTIONS");
  const result: Record<string, PublicParameter[]> = {};
  for (const [name, choices] of entries) {
    if (name.length > 64 || name.split(".").some((part) =>
      !/^[a-zA-Z][a-zA-Z0-9_]*$/.test(part) ||
      ["__proto__", "constructor", "prototype"].includes(part)) ||
      !Array.isArray(choices) || choices.length < 1 || choices.length > 32 ||
      choices.some((choice) => !validParameter(choice)) || new Set(choices).size !== choices.length) throw new Error("INVALID_PARAMETER_OPTIONS");
    result[name] = [...choices];
  }
  return result;
}
function applyParameters(base: Readonly<Record<string, JsonValue>>, parameters: Record<string, JsonValue>, options: Record<string, PublicParameter[]>): Record<string, JsonValue> {
  const result = clone(base) as Record<string, JsonValue>;
  for (const [path, chosen] of Object.entries(parameters)) {
    if (!Object.hasOwn(options, path) || !options[path]!.some((option) => option === chosen)) throw new Error("INVALID_PARAMETERS");
    const parts = path.split(".");
    let target: Record<string, JsonValue> = result;
    for (const part of parts.slice(0, -1)) {
      const child = target[part];
      if (!child || Array.isArray(child) || typeof child !== "object" || "$ref" in child) throw new Error("INVALID_PARAMETERS");
      target = child as Record<string, JsonValue>;
    }
    const field = parts.at(-1)!;
    if (!Object.hasOwn(target, field) || field === "$ref") throw new Error("INVALID_PARAMETERS");
    target[field] = chosen;
  }
  return result;
}
function nodeFor(block: BlockDefinition, graph: WorkflowGraph, value: Readonly<Record<string, JsonValue>>): WorkflowNode {
  const last = graph.nodes.at(-1);
  const used = new Set(graph.nodes.map((node) => node.id));
  let serial = graph.nodes.length + 1;
  while (used.has(`assembly_node_${serial}`)) serial++;
  return {
    id: `assembly_node_${serial}`,
    type: block.type, blockVersion: block.version,
    dependsOn: last ? [last.id] : [], input: clone(value), capability: block.capability,
    timeoutMs: 30_000, maxAttempts: 3,
  };
}
function validateTypedReferences(graph: WorkflowGraph, registry: BlockRegistry): void {
  const byId = new Map(graph.nodes.map((node) => [node.id, node]));
  for (const node of graph.nodes) {
    const targetFields = registry.get(node.type).inputBindingKinds ?? {};
    for (const [field, value] of Object.entries(node.input)) {
      if (!value || Array.isArray(value) || typeof value !== "object" || !Object.hasOwn(value, "$ref")) continue;
      const reference = (value as Record<string, JsonValue>).$ref;
      if (typeof reference !== "string") throw new Error("INCOMPATIBLE_REFERENCE");
      const [sourceId, sourceField] = reference.split(".");
      const sourceNode = byId.get(sourceId!);
      if (!sourceNode || !sourceField) throw new Error("INCOMPATIBLE_REFERENCE");
      const sourceBlock = registry.get(sourceNode.type);
      const sourceKind = sourceBlock.outputBindingKinds?.[sourceField];
      if (!sourceKind || !targetFields[field] || sourceKind !== targetFields[field]) throw new Error("INCOMPATIBLE_REFERENCE");
    }
  }
}
function validateDraftPolicy(graph: WorkflowGraph, state: AssemblyState, registry: BlockRegistry): void {
  if (state.completionSequence) {
    if (!state.completionSequence.length || state.completionSequence.length > MAX_NODES || graph.nodes.length > state.completionSequence.length) throw new Error("INVALID_COMPLETION_SEQUENCE");
    for (const type of state.completionSequence) registry.get(type);
    if (graph.nodes.some((node, i) => node.type !== state.completionSequence![i])) throw new Error("INVALID_COMPLETION_SEQUENCE");
  }
  for (const node of graph.nodes) {
    const block = registry.get(node.type);
    if (block.capability && !state.allowedCapabilities.includes(block.capability)) throw new Error("DISALLOWED_DRAFT");
    if (block.executor === "browser" && (!state.browserFallbackAllowed || !state.unsupportedExternalEffect)) throw new Error("DISALLOWED_DRAFT");
  }
}
function candidateBlocks(state: AssemblyState, registry: BlockRegistry, deadline = Number.POSITIVE_INFINITY): Array<{ block: BlockDefinition; config: AssemblyBlockInput; options: Record<string, PublicParameter[]> }> {
  const seen = new Set<BlockType>();
  const candidates: Array<{ block: BlockDefinition; config: AssemblyBlockInput; options: Record<string, PublicParameter[]> }> = [];
  const hasConfiguredWrite = registry.list().some((definition) =>
    definition.requiresConfirmation && !!state.inputs[definition.type] &&
    (!definition.capability || state.allowedCapabilities.includes(definition.capability)) &&
    (definition.executor !== "browser" || (!!state.browserFallbackAllowed && !!state.unsupportedExternalEffect)));
  for (const block of [...registry.list()].sort((a, b) => a.type.localeCompare(b.type))) {
    if (Date.now() >= deadline) throw new Error("ASSEMBLY_TIMEOUT");
    if (seen.has(block.type)) throw new Error("DUPLICATE_BLOCK_TYPE");
    seen.add(block.type);
    const config = state.inputs[block.type] ?? (block.type === "human.confirm" && hasConfiguredWrite ? { value: {} } : undefined);
    if (!config) continue;
    if (state.completionSequence && state.completionSequence[state.draft.nodes.length] !== block.type) continue;
    const options = optionsFor(config);
    if (block.capability && !state.allowedCapabilities.includes(block.capability)) continue;
    if (block.executor === "browser" && (!state.browserFallbackAllowed || !state.unsupportedExternalEffect)) continue;
    if (state.draft.nodes.length >= MAX_NODES) continue;
    try {
      const baseGraph = { nodes: [...state.draft.nodes, nodeFor(block, state.draft, config.value)] };
      validateWorkflowGraph(baseGraph, registry);
      validateTypedReferences(baseGraph, registry);
      for (const [path, choices] of Object.entries(options)) {
        for (const choice of choices) {
          if (Date.now() >= deadline) throw new Error("ASSEMBLY_TIMEOUT");
          try {
            const value = applyParameters(config.value, { [path]: choice }, options);
            const proposedGraph = { nodes: [...state.draft.nodes, nodeFor(block, state.draft, value)] };
            validateWorkflowGraph(proposedGraph, registry);
            validateTypedReferences(proposedGraph, registry);
          } catch { throw new Error("INVALID_PARAMETER_OPTIONS"); }
        }
      }
      candidates.push({ block, config, options });
    } catch (error) {
      if (error instanceof Error && ["INVALID_PARAMETER_OPTIONS", "ASSEMBLY_TIMEOUT"].includes(error.message)) throw error;
      /* Unavailable typed input or invalid transition. */
    }
  }
  return candidates;
}
function mapCandidates(available: ReturnType<typeof candidateBlocks>, graph: WorkflowGraph): readonly WorkflowAssemblyCandidate[] {
  const candidates: WorkflowAssemblyCandidate[] = available.map(({ block, options }, index) => ({
    id: `c${index}`, type: block.type, description: block.type, parameterOptions: options,
  }));
  if (graph.nodes.length > 0) candidates.push({ id: `c${candidates.length}`, type: "complete", description: "Complete workflow", parameterOptions: {} });
  return candidates;
}
export function computeCandidates(state: AssemblyState, registry: BlockRegistry): readonly WorkflowAssemblyCandidate[] {
  validateWorkflowGraph(state.draft, registry);
  validateTypedReferences(state.draft, registry);
  validateDraftPolicy(state.draft, state, registry);
  return mapCandidates(candidateBlocks(state, registry), state.draft).filter(c => !state.completionSequence || c.type !== "complete");
}

async function selectWithinDeadline(selector: WorkflowSelector, input: Parameters<WorkflowSelector["select"]>[0], deadline: number) {
  const remaining = deadline - Date.now();
  if (remaining <= 0) throw new Error("ASSEMBLY_TIMEOUT");
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      selector.select(input),
      new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error("ASSEMBLY_TIMEOUT")), remaining); }),
    ]);
  } finally { if (timer) clearTimeout(timer); }
}

export async function assembleWorkflow(input: AssemblyInput, selector: WorkflowSelector, registry: BlockRegistry): Promise<AssemblyResult> {
  v.parse(WorkflowGraphSchema, input.draft);
  const graph: WorkflowGraph = clone(input.draft);
  validateWorkflowGraph(graph, registry);
  validateTypedReferences(graph, registry);
  validateDraftPolicy(graph, input, registry);
  const trace: AssemblyDecisionTrace[] = [];
  const deadline = Date.now() + MAX_DURATION_MS;
  for (let turn = 0; turn < MAX_DECISIONS; turn++) {
    if (Date.now() >= deadline) throw new Error("ASSEMBLY_TIMEOUT");
    const state = { ...input, draft: graph };
    if (input.completionSequence && graph.nodes.length === input.completionSequence.length) {
      validateWorkflowGraph(graph, registry);
      validateTypedReferences(graph, registry);
      validateDraftPolicy(graph, input, registry);
      return { graph, trace };
    }
    const available = candidateBlocks(state, registry, deadline);
    const candidates = mapCandidates(available, graph).filter(c => !input.completionSequence || c.type !== "complete");
    if (candidates.length === 0) throw new Error("NO_CANDIDATES");
    const stateHash = hashCanonical({ goal: input.goal, graph, allowedCapabilities: input.allowedCapabilities, inputs: input.inputs, browserFallbackAllowed: !!input.browserFallbackAllowed, unsupportedExternalEffect: !!input.unsupportedExternalEffect, completionSequence: input.completionSequence ?? null });
    const candidatesHash = hashCanonical(candidates);
    const selection = v.parse(WorkflowSelectionSchema, await selectWithinDeadline(selector, { goal: input.goal, stateHash, turn, history: graph.nodes.map((node) => node.type), candidates: [...candidates] }, deadline));
    const chosen = candidates.find((candidate) => candidate.id === selection.selectedCandidateId);
    if (!chosen) throw new Error("INVALID_SELECTION");
    const failedChecks = [
      ...(selection.needsReview ? ["needs_review" as const] : []),
      ...(selection.confidence < ASSEMBLY_THRESHOLDS.minConfidence ? ["confidence" as const] : []),
      ...(selection.alignment < ASSEMBLY_THRESHOLDS.minAlignment ? ["alignment" as const] : []),
      ...(selection.risk > ASSEMBLY_THRESHOLDS.maxRisk ? ["risk" as const] : []),
      ...(selection.injection > ASSEMBLY_THRESHOLDS.maxInjection ? ["injection" as const] : []),
    ];
    if (failedChecks.length) throw new AssemblyReviewError({
      turn, proposedStep: chosen.type, failedChecks,
      confidence: selection.confidence, alignment: selection.alignment, risk: selection.risk, injection: selection.injection,
      reasonCodes: selection.reasonCodes.slice(0, 8).map(code => code.replace(/[^\w .:-]/g, "").slice(0, 64)).filter(Boolean),
    });
    const options = chosen.type === "complete" ? {} : available.find((item) => item.block.type === chosen.type)!.options;
    const parameters = selection.parameters as Record<string, JsonValue>;
    if (chosen.type === "complete" && Object.keys(parameters).length > 0) throw new Error("INVALID_PARAMETERS");
    if (chosen.type !== "complete") {
      const found = available.find((item) => item.block.type === chosen.type)!;
      const value = applyParameters(found.config.value, parameters, options);
      const proposed = nodeFor(found.block, graph, value);
      validateWorkflowGraph({ nodes: [...graph.nodes, proposed] }, registry);
      validateTypedReferences({ nodes: [...graph.nodes, proposed] }, registry);
      graph.nodes.push(proposed);
    }
    trace.push({ turn, stateHash, candidatesHash, selectedType: chosen.type,
      decisionHash: hashCanonical({ stateHash, candidatesHash, selection }) });
    if (chosen.type === "complete") {
      validateWorkflowGraph(graph, registry);
      validateTypedReferences(graph, registry);
      validateDraftPolicy(graph, input, registry);
      return { graph, trace };
    }
  }
  throw new Error("ASSEMBLY_DECISION_LIMIT");
}
