import { expect, it } from "vitest";
import type { StepRun, WorkflowNode } from "@humanos/schemas";
import { createDefaultCatalog, readySteps, retryDecision, stepIdempotencyKey, validateWorkflowGraph } from "../src/index.js";

const node = (id: string, dependsOn: string[]): WorkflowNode => ({ id, type: "control.join", blockVersion: "1.0.0", dependsOn, input: {}, capability: null, timeoutMs: 1000, maxAttempts: 3 });
it("selects only pending nodes whose dependencies completed", () => {
  const graph = validateWorkflowGraph({ nodes: [node("a", []), node("b", ["a"]) ] }, createDefaultCatalog());
  expect(readySteps(graph, [{ blockId: "a", status: "COMPLETED" }, { blockId: "b", status: "PENDING" }] as StepRun[]).map((step) => step.id)).toEqual(["b"]);
});
it("reconciles uncertain irreversible effects and bounds retries", () => {
  expect(retryDecision({ effect: "irreversible_write", error: "UNKNOWN_OUTCOME", attempt: 1, maxAttempts: 3 })).toBe("reconcile");
  expect(retryDecision({ effect: "read", error: "TRANSIENT", attempt: 3, maxAttempts: 3 })).toBe("fail");
  expect(retryDecision({ effect: "read", error: "TRANSIENT", attempt: 1, maxAttempts: 3 })).toBe("retry");
});
it("reconciles uncertain reversible writes instead of retrying them", () => {
  expect(retryDecision({ effect: "reversible_write", error: "TIMEOUT", attempt: 1, maxAttempts: 3 })).toBe("reconcile");
  expect(retryDecision({ effect: "reversible_write", error: "UNKNOWN_OUTCOME", attempt: 1, maxAttempts: 3 })).toBe("reconcile");
});
it("derives a stable idempotency key from all inputs", () => {
  const input = { versionId: "v", runId: "r", nodeId: "n", occurrenceId: "o", inputHash: `0x${"a".repeat(64)}` as const };
  expect(stepIdempotencyKey(input)).toBe(stepIdempotencyKey(input));
  expect(stepIdempotencyKey({ ...input, occurrenceId: "other" })).not.toBe(stepIdempotencyKey(input));
});
