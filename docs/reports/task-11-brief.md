### Task 11: Atomic sensitive execution pipeline

**Files:**

- Create: `apps/api/src/services/execute-sensitive-action.ts`
- Test: `apps/api/test/execute-sensitive-action.test.ts`

**Interfaces:**

- Produces `executeSensitiveAction(actionId): ExecutionReceipt`.

- [ ] Write failing race tests for simultaneous execution, approval consumption, revocation during execution, stale ENS reads, and retry after upstream timeout.
- [ ] Implement lock, executed check, digest recomputation, approval validation, fresh ENS authorization, expiry check, atomic approval consumption, idempotent execution, receipt persistence, audit event, and allowed ENS record update in that order.
- [ ] Make ambiguous upstream timeouts reconcile by idempotency key before retrying.
- [ ] Run tests and commit `feat: execute sensitive actions atomically`.
