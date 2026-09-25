import { expect, it } from "vitest";
import * as v from "valibot";
import {
  ActionProposalDraftSchema,
  CapabilitySchema,
  JevAssessmentSchema,
} from "../src/domain.js";
it("rejects unknown capabilities", () => {
  expect(v.safeParse(CapabilitySchema, "shell.exec").success).toBe(false);
});
it("rejects model invented properties", () => {
  expect(
    v.safeParse(ActionProposalDraftSchema, {
      type: "READ_DOCUMENT",
      capability: "documents.read",
      payload: {},
      reason: "Read input",
      admin: true,
    }).success,
  ).toBe(false);
});
it("rejects malformed assessments", () => {
  expect(v.safeParse(JevAssessmentSchema, { confidence: 2 }).success).toBe(
    false,
  );
});
