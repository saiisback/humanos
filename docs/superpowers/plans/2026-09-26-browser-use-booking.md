# Local Browser Use Booking Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a locally controlled Browser Use executor that prepares a restaurant reservation and submits only the exact user-confirmed booking, with durable receipts and safe recovery.

**Architecture:** The existing TypeScript workflow runner owns authorization, state, approval and dispatch. A scoped Python worker supplies Browser Use observations and deterministic interactions; Jev selects bounded actions and DeepSeek remains content-only. Unknown site effects stop for handoff instead of falling through to an unrestricted agent.

**Tech Stack:** Existing TypeScript, Valibot, PostgreSQL, Vitest, React; Python 3.12, Browser Use local BrowserSession/Actor, pytest and uv lockfile. Pin the Browser Use release only after the compatibility gate below.

**Spec:** `docs/superpowers/specs/2026-09-26-browser-use-booking-design.md`

## Global Constraints

- “Jev chooses among structured, bounded actions; DeepSeek generates content only.”
- “Do not silently introduce another paid model or give DeepSeek general browser-execution authority.”
- “The worker operates a dedicated HumanOS browser profile, visible for login and handoff.”
- “Do not automatically import the user's everyday browser profile or cookies.”
- “An uncertain response becomes reconciliation-required, never an automatic retry.”
- “Never silently fall back to account authority when an ENS binding fails.”
- “No restaurant has been selected and no reservation details have been supplied yet.”
- Preserve unrelated dirty files, including JAW login edits. Commit only task-owned changes; never rewrite commit dates.
- Do not resend the already-delivered test email. Site policy and real reservation details are dependencies of live booking acceptance, not invented test fixtures.

## Review Focus

1. Cross-account requests or a stale observation must never act in another browser session (tasks 1–2).
2. Enter, navigation, form filling and background requests can write data; all must encounter the same effect boundary as a submit click (task 2).
3. Availability, price, hidden form state and terms can change after approval; require a new review rather than reuse approval (tasks 2–3).
4. A worker crash immediately after submission must not cause duplicate reservations (task 3).
5. Login/CAPTCHA, missing details and unsupported sites need clear handoff, not endless model retries or fabricated completion (tasks 4–5).

## Execution and file ownership

Respect the user's earlier Claude Code implementation / Codex coordination-and-review preference if that runtime is available. Read any existing handoff before using it; do not claim Claude executed work unless it actually did. No concurrent edits to runner, schemas or runtime wiring. Execution order is 1 → 2 → 3 → 4 → 5; task 6 requires a selected live site.

New worker modules own browser processes only. New API modules own the subprocess bridge and action policy only. Existing workflow/confirmation/store modules retain durable orchestration; avoid a second scheduler or approval system.

### Task 1: Versioned worker protocol and real Browser Use compatibility

**Files:**
- Create: `packages/schemas/src/browser-worker.ts`, export from `packages/schemas/src/index.ts`
- Create: `apps/browser-worker/pyproject.toml`, `apps/browser-worker/uv.lock`
- Create: `apps/browser-worker/humanos_browser/protocol.py`, `worker.py`
- Create: `apps/api/src/workflows/browser-use-client.ts`
- Test: `packages/schemas/test/browser-worker.test.ts`, `apps/api/test/browser-use-client.test.ts`, `apps/browser-worker/tests/test_protocol.py`, `test_browser_smoke.py`

**Interfaces:**
- Envelope: `{ protocolVersion: 1, accountId, runId, sessionId, actionId, observationRevision, command, payload }`.
- Commands: `start | observe | act | prepare | submit | inspect_receipt | close`.
- `BrowserUseClient.request(command: BrowserWorkerCommand, signal: AbortSignal): Promise<BrowserWorkerResult>`; `close(): Promise<void>`.
- Results: `ready | observed | acted | prepared | submitted | handoff | unavailable | failed`; typed payload by command, never free-form executable instructions.
- `start` returns runtime/version compatibility and session ID. `observe` returns a revision, approved origin, sanitized page facts and bounded candidate IDs.

- [ ] Write failing protocol tests: reject unknown commands/keys, >256 KiB messages, mismatched account/run/session, repeated action ID, stale revision and any arbitrary script field. Round-trip valid envelopes between Python and TypeScript.
- [ ] Run `pnpm --filter @humanos/schemas test test/browser-worker.test.ts` and `uv run --project apps/browser-worker pytest apps/browser-worker/tests/test_protocol.py`; record missing-feature failures before implementation.
- [ ] Verify official Browser Use release APIs. Pin a release with BrowserSession/Actor support and produce its lockfile. If absent, stop and revise the approved adapter design—do not enable Agent as a fallback.
- [ ] Implement newline-framed JSON on child-process pipes, bounded output, startup timeout 30 seconds, action timeout 30 seconds, abort/cleanup, and redacted errors. No network listener for worker control.
- [ ] Add a real local-browser smoke test using a controlled page, proving start/observe/close through Browser Use rather than a replacement driver. It performs no live account operations.
- [ ] Run the three focused suites plus the smoke test; commit task-owned files as `feat: add scoped Browser Use worker protocol`.

### Task 2: Shared action guard and safe browser sessions

**Files:**
- Create: `apps/browser-worker/humanos_browser/session.py`, `policy.py`, `actions.py`
- Create: `apps/browser-worker/tests/test_policy.py`, `test_sessions.py`, `test_actions.py`
- Create: `apps/api/src/workflows/browser-use-policy.ts`, `apps/api/test/browser-use-policy.test.ts`

**Interfaces:**
- `ActionCandidate = { id, kind: 'navigate' | 'extract' | 'fill' | 'select' | 'submit', observationRevision, targetId, policyId }`.
- `SitePolicy` defines approved origins/resources, preparation requests, typed fields, a final request contract, material fields and receipt extraction. Policies are server-authored, never supplied by a page or model.
- `guardAction(scope, observation, candidate, permit): AllowedAction | Handoff`; `permit` is absent during preparation.
- `SubmissionPermit = { runId, sessionId, actionId, observationRevision, payloadHash, expiresAt }`, accepted only over the runner-owned pipe and single-use.

- [ ] Write failing tests for profile lock/isolation, unsafe redirects/private networks, script/file URLs, unlisted origins, page-injected instructions, stale targets and sensitive-data redaction.
- [ ] Write hostile-page browser tests that attempt writes through Enter, navigation, change events, fetch, forms and popups. Assert the fixture server receives zero unapproved writes, not merely that the agent reports a block.
- [ ] Run `uv run --project apps/browser-worker pytest apps/browser-worker/tests/test_policy.py apps/browser-worker/tests/test_sessions.py apps/browser-worker/tests/test_actions.py` and record red results.
- [ ] Implement dedicated per-account profiles with one-run locks, no exported cookies or credentials, bounded observation extraction, and one guard for every interaction/network path. Disable downloads, uploads and unknown tools. Unknown effects produce handoff.
- [ ] Permit only the exact reviewed submission request once; deny mismatched fields/destination/material state and background writes. The guard must not rely on the model deciding whether an action is safe.
- [ ] Run focused Python/API policy tests and real hostile-page checks; commit as `feat: enforce Browser Use session and effect boundaries`.

### Task 3: Durable preparation, final approval and receipt reconciliation

**Files:**
- Create: `apps/api/src/workflows/browser-use-step.ts`, `apps/api/test/browser-use-step.test.ts`
- Modify: `apps/api/src/workflows/runtime.ts`, `confirmations.ts`, `browser-step.ts` only where their existing interfaces require integration
- Modify: `packages/database/src/workflows.ts` only if existing value/event/dispatch storage cannot represent checkpoints
- Test: `apps/api/test/workflow-runner.test.ts`, `workflow-agent-runtime.test.ts`

**Interfaces:**
- `createBrowserUseStep({ client, store, authorize, confirmations, policies }): WorkflowExecutor`.
- Prepared evidence: `{ destination, fields, value, terms, materialHash, observationRevision, sessionId }`; reuse the existing canonical confirmation hash rather than creating client authority.
- Checkpoint key is scoped by run/step/action ID. Receipt records `providerReference`, destination, material payload hash and evidence of the observed confirmation.

- [ ] Write failing integration tests for prepare → pause with zero writes → exact approval → single submit → receipt, using the real runner/store and controlled browser fixture.
- [ ] Add expiry, changed slot/price/terms, cancellation, ENS revocation during preparation, cross-account confirmation and duplicate-click cases; assert no unauthorized submission reaches the fixture server.
- [ ] Add crash cases before/after dispatch claim. After an ambiguous post-submit crash, assert `RECONCILIATION_REQUIRED`, no automatic resubmit, and read-only receipt inspection before recovery.
- [ ] Run `pnpm --filter @humanos/api test test/browser-use-step.test.ts` and record failures.
- [ ] Implement adapter wiring with live lease/account/ENS checks at every action and dispatch. Keep browser worker state subordinate to durable run state. Re-observe after restart and invalidate stale target references.
- [ ] Run targeted runner/ENS/confirmation/browser suites; commit as `feat: run Browser Use through durable confirmation and receipts`.

### Task 4: Booking intent and Jev action selection

**Files:**
- Create: `packages/models/src/jev/browser-selector.ts`, export through existing model index
- Create: `packages/models/test/browser-selector.test.ts`
- Create: `apps/api/src/workflows/booking-request.ts`, `apps/api/test/booking-request.test.ts`
- Modify: `apps/api/src/workflows/bindings.ts`, `runtime.ts`
- Test: `apps/api/test/workflow-booking.test.ts`

**Interfaces:**
- `BookingRequest = { site, restaurant, date, time, timezone, partySize, reservationName, contact, budget }`; unprovided values remain missing, not model-invented.
- `parseBookingRequest(input): { request: Partial<BookingRequest>, missing: string[] }`.
- `createBrowserActionSelector(config).select({ goal, facts, candidates }): { candidateId, confidence, alignment, risk, injection, needsReview }` using the existing structured Jev transport.
- Selector receives sanitized evidence and finite candidate IDs only; it cannot return executable code or alter site policy. Preserve existing workflow decision thresholds.

- [ ] Write failing tests for missing/ambiguous dates, invalid party size, timezone ambiguity, unsupported site, injected page instructions, fabricated action IDs, low-confidence choices and step-budget exhaustion.
- [ ] Run the model, request and booking tests and record red failures.
- [ ] Implement deterministic request validation and clarification. Connect Jev choices to task 2's candidates; retain DeepSeek exclusively for requested content. Bound a preparation session to 40 actions/10 minutes, then pause with evidence rather than retry indefinitely.
- [ ] Run focused tests, including ordinary research/email routing regressions; commit as `feat: route booking requests into bounded browser actions`.

### Task 5: Connection setup, visible progress and handoff

**Files:**
- Modify: `apps/api/src/workflows/connection-status.ts`, `apps/web/src/workflows/connections.tsx`, `workspace.tsx`, `workflow-review.tsx`
- Create: `apps/web/src/workflows/browser-handoff.tsx`, `browser-handoff.test.tsx`
- Modify: `.env.example`, `scripts/dev.mjs`, `README.md`
- Test: `apps/api/test/workflow-connection-status.test.ts`, existing workflow browser E2E test location selected from repository configuration

**Interfaces/configuration:**
- Opt-in `HUMANOS_BROWSER_DRIVER=browser-use`; disabled remains the default.
- `HUMANOS_BROWSER_WORKER_PYTHON` is a server-configured executable path, never request input; account profile paths are server-derived beneath a private configured directory.
- UI states: unavailable runtime, disconnected profile, needs details, preparing, needs login/handoff, awaiting final confirmation, submitted, confirmed, uncertain outcome.

- [ ] Write failing tests that runtime absence does not show connected, missing details produce a useful request, handoff is account-scoped, uncertain result never says booked, and final approval shows all material booking details.
- [ ] Run focused connection/UI tests and record failures.
- [ ] Implement worker lifecycle/setup instructions, explicit disclosure of model-visible sanitized observations, account-only/ENS-bound status, and user login/CAPTCHA handoff without displaying secrets.
- [ ] Exercise desktop and mobile with long venue names/terms, lost worker connection and expired approval. Run `pnpm test`, `pnpm typecheck`, `pnpm build` and Python tests. Report failures rather than suppressing them.
- [ ] Commit task-owned UI/setup changes as `feat: expose local booking progress and human handoff`.

### Task 6: Selected production site and live acceptance

**Files:**
- Create: `apps/browser-worker/humanos_browser/sites/restaurant.py` after the user selects a venue/site
- Create: `apps/browser-worker/tests/test_restaurant_policy.py`
- Create: `docs/reports/browser-use-live-acceptance.md`

**Interfaces:**
- Implement task 2's `SitePolicy` for exactly one inspected site; publish its supported venue/flow in readiness output. Do not label the fixture policy as a production integration.

- [ ] Obtain restaurant/site, date/time/timezone, party size, name, contact details and budget. Do not fabricate them or book a random venue. This task blocks on those inputs only.
- [ ] Inspect that site's real preparation, terms, submission and confirmation behavior. If the boundary cannot be enforced, report the specific incompatibility and offer manual handoff; do not weaken the guard.
- [ ] Write policy tests for actual field/request shapes with sensitive values removed. Observe failures, implement the policy and rerun controlled browser tests.
- [ ] Run one real preparation. Present exact booking and cancellation/deposit terms, obtain final confirmation, submit once and record the provider reference. Stop for user login, CAPTCHA or payment details where required.
- [ ] Record fixture versus live evidence, account versus ENS authority, action/model counts, time to first success, friction and failures. Do not claim ENS success until the independent live registration blocker is resolved.
- [ ] Complete an independent code review, address important findings, rerun affected tests and commit the site policy/report. Do not automatically cancel a real reservation for cleanup.

## Handoff and completion criteria

The approved architectural design is implemented only when tasks 1–5 pass and the worker genuinely uses Browser Use. A live restaurant demo is complete only after task 6's real provider evidence. Missing booking details or an incompatible site are explicit blockers, not mock successes. Preserve existing email/ENS work and disclose any remaining limitations.
