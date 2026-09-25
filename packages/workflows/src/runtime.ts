import { hashCanonical, type ErrorClass, type Hex, type StepRun, type WorkflowNode } from "@humanos/schemas";
import type { EffectClass } from "./catalog.js";
import type { ValidatedGraph } from "./graph.js";

export function readySteps(graph: ValidatedGraph, steps: readonly StepRun[]): readonly WorkflowNode[] {
  const byBlock = new Map(steps.map((step) => [step.blockId, step]));
  return graph.order.filter((node) => byBlock.get(node.id)?.status === "PENDING" && node.dependsOn.every((id) => byBlock.get(id)?.status === "COMPLETED"));
}
export function retryDecision(input: { effect: EffectClass; error: ErrorClass; attempt: number; maxAttempts: number }): "retry" | "fail" | "reconcile" {
  if ((input.effect === "reversible_write" || input.effect === "irreversible_write") && (input.error === "UNKNOWN_OUTCOME" || input.error === "TIMEOUT")) return "reconcile";
  if ((input.error === "TRANSIENT" || input.error === "TIMEOUT") && input.attempt < input.maxAttempts) return "retry";
  return "fail";
}
export function stepIdempotencyKey(input: { versionId: string; runId: string; nodeId: string; occurrenceId: string; inputHash: Hex }): Hex {
  return hashCanonical([input.versionId, input.runId, input.nodeId, input.occurrenceId, input.inputHash]);
}
