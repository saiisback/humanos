### Task 10: Policy-gated tools and protected demo service

**Files:**

- Create: `packages/tools/src/gateway.ts`, `documents.ts`, `application.ts`, `calendar.ts`
- Create: `apps/demo-service/src/app.ts`, `store.ts`
- Test: `packages/tools/test/gateway.test.ts`, `apps/demo-service/test/submission.test.ts`

**Interfaces:**

- Produces idempotent tools for approved document reads, draft persistence, application submission, and calendar creation.

- [ ] Write failing tests proving every tool reauthorizes independently and model-provided parameters cannot bypass constraints.
- [ ] Implement the tool gateway and prompt-injection-safe document treatment.
- [ ] Implement a persistent protected submission endpoint that validates HumanOS authorization and idempotency.
- [ ] Implement a development calendar integration with explicit consequential-action confirmation.
- [ ] Run tests and commit `feat: add policy gated humanos tools`.
