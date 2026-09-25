# Bounded recovery and integration fixes

## Changes

- Downstream HTTP is still restricted to HTTPS or loopback by default. `createSideEffectClient` now accepts optional `allowHttpHost`, an exact hostname match, for a deliberately trusted private network. `DEMO_SERVICE_ALLOW_HTTP_HOST` supplies this configuration; Compose opts in only to `demo`, matching `http://demo:3003`. Redirects remain disabled and every request remains HMAC authenticated. This is a private Compose-network exception, not a general insecure-HTTP switch; use HTTPS outside that private network.
- Approval requests run under the action/mission lock. An expired challenge can be replaced while reusing the exact PENDING approval/binding and unchanged action nonce. Every old unconsumed request is atomically invalidated before the replacement is inserted. The stored session/root/action relationship must match, the session/action/mission must remain live, and mission state must remain RUNNING or AWAITING_APPROVAL. Active compatible requests are reused, including simultaneous refresh attempts. DENIED, CANCELLED, CONSUMED and VERIFIED approvals are never reset.
- Fresh approval and root authentication now use the same registered World action `humanos-root`, keeping nullifier scope comparable. The approval signal remains the full canonical approval-binding hash; each replacement request has a fresh signed RP nonce and new server request ID. Same-human nullifier equality is retained. An existing challenge with the previous dynamic action name is invalidated rather than reused. This uses documented action-scoping and signal binding; live World event qualification remains unverified.
- Mission authorization obtains the mission lock before validating the current proposed state, capability subset and expiry and before calling ENS registration. Concurrent requests for one mission cannot issue two registrations. The callback receives a frozen snapshot. Its adapter must still be deterministic/idempotent across a chain success followed by DB rollback.
- Revocation uses the resulting locked mission, rather than the pre-lock snapshot, when deciding which ENS identity to revoke. This closes the registration-in-flight case where the stale pre-lock mission still had a null agent name.

## Verification

Regression tests were written and observed failing for HTTP private-host opt-in, challenge refresh, session takeover rejection, duplicate ENS registration, registration/revocation ordering and fixed World action scope before their fixes.

- Tools tests: 8 passed.
- API tests: 23 passed (includes 10 approval refresh/registration tests, 10 executor tests, 3 auth tests).
- Tools/API typechecks: passed.
- Root `pnpm test`: contracts 26 and schemas 20 passed, then the concurrently created ENS package failed with `No test files found`. Root owner notified; no unrelated package edits.

API tests use a labeled World boundary fixture and real PostgreSQL. Old proof request reuse is rejected by consumed challenge state, the replacement verifies once, cancelled/other terminal statuses cannot refresh, other sessions cannot take over, concurrent refresh yields one active request, and legacy dynamic-scope requests are replaced. These tests do not claim credentialed World verification or on-chain deployment.
