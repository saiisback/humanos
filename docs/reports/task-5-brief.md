### Task 5: Jev decision adapter and calibration harness

**Files:**

- Create: `packages/models/src/jev/client.ts`, `questions.ts`, `policy-map.ts`
- Create: `packages/models/evals/humanos-actions.jsonl`, `scripts/calibrate-jev.ts`
- Test: `packages/models/test/jev.test.ts`, `jev-policy-map.test.ts`

**Interfaces:**

- Produces `evaluateAction(state): JevAssessment` with typed Choice/Noul/Score results.
- Produces deterministic `applyJevThresholds(assessment): AssessmentFlags`.

- [ ] Obtain official TypeSafe access and confirm endpoint/request/response shapes; never invent an SDK package.
- [ ] Write fixtures covering routine, consequential, sensitive, ambiguous, injection, mission drift, and disclosure cases.
- [ ] Write failing tests for malformed results, unknown versions, timeout, low confidence, and unavailable service.
- [ ] Implement the backend adapter, pin the tested Jev model, log state hash/question version/model version, and cache only identical normalized decisions.
- [ ] Calibrate thresholds from the fixture dataset; save measured results and chosen thresholds.
- [ ] Enforce that Jev can escalate or block but never add authority.
- [ ] Run model tests and commit `feat: add jev typed decision layer`.
