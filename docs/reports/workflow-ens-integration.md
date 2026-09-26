# Workflow ENSv2 integration

## Implementation and trust boundary

Workflows have their own persisted agent bindings, separate from legacy missions. A binding pins the owner account, verified human root, exact workflow version and graph hash, canonical capabilities, expiry and generation. Derived signing keys remain in the backend operator's custody. They are never returned to the browser.

The owner opens **Identity & permissions** inside the workflow, selects **Enable ENS agent**, and reviews the Sepolia scope and expiry. Registration consent grants only that scope; it does not send an email, book a room, start a run or approve a future external payload. The existing exact final-action confirmation remains in force.

The agent writer reuses the existing signed-transaction journal and signer. Registration can remain pending while its transactions await finality. A retry retains its identity and generation. Registration/revocation transaction references are recorded when returned by confirmed writes; a reconciled preexisting chain state may have no transaction reference. The interface must not fabricate a hash for that case.

Content generation requires `drafts.write`; research requires `web.search`. Connector effects use server-owned operation definitions. Agent resolver permissions remain limited to status and receipt records. This integration does not grant registry administration or wallet spending.

An ENS-enabled run must not downgrade to account-only execution. Existing never-bound workflows remain labeled account-only until the owner explicitly upgrades them. Expired or revoked generations cannot be renewed implicitly; replacement requires a new review. Historical runs and schedules retain their generation pins.

## Verification record

Final whole-workspace gate: `pnpm -r --workspace-concurrency=1 --if-present test` exited 0 with **841 TypeScript tests and 26 Foundry tests passed**. No tests were skipped in this final gate. Typecheck and build also exited 0. Browser fixtures passed separately as documented below.

- Schema/database baseline: 33 tests each, passed before implementation.
- Binding schemas: 40 tests passed after implementation.
- Database store: 43 tests passed, including concurrent reservation, immutable run/schedule pins, staged evidence, expiry guard, local revocation and upgrading an already-created outbox table.
- ENS package: 59 tests passed, including a new local Anvil workflow registration/finality/controller/receipt-hash/revocation journey against real deployed local contracts. These are **local chain** results, not Sepolia transactions.
- Management service: 10 tests passed with real isolated PostgreSQL schemas and controlled ENS transports, including cancellation of a failed pre-registration intent.
- Runtime/receipt checks: 40 tests passed after independent review fixes, covering immutable pins, live denials, schedules, publication retries and batch progress.
- Combined local-chain journey passed: actual registration → PostgreSQL binding → real workflow runner → actual receipt publication → onchain revocation → denied next run. Research output is a counting fixture; no live search, email or booking is claimed.
- Web unit suite: 71 tests passed, including receipt-evidence display.
- Browser fixtures: 24 auth/identity/accessibility/responsive tests passed on desktop/mobile, followed by 2 focused workflow-agent tests with receipt evidence. Checks cover workflow-preserving navigation, exact registration request, revocation, disabled execution after revocation and horizontal overflow. Browser chain responses are explicitly intercepted fixtures, not live-chain proof.
- `pnpm build` passed. Existing web bundle-size and Flue module-directive advisories remain.
- `pnpm typecheck` passed across the workspace.
- API suite: 306 tests passed with bounded integration-test concurrency; two earlier 5-second timeouts under unrestricted parallelism are not counted as passes. The API configuration now limits workers to two without weakening assertions or increasing the default timeout.
- `git diff --check` passed.

One earlier whole-workspace attempt was stopped when a parallel local Foundry deployment stalled. The ENS tests passed 59/59 when run serially; package test configuration now serializes the files that share Foundry deployment artifacts. A recovery-identity TypeScript mismatch found by the build was corrected before the successful build. Neither unsuccessful attempt is counted as passing evidence.

Local app readiness at handoff: Vite on port 5173 answered HTTP 200; the API on port 3001 was not running. Starting the API runs idempotent database migrations and starts persisted workflow/recovery workers, so this verification batch did not restart credentialed live workers or consume saved external-action approvals. Restart the normal development stack when ready to resume those workers, then explicitly enable a workflow agent in the panel.

An independent review identified three issues, now fixed and accepted on re-review: receipt batch starvation, onchain revocation not pausing schedules, and cancellation before registration evidence existed. Cancellation reconciles only the original journaled intent before revoking, remaining locally denied throughout. Schedule RPC failures pause rather than pretending the agent was revoked.

Activation remains an explicit owner opt-in, reachable directly beside workflow review. Unbound workflows are labeled account-only. An existing binding permanently prevents silent account-only fallback. Registration and run initiation remain distinct from exact final external-action approval.

The interface extends the existing warm-ivory design; desktop/mobile screenshots were visually reviewed and the design detector returned no findings. No live Sepolia registration, live email delivery or hotel/restaurant booking is claimed by this report.

## Live Sepolia checklist

1. Confirm the authenticated JAW account owns the verified root binding.
2. Review the exact workflow version, scope, effective expiry, Sepolia operator and gas implications.
3. Obtain explicit registration consent in the application before submitting transactions.
4. Record actual transaction hashes and wait for the finalized/latest authorization checks to agree.
5. Run a read-only workflow and inspect its persisted outputs and receipts.
6. Explicitly revoke and verify that further execution is denied.

The ENSv2 beta API is evolving. This implementation uses the repository's pinned contracts and adapter. Current official references: [Permissioned Resolver](https://docs.ens.domains/ensv2/permissioned-resolver/) and [Enhanced Access Control](https://docs.ens.domains/ensv2/enhanced-access-control/).
