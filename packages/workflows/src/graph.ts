import * as v from "valibot";
import { WorkflowGraphSchema, type WorkflowGraph, type WorkflowNode } from "@humanos/schemas";
import type { BlockDefinition, BlockRegistry } from "./catalog.js";

export interface ValidatedGraph { readonly nodes: readonly WorkflowNode[]; readonly order: readonly WorkflowNode[]; }

function references(value: unknown): string[] {
  if (Array.isArray(value)) return value.flatMap(references);
  if (value && typeof value === "object") {
    const record = value as Record<string, unknown>;
    if ("$ref" in record) {
      if (Object.keys(record).length !== 1 || typeof record.$ref !== "string") throw new Error("INVALID_REFERENCE");
      return [record.$ref];
    }
    return Object.values(record).flatMap(references);
  }
  return [];
}

function validateBlockInput(input: Record<string, unknown>, block: BlockDefinition): void {
  const schema = block.input as unknown as { entries?: Record<string, v.GenericSchema> };
  if (!schema.entries || Object.keys(input).some((key) => !(key in schema.entries!))) throw new Error("INVALID_BLOCK_INPUT");
  for (const [key, fieldSchema] of Object.entries(schema.entries)) {
    if (!(key in input)) throw new Error("INVALID_BLOCK_INPUT");
    const value = input[key];
    if (value && typeof value === "object" && !Array.isArray(value) && "$ref" in value) {
      if (Object.keys(value).length !== 1 || typeof (value as Record<string, unknown>).$ref !== "string") throw new Error("INVALID_REFERENCE");
    } else if (!v.safeParse(fieldSchema, value).success) throw new Error("INVALID_BLOCK_INPUT");
  }
}

export function validateWorkflowGraph(graph: WorkflowGraph, registry: BlockRegistry): ValidatedGraph {
  const parsed = v.parse(WorkflowGraphSchema, graph);
  const byId = new Map(parsed.nodes.map((node) => [node.id, node]));
  if (byId.size !== parsed.nodes.length) throw new Error("DUPLICATE_NODE");
  const children = new Map(parsed.nodes.map((node) => [node.id, [] as string[]]));
  const inDegree = new Map(parsed.nodes.map((node) => [node.id, node.dependsOn.length]));
  for (const node of parsed.nodes) {
    const block = registry.get(node.type);
    if (block.version !== node.blockVersion) throw new Error("UNSUPPORTED_BLOCK_VERSION");
    if (node.capability !== block.capability) throw new Error("UNSUPPORTED_CAPABILITY");
    if (new Set(node.dependsOn).size !== node.dependsOn.length) throw new Error("DUPLICATE_DEPENDENCY");
    for (const dependency of node.dependsOn) {
      if (!byId.has(dependency)) throw new Error("MISSING_DEPENDENCY");
      children.get(dependency)!.push(node.id);
    }
    validateBlockInput(node.input, block);
  }
  const queue = parsed.nodes.filter((node) => node.dependsOn.length === 0);
  const order: WorkflowNode[] = [];
  for (let cursor = 0; cursor < queue.length; cursor++) {
    const current = queue[cursor]!;
    order.push(current);
    for (const childId of children.get(current.id)!) {
      const next = inDegree.get(childId)! - 1;
      inDegree.set(childId, next);
      if (next === 0) queue.push(byId.get(childId)!);
    }
  }
  if (order.length !== parsed.nodes.length) throw new Error("CYCLIC_GRAPH");
  if (parsed.nodes.length > 0 && parsed.nodes.filter((node) => node.dependsOn.length === 0).length !== 1) throw new Error("UNREACHABLE_NODE");
  const ancestors = new Map<string, Set<string>>();
  for (const node of order) {
    const preceding = new Set<string>();
    for (const dependency of node.dependsOn) {
      preceding.add(dependency);
      for (const ancestor of ancestors.get(dependency)!) preceding.add(ancestor);
    }
    ancestors.set(node.id, preceding);
    for (const ref of references(node.input)) {
      const [source, field, ...rest] = ref.split(".");
      if (!source || !field || rest.length > 0 || !preceding.has(source)) throw new Error("UNBOUND_REFERENCE");
      const sourceNode = byId.get(source)!;
      const sourceBlock = registry.get(sourceNode.type);
      const output = sourceBlock.output as unknown as { entries?: Record<string, unknown> };
      const brief = sourceNode.input.brief as { outputSchema?: string } | undefined;
      const variantFields = brief?.outputSchema ? sourceBlock.outputVariants?.[brief.outputSchema] : undefined;
      if (!(output.entries && field in output.entries) && !variantFields?.includes(field)) throw new Error("UNBOUND_REFERENCE");
    }
    const block = registry.get(node.type);
    if (block.requiresConfirmation && ![...preceding].some((id) => byId.get(id)!.type === "human.confirm")) throw new Error("CONFIRMATION_REQUIRED");
  }
  return { nodes: parsed.nodes, order };
}
