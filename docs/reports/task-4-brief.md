### Task 4: DeepSeek V4.1 Flash adapter

**Files:**

- Create: `packages/models/src/deepseek/client.ts`, `provider.ts`, `schemas.ts`
- Test: `packages/models/test/deepseek.test.ts`

**Interfaces:**

- Produces `proposeMission(input): MissionProposal` and `proposeNextAction(input): ActionProposalDraft`.
- Uses official DeepSeek OpenAI-compatible API with model `deepseek-flash`.

- [ ] Confirm current official API format and Flue/Pi provider identifier before coding.
- [ ] Write failing contract tests for structured output, timeout, malformed output, and provider failure.
- [ ] Implement one provider adapter with backend-only key, strict schemas, timeouts, retry limits, and model-version logging.
- [ ] Ensure proposals cannot contain capabilities outside the closed schema.
- [ ] Run tests and commit `feat: integrate deepseek flash proposal model`.
