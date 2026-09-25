### Task 12: Product UI and judge journeys

**Files:**

- Create: `apps/web/app/**`, `apps/web/components/**`, `apps/web/lib/api.ts`
- Test: `tests/e2e/success.spec.ts`, `denied.spec.ts`, `revoked.spec.ts`, `recovery.spec.ts`

**Interfaces:**

- Consumes typed API/Flue clients and exposes onboarding, mission, timeline, approval, ENS, receipt, expiry, and revoke flows.

- [ ] Build the responsive onboarding and wallet/World verification flow.
- [ ] Build goal entry, mission/capability review, ENS creation, and live agent timeline.
- [ ] Display Jev assessment separately from the deterministic HumanOS policy decision.
- [ ] Build sensitive approval, cancellation, expiry, rejection, receipt, and revocation states.
- [ ] Write Playwright tests for successful, cancelled, revoked, expired, and restart/resume journeys.
- [ ] Run accessibility checks and e2e tests; commit `feat: ship humanos judge experience`.
