import { it, expect } from "vitest";
import { classifyWorkflowGoal, workflowInputs } from "../src/workflows/bindings.js";
it.each([
  "Write a short restaurant reservation inquiry template in English. Draft only; do not send anything.",
  "Draft a reservation inquiry for a restaurant",
  "Write a message asking to reserve a table. Draft only.",
])("keeps reservation-related drafts content-only: %s", goal => {
  expect(classifyWorkflowGoal(goal).kind).toBe("draft");
  expect(workflowInputs(goal).completionSequence).toEqual(["content.generate"]);
  expect(workflowInputs(goal).allowedCapabilities).toEqual([]);
});
it("separates draft-only mail from sending and never invents recipients", () => {
  expect(classifyWorkflowGoal("Draft an email to test@example.com, do not send it").kind).toBe("draft");
  expect(classifyWorkflowGoal("Write a friendly introduction email draft").kind).toBe("draft");
  expect(classifyWorkflowGoal("Draft a welcome email").kind).toBe("draft");
  expect(classifyWorkflowGoal("Draft and send an email to test@example.com").kind).toBe("email");
  expect(classifyWorkflowGoal("Send an email to test@example.com saying hello")).toMatchObject({ kind: "email", recipient: "test@example.com" });
  expect(classifyWorkflowGoal("Send an email").kind).toBe("clarify");
});
it("requires live research before generating an itinerary and pauses unsupported bookings", () => {
  expect(classifyWorkflowGoal("Plan a three day Japan itinerary").blocks).toEqual(["research.web", "content.generate"]);
  expect(classifyWorkflowGoal("Book a table for tonight").kind).toBe("clarify");
  const input = workflowInputs("Plan a Japan itinerary");
  expect(input.inputs["content.generate"]?.value.brief).toMatchObject({ context: { sources: { $ref: "assembly_node_1.sources" } } });
});
