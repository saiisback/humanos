import * as v from "valibot";
import {
  canonicalize,
  hashCanonical,
  JevAssessmentSchema,
  RiskLevelSchema,
  type JevAssessment,
} from "@humanos/schemas";
import {
  requestJson,
  validateConfig,
  ModelUnavailableError,
  type ModelConfig,
} from "../transport.js";
import { QUESTIONS, JEV_MODEL, QUESTION_VERSION } from "./questions.js";
import { JEV_THRESHOLDS } from "./policy-map.js";
import { OPENCODE_BASE_URL, OPENCODE_JEV_MODEL } from "../opencode.js";
const probability = v.pipe(
  v.number(),
  v.finite(),
  v.minValue(0),
  v.maxValue(1),
);
const noul = v.strictObject({ type: v.literal("noul"), noul: probability });
const choice = v.strictObject({
  type: v.literal("choice"),
  choice: RiskLevelSchema,
  probabilities: v.strictObject({
    ROUTINE: probability,
    CONSEQUENTIAL: probability,
    SENSITIVE: probability,
  }),
  confidence: probability,
});
const score = v.strictObject({
  type: v.literal("score"),
  score: probability,
  legend: v.strictObject({
    "0": v.literal("Not aligned"),
    "1": v.literal("Fully aligned"),
  }),
  probabilities: v.strictObject({ "0": probability, "1": probability }),
  confidence: probability,
});
const wire = (opencode: boolean) =>
  v.object({
    model: opencode
      ? v.picklist([JEV_MODEL, OPENCODE_JEV_MODEL])
      : v.literal(JEV_MODEL),
    answers: v.strictObject({
      risk: choice,
      alignment: score,
      injection: noul,
      review: noul,
    }),
    usage: v.object({
      input_tokens: v.pipe(v.number(), v.integer(), v.minValue(0)),
      output_tokens: v.pipe(v.number(), v.integer(), v.minValue(0)),
    }),
  });
export function createJevClient(config: ModelConfig) {
  validateConfig(config);
  const opencode = config.provider === "opencode";
  const requestModel = opencode ? OPENCODE_JEV_MODEL : JEV_MODEL;
  const cache = new Map<
    string,
    { assessment: JevAssessment; expires: number }
  >();
  return {
    async evaluateAction(state: unknown): Promise<JevAssessment> {
      const normalized = canonicalize(state);
      if (normalized.length > 100000) throw new ModelUnavailableError();
      const snapshot = JSON.parse(normalized) as unknown;
      const stateHash = hashCanonical(snapshot);
      const cacheKey = hashCanonical({
        state: snapshot,
        model: JEV_MODEL,
        questionVersion: QUESTION_VERSION,
        questions: QUESTIONS,
      });
      const cached = cache.get(cacheKey);
      if (cached && cached.expires > Date.now())
        return structuredClone(cached.assessment);
      const raw = await requestJson(
        config,
        opencode
          ? `${OPENCODE_BASE_URL}/systemone`
          : "https://api.typesafe.ai/v1/systemone",
        { state: snapshot, model: requestModel, questions: QUESTIONS },
      );
      try {
        const { answers: a, model } = v.parse(wire(opencode), raw);
        for (const distribution of [
          a.risk.probabilities,
          a.alignment.probabilities,
        ])
          if (
            Math.abs(
              Object.values(distribution).reduce((sum, p) => sum + p, 0) - 1,
            ) > 1e-5
          )
            throw new Error();
        if (
          a.risk.probabilities[a.risk.choice] <
            Math.max(...Object.values(a.risk.probabilities)) ||
          Math.abs(a.alignment.score - a.alignment.probabilities["1"]) > 1e-5
        )
          throw new Error();
        const assessment = v.parse(JevAssessmentSchema, {
          stateHash,
          questionVersion: QUESTION_VERSION,
          // Normalize the allowlisted gateway route label for existing policy bindings.
          modelVersion: JEV_MODEL,
          evaluatedAt: new Date().toISOString(),
          risk: a.risk.choice,
          missionAligned: a.alignment.score >= JEV_THRESHOLDS.alignment,
          injectionDetected: a.injection.noul >= JEV_THRESHOLDS.injection,
          requiresReview: a.review.noul >= JEV_THRESHOLDS.review,
          confidence: Math.min(a.risk.confidence, a.alignment.confidence),
          missionAlignmentScore: a.alignment.score,
          injectionScore: a.injection.noul,
          reason:
            "Typed evaluation; deterministic policy remains authoritative.",
        });
        config.log?.({
          provider: opencode ? "opencode" : "typesafe",
          stateHash,
          questionVersion: QUESTION_VERSION,
          modelVersion: model,
          cacheKey,
        });
        if (cache.size >= 256) cache.delete(cache.keys().next().value!);
        cache.set(cacheKey, {
          assessment: structuredClone(assessment),
          expires: Date.now() + 30000,
        });
        return assessment;
      } catch {
        throw new ModelUnavailableError();
      }
    },
  };
}
