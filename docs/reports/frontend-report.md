# Task 12 — HumanOS judge console

Implemented React/Vite on port 5173 with same-origin `/api` proxy to port 3001, typed API contracts, server-cookie session recovery, World IDKit 4.2.3 `proofOfHuman({signal})` and no legacy proofs. Root and sensitive proof payloads go to backend verification before UI refresh. Optional EIP-1193 account connection grants no authorization.

Includes goal entry, capability review, ENS creation status, run/resume, separate Jev and deterministic policy panels, exact payload/hash/nonce review, consequential confirmation, fresh World approval, cancellation (including widget dismissal), execution receipts, reconciliation warning, expiry/rejection/revocation states, polling timeline and persisted mission URL recovery. Readiness is presented as configuration status, not proof of live operation.

## Validation

- `pnpm --filter @humanos/web build`: passed, including TypeScript.
- `pnpm exec eslint apps/web tests/e2e playwright.config.ts`: passed.
- `pnpm exec prettier --check apps/web tests/e2e playwright.config.ts`: passed.
- 16 desktop/mobile intercepted-HTTP journey tests passed. They test UI behavior only, not real World/ENS/Jev execution.
- Both desktop/mobile axe WCAG 2 A/AA and WCAG 2.1 AA tests passed after correcting footer contrast; responsive overflow assertions passed. Screenshots saved in ignored `test-results/mission-{desktop,mobile}.png`.
- Impeccable detector reported only two editorial font popularity warnings. Design guidance and tokens are documented in `apps/web/DESIGN.md`.

## Integration evidence boundary

`HUMANOS_LIVE_API=1 pnpm exec playwright test integration.spec.ts` exercises actual local backend readiness and onboarding without interception. Pending backend startup at initial handoff. All provider-dependent successful journey tests are explicitly labeled HTTP fixtures. Reload coverage checks UI recovery from server responses; it does not prove a Flue process restart. Live World proof, deployed ENS transaction and full mission execution need configured credentials/deployment and device participation.

IDKit 4.3.0 metadata existed but its tarball was unavailable (404); installed available 4.2.3, which exports the v4 Proof of Human preset. No backend secrets enter the browser. Wallet management/signing is intentionally outside the frozen API; optional account connection is browser-only visibility.
