import { expect, it } from "vitest";
import { classifyWorkflowGoal, workflowInputs } from "../src/workflows/bindings.js";
it("routes only explicit Linear creation to scoped reviewed connector steps", () => {
  const goal = "Create a Linear issue: fix the mobile menu overflow";
  expect(classifyWorkflowGoal(goal).kind).toBe("linear");
  const input = workflowInputs(goal);
  expect(input.allowedCapabilities).toEqual(["linear.issue.create"]);
  expect(input.completionSequence).toEqual(["content.generate", "human.confirm", "connector.call"]);
  expect(input.inputs?.["connector.call"]?.value).toMatchObject({ connectorId: "linear", operationId: "linear.issue.create" });
  expect(classifyWorkflowGoal("Draft only a Linear issue about login").kind).toBe("draft");
  expect(classifyWorkflowGoal("Delete a Linear issue").kind).toBe("clarify");
  expect(classifyWorkflowGoal("Create three Linear issues").kind).toBe("clarify");
  expect(classifyWorkflowGoal("Create a Linear issue").kind).toBe("clarify");
});
