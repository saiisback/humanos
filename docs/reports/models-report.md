# Tasks 4 and 5: model adapters

Implemented backend-only `@humanos/models` with DeepSeek Flash proposals and TypeSafe Jev typed evaluation. The adapters return proposals/assessment flags only; they cannot grant capabilities or execute. Deterministic policy must still intersect mission/ENS capabilities, apply action-type floors, validate payloads, require approvals, verify assessment state/version/freshness, and enforce replay protection.

## Public API

- `createDeepSeekClient(config).proposeMission(input: unknown): Promise<MissionProposal>`
- `createDeepSeekClient(config).proposeNextAction(input: unknown): Promise<ActionProposalDraft>`
- `createJevClient(config).evaluateAction(state: unknown): Promise<JevAssessment>`
- `applyJevThresholds(input: unknown): AssessmentFlags`
- `ModelConfig`: required backend `apiKey`, optional `fetch`, `timeoutMs` (1–60000, default 15000), `retries` (0–2, default 1), redacted `log` callback.
- `ModelUnavailableError`, `DEEPSEEK_MODEL`, `DEEPSEEK_PROVIDER`, `DEEPSEEK_ENDPOINT`, `DEEPSEEK_PI_API`, `JEV_MODEL`, `QUESTION_VERSION`, `JEV_QUESTION_VERSION` (alias), `JEV_THRESHOLDS`.

Inputs accept canonical JSON; invalid non-JSON values and inputs over 100000 characters are rejected. Jev hashes exactly the state passed by callers. Runtime should pass `{mission,action}` consistently; the adapter adds no volatile fields to this state. Cache keys additionally commit to model, question version, and full question contents. Cache is process-local, 256 entries maximum, 30-second TTL, and returns independent copies. It is not a durable authorization cache.

## Verified sources

- https://api-docs.deepseek.com/news/news260910/ confirms `deepseek-flash`.
- https://api-docs.deepseek.com/guides/json_mode confirms OpenAI-compatible chat completions, JSON object response format, and official base URL.
- https://docs.typesafe.ai/api.md confirms POST `https://api.typesafe.ai/v1/systemone`, keyed questions/answers, Choice distribution/confidence, Noul probability, Score weighted levels/confidence, and bearer authentication.
- https://docs.typesafe.ai/models.md confirms pinned `jev-1.13.0`.
- Official Flue source `/tmp/humanos-flue-source/packages/runtime/src/runtime/providers.ts` confirms Pi provider identifier `deepseek`. Adapter uses direct HTTP; integration into the Flue step lifecycle belongs to runtime.

Official TypeSafe Markdown was retrieved with curl because the web tool could not fetch those pages. No unofficial Jev documentation or invented SDK is used.

## Validation and fail-closed behavior

Strict shared output schemas reject unknown capabilities/fields and action-type/capability mismatch. Provider response model is checked exactly; DeepSeek truncation or malformed JSON is rejected. Jev requires all keyed answers, expected primitive types, all confidence values on Choice/Score, expected legend, valid probability distributions, highest-probability chosen risk, and consistent Score weighted value. Missing configuration, timeout, non-success response and malformed output return redacted errors. Only backend construction is allowed in browser environments. Requests prohibit redirects and use bounded retries/backoff and explicit timeout racing, including transports that ignore abort.

Jev thresholds are conservative and provisional: minimum confidence 0.8, minimum alignment 0.8, injection block at 0.2, review at 0.2. Unknown versions, malformed assessments, low confidence, mission drift and injection block. Risk is a minimum floor only; flags contain no authority or effective capability list. Untrusted documents stay in user/state data; fixed instructions explicitly deny their authority. These are mitigation and deterministic validation, not proof that models resist every prompt injection.

## Tests and measurements

- Test-first initial model suite failed because implementation did not exist. The added authentication retry regression then failed with three calls rather than one before its fix.
- `pnpm --filter @humanos/models test`: **20 passed**.
- `pnpm --filter @humanos/models typecheck`: **passed**.
- `pnpm exec tsx scripts/calibrate-jev.ts`: **9/9 synthetic threshold regressions passed**, saved in `packages/models/evals/synthetic-results.json`.
- Root `pnpm test`: failed while other agents were working, at `packages/database/test/execution-transaction.test.ts`, `Database.migrate` throwing `not implemented`; five database cases skipped by failed setup. Schemas 20, World 9, policy 159 and models 20 passed in that run. Root owner must rerun after integration.

Fixtures cover routine, consequential, sensitive, ambiguous, injection, mission drift, disclosure, confidence and injection boundaries. Synthetic scores are handwritten test data, not actual Jev results, and do not calibrate model accuracy. `--live` requires `TYPESAFE_API_KEY` and evaluates the same fixture states against the live endpoint; this small corpus remains insufficient for production calibration.

## Unresolved/live prerequisites

No credentials were available; no paid/live provider calls were made, and TypeSafe account access was not obtained. Real response compatibility, DeepSeek alias stability and empirical threshold calibration must be verified with authorized credentials. A representative independently labeled holdout set and live measurement are required before treating these thresholds as production-calibrated. Never replace unavailable models with synthetic successful responses. Payload-level semantics and external action safety remain the deterministic runtime/tool layer's responsibility.
