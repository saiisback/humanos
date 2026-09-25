### Task 2: Deterministic state machine and policy engine

**Files:**

- Create: `packages/policy/src/state-machine.ts`, `risk.ts`, `capabilities.ts`, `decision.ts`, `errors.ts`
- Test: `packages/policy/test/state-machine.test.ts`, `risk.test.ts`, `capabilities.test.ts`, `decision.test.ts`

**Interfaces:**

- Consumes domain schemas from Task 1.
- Produces `transition(state, event)`, `classifyStatic(action)`, `effectiveCapabilities(input)`, and `authorize(input): PolicyDecision`.

- [ ] Write exhaustive failing transition-table tests, including every illegal transition.
- [ ] Implement explicit states from draft through completed, rejected, expired, revoked, and failed.
- [ ] Write failing tests for capability intersection across mission allowlist, human approval, ENS roles, lifecycle state, and expiry.
- [ ] Implement fail-closed capability and risk rules; static rules always override model recommendations.
- [ ] Add review-focus tests for payload substitution, expiry, revocation, unknown capability, and malformed assessment.
- [ ] Run `pnpm --filter @humanos/policy test` and commit `feat: add deterministic humanos policy engine`.
