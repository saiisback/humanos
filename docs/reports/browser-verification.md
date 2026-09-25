# Final browser verification — 24 September 2026 JST

## Complete final run: 40 tests

**40/40 passed in 1.4 minutes**, with no failures or skips, after rebuilding the web app at application HEAD `85fe85f`. Playwright 1.63.0 recorded all desktop/mobile cases with one worker. This final broad run includes the verified-approval cancellation regression: 18 actual API/PostgreSQL journey checks, 2 live unmodified API onboarding checks, and 20 intercepted-HTTP UI/accessibility checks. The provider-fixture and live-device boundaries below still apply.

Exact executed command:

```sh
pnpm --filter @humanos/web build && HUMANOS_LIVE_API=1 HUMANOS_RECORD=1 HUMANOS_RECORD_DIR=/Users/saikarthik/.codex/artifacts/humanos-browser-verification-20260924-complete pnpm exec playwright test
```

The build and TypeScript check passed. The complete artifact directory contains 42 nonempty WebM files (40 tests plus 2 accessibility helper pages), totaling 6,693,032 bytes. Four desktop/mobile mission/onboarding screenshots are preserved in its `screenshots/` subdirectory. Earlier 38-case and 2-case follow-up recordings remain intact in their original directories.

- [Final desktop application/calendar success](/Users/saikarthik/.codex/artifacts/humanos-browser-verification-20260924-complete/backend-REAL-API-PostgreSQ-e2dc0-calendar-receipt-and-replay-desktop/video.webm)
- [Final mobile application/calendar success](/Users/saikarthik/.codex/artifacts/humanos-browser-verification-20260924-complete/backend-REAL-API-PostgreSQ-e2dc0-calendar-receipt-and-replay-mobile/video.webm)
- [Final desktop verified-action cancellation](/Users/saikarthik/.codex/artifacts/humanos-browser-verification-20260924-complete/backend-REAL-API-PostgreSQ-71ac7-oval-rejects-without-effect-desktop/video.webm)
- [Final mobile verified-action cancellation](/Users/saikarthik/.codex/artifacts/humanos-browser-verification-20260924-complete/backend-REAL-API-PostgreSQ-71ac7-oval-rejects-without-effect-mobile/video.webm)

## Reproduction

Start the real API at `127.0.0.1:3001`, web at `127.0.0.1:5173`, and dedicated PostgreSQL at `127.0.0.1:55432`. Build `@humanos/web` first: the backend-connected harness serves that build.

```sh
pnpm --filter @humanos/web build
HUMANOS_LIVE_API=1 HUMANOS_RECORD=1 HUMANOS_RECORD_DIR=/Users/saikarthik/.codex/artifacts/humanos-browser-verification-20260924-complete pnpm exec playwright test
```

Video recording is opt-in with `HUMANOS_RECORD=1`; recording mode uses one worker, a 120-second per-test timeout and a 20-second assertion timeout to accommodate video encoding on the shared host. `HUMANOS_RECORD_DIR` selects a persistent local artifact directory outside the repository. Ordinary runs do not record video and do not delete that external directory. The recordings are not committed.

## Integration boundary

- `backend.spec.ts`: actual HTTP routing from the built React UI through `createApi`, PostgreSQL transactions, deterministic policy and the executor. Each worker creates and deletes a separate generated database schema. Root/session initialization is a database fixture. World verification transport, ENS, DeepSeek/Jev, Flue dispatch and external side effects are explicit test fixtures. Fresh-proof payloads are delivered through the real verification endpoint with Playwright APIRequestContext; the device/World ID ceremony is not live.
- `integration.spec.ts`: unmodified running API on port 3001 and web on port 5173, with no interception. Confirms unauthenticated onboarding and honest readiness with missing credentials.
- Remaining journey/accessibility files: explicitly intercepted HTTP API fixtures, testing UI behavior and WCAG checks only.

These recordings demonstrate local product behavior. They do not establish sponsor qualification, deployed ENS finality, live model calls, a real World proof, or a Flue process restart.

## Journey coverage

Mission goal creation, capability approval and ENS identity display; application approval and execution; consequential calendar confirmation; two receipts and idempotent replay; cancellation, revoked approval and expired approval blocking effects; session/action recovery after browser reload; uncertain receipts reconciled without resubmission, including after revocation; expired pending challenges refreshed through the verification retry; pending ENS receipt publication retried until backend-confirmed; unavailable World integration; network-error recovery; desktop/mobile accessibility and responsive overflow checks.

## Initial recording attempt

The initial four-worker run was stopped after observing 30-second test timeouts under host contention and `ECONNREFUSED 127.0.0.1:3001` from the live API check. It was not a passing run. Videos, error context and traces remain in `/Users/saikarthik/.codex/artifacts/humanos-browser-verification-20260924/`. The final run uses the separate `-final` artifact directory and recording-only resource/time limits described above.

## Earlier full result: 38 tests

**38 passed in 1.3 minutes**, with one recording worker using Playwright 1.63.0. No failures or skips in the final run. This comprises 16 real-API/PostgreSQL journey checks, 2 live unmodified API onboarding checks, and 20 intercepted-HTTP UI/accessibility checks, evenly split across desktop and mobile projects. The run began at repository HEAD `1ae0f75`; this report/config commit follows the test run.

Final live readiness: protected submission configured; World ID, DeepSeek/Jev, ENSv2 and Flue unavailable. `/api/health` returned `{"status":"ok"}`. The prior port refusal was resolved by the lead restarting the API without watch-mode restarts.

There are **40 nonempty WebM files** (38 test recordings plus helper-page videos created during accessibility analysis), totaling 5,968,316 bytes. Representative desktop and mobile success videos were checked with `ffprobe`: 4.96 and 2.12 seconds respectively. These are real-time automated test captures, not narrated or paced demonstration videos.

## Representative recordings

All links point to preserved local files outside git:

- [Desktop application, calendar, receipts and replay](/Users/saikarthik/.codex/artifacts/humanos-browser-verification-20260924-final/backend-REAL-API-PostgreSQ-e2dc0-calendar-receipt-and-replay-desktop/video.webm)
- [Mobile application, calendar, receipts and replay](/Users/saikarthik/.codex/artifacts/humanos-browser-verification-20260924-final/backend-REAL-API-PostgreSQ-e2dc0-calendar-receipt-and-replay-mobile/video.webm)
- [Desktop reconciliation after revocation](/Users/saikarthik/.codex/artifacts/humanos-browser-verification-20260924-final/backend-REAL-API-PostgreSQ-0a6d6-cation-without-resubmission-desktop/video.webm)
- [Mobile reconciliation after revocation](/Users/saikarthik/.codex/artifacts/humanos-browser-verification-20260924-final/backend-REAL-API-PostgreSQ-0a6d6-cation-without-resubmission-mobile/video.webm)
- [Desktop live API onboarding](/Users/saikarthik/.codex/artifacts/humanos-browser-verification-20260924-final/integration-LIVE-LOCAL-API-20d72--unauthenticated-onboarding-desktop/video.webm)
- [Mobile live API onboarding](/Users/saikarthik/.codex/artifacts/humanos-browser-verification-20260924-final/integration-LIVE-LOCAL-API-20d72--unauthenticated-onboarding-mobile/video.webm)

Desktop/mobile mission and live onboarding screenshots are copied into `/Users/saikarthik/.codex/artifacts/humanos-browser-verification-20260924-final/screenshots/`. Individual test directories contain the remaining videos. The first attempt's failure traces remain in its separate directory; do not confuse those with the passing final recording run.

Configuration ESLint and Prettier checks passed. No product code, dependencies or binary artifacts were changed in this recording task.

## Follow-up: cancelling a verified action

The recorded targeted regression passed **2/2** on desktop/mobile after the API cancellation fix. It verifies a proof through the actual harness API, observes VERIFIED, clicks Cancel action, observes REJECTED and CANCELLED, then verifies that another execution request is denied and the effect transport was never called. The same provider-fixture boundary applies.

```sh
HUMANOS_RECORD=1 HUMANOS_RECORD_DIR=/Users/saikarthik/.codex/artifacts/humanos-browser-verified-cancel-20260924 pnpm exec playwright test backend.spec.ts -g 'cancellation after verified approval'
```

At this follow-up stage the suite contained 40 cases, while the prior full recording was 38/38. This targeted follow-up ran only the two new cases. The complete 40-case run documented at the top was performed afterward.

- [Mobile verified-action cancellation](/Users/saikarthik/.codex/artifacts/humanos-browser-verified-cancel-20260924/backend-REAL-API-PostgreSQ-71ac7-oval-rejects-without-effect-mobile/video.webm)
- [Desktop verified-action cancellation](/Users/saikarthik/.codex/artifacts/humanos-browser-verified-cancel-20260924/backend-REAL-API-PostgreSQ-71ac7-oval-rejects-without-effect-desktop/video.webm)
