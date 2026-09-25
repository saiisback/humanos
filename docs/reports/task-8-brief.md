### Task 8: World ID for Agents sensitive approval

**Files:**

- Create: `packages/world/src/agents/request.ts`, `verify.ts`, `approval-binding.ts`
- Create: `apps/api/src/routes/world/agent-approval.ts`
- Test: `packages/world/test/agent-approval.test.ts`

**Interfaces:**

- Produces `requestFreshApproval(action)` and `verifyAndStoreApproval(result, expectedAction)`.

- [ ] Read event-environment docs and obtain required credentials before implementation.
- [ ] Define canonical approval binding: root ID, ENS agent, mission ID, action type, payload hash, nonce, and expiry.
- [ ] Write failing tests for valid, denied, cancelled, expired, replayed, wrong-agent, and wrong-payload outcomes.
- [ ] Implement secure backend validation and atomic single-use approval storage.
- [ ] Run tests and commit `feat: bind sensitive actions to fresh world approval`.
