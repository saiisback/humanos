### Task 3: Persistence, locking, idempotency, and audit

**Files:**

- Create: `packages/database/src/schema.ts`, `repositories/*.ts`, `transactions/execute-action.ts`
- Create: `packages/database/migrations/0001_initial.sql`
- Test: `packages/database/test/execution-transaction.test.ts`

**Interfaces:**

- Produces repositories for roots, missions, agent identities, actions, approvals, receipts, nullifiers, and audit events.
- Produces `withLockedAction(actionId, callback)` and unique idempotency constraints.

- [ ] Write failing tests for duplicate nullifiers, duplicate action execution, consumed approval reuse, and concurrent execution attempts.
- [ ] Implement Postgres schema and transactional repositories.
- [ ] Ensure audit events record actor, previous state, next state, policy version, model versions, and redacted payload metadata.
- [ ] Run database tests against an ephemeral Postgres instance.
- [ ] Commit `feat: add durable mission persistence and idempotency`.
