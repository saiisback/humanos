/** Run with pnpm exec tsx scripts/calibrate-jev.ts [--live]. No credentials => synthetic only. */
import { readFile } from "node:fs/promises";
import {
  hashCanonical,
  type JevAssessment,
} from "../packages/schemas/src/index.js";
import {
  createJevClient,
  applyJevThresholds,
  JEV_MODEL,
  QUESTION_VERSION,
  JEV_THRESHOLDS,
} from "../packages/models/src/index.js";
const live = process.argv.includes("--live");
if (live && !process.env.TYPESAFE_API_KEY)
  throw new Error("Live calibration requires TYPESAFE_API_KEY");
const fixtures = (
  await readFile(
    new URL("../packages/models/evals/humanos-actions.jsonl", import.meta.url),
    "utf8",
  )
)
  .trim()
  .split("\n")
  .map((line) => JSON.parse(line));
const client = live
  ? createJevClient({ apiKey: process.env.TYPESAFE_API_KEY! })
  : null;
const results = [];
for (const fixture of fixtures) {
  const s = fixture.synthetic;
  const assessment: JevAssessment = client
    ? await client.evaluateAction(fixture.state)
    : {
        stateHash: hashCanonical(fixture.state),
        modelVersion: JEV_MODEL,
        questionVersion: QUESTION_VERSION,
        evaluatedAt: new Date().toISOString(),
        risk: s.risk,
        missionAligned: s.alignment >= JEV_THRESHOLDS.alignment,
        injectionDetected: s.injection >= JEV_THRESHOLDS.injection,
        requiresReview: s.review,
        confidence: s.confidence,
        missionAlignmentScore: s.alignment,
        injectionScore: s.injection,
        reason: "SYNTHETIC fixture, not a provider prediction",
      };
  const flags = applyJevThresholds(assessment);
  results.push({
    id: fixture.id,
    pass:
      flags.block === fixture.expected.block &&
      flags.requireReview === fixture.expected.requireReview,
    expected: fixture.expected,
    actual: flags,
  });
}
console.log(
  JSON.stringify(
    {
      mode: live
        ? "live-provider-evaluation"
        : "synthetic-threshold-regression",
      liveProviderEvaluation: live,
      liveCalibrationComplete: false,
      model: JEV_MODEL,
      questionVersion: QUESTION_VERSION,
      thresholds: JEV_THRESHOLDS,
      passed: results.filter((r) => r.pass).length,
      total: results.length,
      warning:
        "Thresholds are provisional; synthetic outcomes do not measure Jev accuracy. This small dataset is not sufficient for production calibration.",
      results,
    },
    null,
    2,
  ),
);
if (results.some((r) => !r.pass)) process.exitCode = 1;
