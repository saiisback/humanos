import { it, expect } from "vitest";
import { classifyWorkflowGoal, workflowInputs } from "../src/workflows/bindings.js";
import { assembleWorkflow, createDefaultCatalog } from "@humanos/workflows";

it("assembles the real email bindings through draft, confirmation and connector", async () => {
  const goal = "Send an email to test@example.com saying hello";
  const result = await assembleWorkflow({ goal, draft: { nodes: [] }, ...workflowInputs(goal) }, {
    // Only the remote evaluator is substituted; routing, catalog and graph are real.
    select: async input => ({ selectedCandidateId: input.candidates[0]!.id, parameters: {}, confidence: 1, alignment: 1, risk: 0, injection: 0, needsReview: false, reasonCodes: [] }),
  }, createDefaultCatalog());
  expect(result.graph.nodes.map(n => n.type)).toEqual(["content.generate", "human.confirm", "connector.call"]);
  expect(result.graph.nodes[2]!.input.arguments).toEqual({ to: "test@example.com", subject: { $ref: "assembly_node_1.subject" }, body: { $ref: "assembly_node_1.body" } });
});

it("asks for booking details and a site when no production recipe exists", () => {
  const intent = classifyWorkflowGoal("Book a table in Tokyo");
  expect(intent.kind).toBe("clarify");
  expect(intent.prompt).toMatch(/date/i);
  expect(intent.prompt).toMatch(/time/i);
  expect(intent.prompt).toMatch(/party size/i);
  expect(intent.prompt).toMatch(/reservation name/i);
  expect(intent.prompt).toMatch(/site/i);
  expect(workflowInputs("Book a table in Tokyo").allowedCapabilities).toEqual([]);
});
it.each([
  "Draft three social posts about HumanOS. Draft only; do not publish anything.",
  "Draft a status update: JAW login works; research is being tested. Draft only; do not send anything.",
])("does not mistake draft subject matter for an external action: %s", goal => {
  expect(classifyWorkflowGoal(goal).kind).toBe("draft");
  expect(workflowInputs(goal).completionSequence).toEqual(["content.generate"]);
  expect(workflowInputs(goal).allowedCapabilities).toEqual([]);
});
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
