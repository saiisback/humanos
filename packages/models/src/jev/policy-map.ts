import * as v from "valibot";
import { JevAssessmentSchema, type AssessmentFlags } from "@humanos/schemas";
import { JEV_MODEL, QUESTION_VERSION } from "./questions.js";
/** Conservative provisional thresholds; synthetic regression checks are not live calibration. */
export const JEV_THRESHOLDS = Object.freeze({
  confidence: 0.8,
  alignment: 0.8,
  injection: 0.2,
  review: 0.2,
});
export function applyJevThresholds(input: unknown): AssessmentFlags {
  const result = v.safeParse(JevAssessmentSchema, input);
  if (!result.success)
    return {
      block: true,
      requireReview: true,
      minimumRisk: "SENSITIVE",
      reasons: ["Invalid assessment"],
    };
  const a = result.output;
  const reasons: string[] = [];
  if (a.modelVersion !== JEV_MODEL || a.questionVersion !== QUESTION_VERSION)
    reasons.push("Unpinned assessment version");
  if (a.confidence < JEV_THRESHOLDS.confidence) reasons.push("Low confidence");
  if (!a.missionAligned || a.missionAlignmentScore < JEV_THRESHOLDS.alignment)
    reasons.push("Mission drift");
  if (a.injectionDetected || a.injectionScore >= JEV_THRESHOLDS.injection)
    reasons.push("Injection signal");
  return {
    block: reasons.length > 0,
    requireReview:
      reasons.length > 0 || a.requiresReview || a.risk !== "ROUTINE",
    minimumRisk: a.risk,
    reasons,
  };
}
