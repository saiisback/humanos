# ENS-bound TableCheck Booking Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Prepare and, after exact final confirmation, submit the selected TableCheck reservation through HumanOS's ENS-bound workflow, retaining a real provider reference.

**Architecture:** Extend the existing scoped Browser Use worker with a TableCheck-specific preparation state machine and exact transport envelope. Keep the TypeScript runner, live ENS authorizer, confirmation service and durable dispatch claim as the only execution authority. Do not introduce an unrestricted agent, alternate scheduler or direct assistant-operated booking.

**Tech Stack:** TypeScript, React, PostgreSQL, Valibot, Vitest, Python 3.12, Browser Use 0.13.10, pytest.

**Spec:** `docs/superpowers/specs/2026-09-27-tablecheck-production-design.md`

## Global Constraints

- HumanOS, not an assistant operating TableCheck separately, prepares the user's selected restaurant reservation.
- A registered ENS agent authorizes every browser action.
- Guest contact details remain in the authenticated workflow, not this document or test fixtures.
- Availability testing must not create a fake reservation.
- Do not enable an unrestricted autonomous Agent or change model routing.
- Unknown fields or unexplained state-changing requests pause execution.
- Do not authorize later writes under the same permit implicitly.
- Preserve existing dirty routing changes and `.claude/`; no history rewriting, merge or push as an incidental step.
- Keep production submission disabled until the actual provider contract passes the release gate.

## Review Focus

1. A contact email and “do not book yet” must never become permission to send mail; Task 2 covers this.
2. A same-origin redirect, CDN resource or preparation request must not become an unrestricted network allowance; Task 3 covers this.
3. A session token refresh must not authorize a different offer, price or cancellation agreement; Task 3 covers this.
4. An ENS binding from another workflow/version, a namespace reset or an expired binding must not permit account fallback; Task 4 covers this.
5. A crash after the provider received a request must not cause a second booking; Task 5 covers this.

## File ownership and order

Task 1 records the real provider contract. Task 2 owns typed intake. Task 3 owns Python policy/actions and matching protocol schemas. Task 4 owns the HumanOS routing, ENS gate and review UI. Task 5 verifies the assembled application. Execute sequentially in the current session; the user requested direct implementation. A final independent review is required before enabling live submission.

### Task 1: Establish the real provider contract without booking

**Files:** Create `docs/reports/tablecheck-contract-2026-09-27.md` and `apps/browser-worker/tests/fixtures/tablecheck-contract.json`.

**Interfaces:** The redacted fixture contains observed field names/multiplicity, resource origins/paths, preparation request shapes, provider stage names and evidence provenance. It contains no CSRF values, cookies, contact data or speculative receipt selectors. Later tasks consume only verified shapes from this record.

- [ ] Inspect the selected public form and required first-party scripts. Record the observed `/en/shops/brooklynparlor-shinjuku/reserve/create` form action as an effectful endpoint, not a harmless preview.
- [ ] Identify read-only availability requests, required assets, nested fields, duplicated checkbox semantics and date/offer controls. Record each request's purpose and whether its effects can be bounded. No personal-data submission, fake reservation or payment probing.
- [ ] Identify the final confirmation and receipt contract from primary source or a provider-supported non-production mechanism. If those cannot be verified without a live write, keep dispatch disabled and finish preparation/handoff only; report the exact remaining unknown rather than invent it.
- [ ] Validate the sanitized fixture as JSON: `node -e 'JSON.parse(require("node:fs").readFileSync("apps/browser-worker/tests/fixtures/tablecheck-contract.json", "utf8")); console.log("valid")'`. Expected: `valid`, with no unverified fields marked supported.
- [ ] Commit only the sanitized contract evidence as `docs: record inspected TableCheck booking contract`.

### Task 2: Typed restaurant intake with explicit final-action intent

**Files:** Create `packages/schemas/src/restaurant-intake.ts`, `packages/schemas/test/restaurant-intake.test.ts`, `apps/web/src/workflows/restaurant-clarification.tsx`, and its test. Modify schema exports, `apps/api/src/workflows/booking-request.ts`, `bindings.ts`, `apps/web/src/workflows/refine-card.tsx`. Extend existing booking/routing tests.

**Interfaces:** Export `RestaurantBookingDetailsSchema` and inferred `RestaurantBookingDetails` with `siteId`, `venueId`, `date`, `time`, `timezone`, `adults`, `children`, `guestFirstName`, `guestLastName`, `phone`, `email`, `allergies`, `offerId`, `intent: 'prepare' | 'book'`. Export `restaurantIntake(goal: string, now?: Date)` returning `{ isRestaurant: boolean; details: Partial<RestaurantBookingDetails>; missing: string[]; invalid: string[] }`. Unsupported or ambiguous details remain missing; no model-invented values.

- [ ] Write failing tests: future date stays exact; past/ambiguous dates are rejected; phone requires a country code; “none” is an explicit allergy answer, not a default; conflicting values require clarification. Assert no email capability for a reservation contact address or preparation-only request. Include the already reproduced “do not book yet” case.
- [ ] Run `pnpm --filter @humanos/schemas test` and `pnpm --filter @humanos/api test test/workflow-booking.test.ts test/browser-use-routing.test.ts`. Expected before implementation: new behavioral assertions fail.
- [ ] Implement the schema/intake and a small HumanOS form for missing values. Preserve all supplied details and final-action intent. Select only the inspected venue and offer; never silently substitute a time or paid course. Explicitly display same-day phone-only restriction for this venue.
- [ ] Run the same suites and `pnpm --filter @humanos/web test`. Expected: pass; no executable graph until mandatory inputs and supported site are available.
- [ ] Commit task-owned files as `feat: collect exact restaurant booking details in HumanOS`.

### Task 3: TableCheck state machine and exact transport guard

**Files:** Create `apps/browser-worker/humanos_browser/sites/tablecheck.py`, `tablecheck_form.py`, `tests/test_tablecheck_form.py`, `tests/test_tablecheck_policy.py`, `tests/test_tablecheck_actions.py`. Modify `policy.py`, `session.py`, `worker.py`, `protocol.py`, `packages/schemas/src/browser-worker.ts` and corresponding protocol tests only where required.

**Interfaces:** `TableCheckActions` implements the existing `open`, `observe`, `act`, `prepare`, `submit`, `inspect_receipt` interface. `PreparedForm` stores `pairs: tuple[tuple[str,str], ...]`, `method`, `destination`, `semantic_hash` and `transport_hash` privately in the worker. `validate_tablecheck_form(pairs, reviewed, contract) -> PreparedForm` rejects unlisted keys, unexpected multiplicity, changed semantic values and unknown offers. `matches_prepared_form(content_type, body, prepared) -> bool` accepts only the frozen reviewed transport, including audited duplicate semantics. No token is included in `prepared.fields` or facts returned to the API/model.

- [ ] Write failing pure tests for nested keys, known/unknown duplicates, checkbox order, extra fields, wrong method/origin/path, token changes, altered time/offer, marketing/account-creation fields, and missing terms. Assertions use independently hand-written expected fields and observed redacted contract shapes.
- [ ] Run `uv run --project apps/browser-worker pytest apps/browser-worker/tests/test_tablecheck_form.py apps/browser-worker/tests/test_tablecheck_policy.py`. Expected: fail before implementation.
- [ ] Implement the private form validator and exact request guard. Keep fixture policies unchanged. Approve only inspected public-origin resource paths and typed read-only availability requests; pin DNS for each required origin. Block analytics, payments, unknown redirects/writes, downloads and uploads. A token refresh invalidates the old prepared envelope and approval.
- [ ] Implement TableCheck actions using the existing Browser Use actor. Capture complete terms and exact chosen offer; reject ambiguous or missing controls. Add a preparation-only result that cannot issue a dispatch permit. Thread semantic/transport commitments through the protocol without exposing token values.
- [ ] Add controlled browser tests proving zero unapproved writes during preparation, changed details invalidate review, and one approved submission writes exactly once. Include click-handler mutation and the existing material-binding expected failure: production release requires that issue to be resolved for this adapter, not merely marked xfail.
- [ ] Run `uv run --project apps/browser-worker pytest` and `pnpm --filter @humanos/schemas test`. Expected: new tests pass, existing fixture behavior unchanged, no skipped production security case accepted as evidence.
- [ ] Commit as `feat: add guarded TableCheck preparation and submission adapter` only if contract-dependent implementation is verified. If final transport remains unknown, commit preparation separately and keep production submission disabled.

### Task 4: ENS-only HumanOS workflow and exact final review

**Files:** Modify `apps/api/src/workflows/browser-use-policy.ts`, `browser-use-step.ts`, `booking-request.ts`, `bindings.ts`, `runtime.ts`, `agents.ts` only if an actual binding gap is found; `apps/web/src/workflows/workspace.tsx`, `workflow-review.tsx`, `browser-handoff.tsx`. Extend `browser-use-step.test.ts`, `workflow-agent-runtime.test.ts`, `workflow-booking.test.ts`, web review/handoff tests. Create `apps/api/test/tablecheck-routing.test.ts`.

**Interfaces:** Add policy ID `tablecheck-brooklyn-parlor` only with verified preparation support. The server policy exposes `supportsSubmission: boolean`; the UI distinguishes preparation readiness from submission readiness. Existing `createWorkflowAgentService.review/enable` is the only registration route. Run pins remain `authorityMode: 'ens'` plus the exact `agentBindingId`. Do not create new wallet or chain-permission semantics.

- [ ] Write failing tests that an account-owned booking cannot run the ENS-only route, a version mismatch requires a fresh binding, preparation-only cannot reach dispatch, and unsupported submission readiness stays visibly blocked. Assert graph capabilities contain no email, payments or wallet spending.
- [ ] Run `pnpm --filter @humanos/api test test/tablecheck-routing.test.ts test/workflow-agent-runtime.test.ts test/browser-use-step.test.ts`. Expected: new assertions fail before implementation.
- [ ] Wire validated intake into the TableCheck policy and worker. Use the existing scope review/registration/start flow; require live ENS authority before every browser operation and before final dispatch. Never register an agent for a clarification-only graph. Preserve user consent review and chain finality rather than marking a pending agent active.
- [ ] Render provider-reviewed venue, exact date/time/timezone, party, offer, guest details, fees and complete cancellation terms in one final booking review. Show pending preparation, unavailable slot, handoff and uncertain outcome honestly. Show real ENS name/expiry and transaction links in expandable details.
- [ ] Test ENS revocation during preparation, expired approval during dispatch, cross-account session/preview access, namespace reset, worker restart and changed offer. Run API/web targeted suites plus `pnpm typecheck`. Expected: all pass with no account fallback or extra external capabilities.
- [ ] Commit as `feat: run TableCheck preparation through scoped ENS agents`.

### Task 5: HumanOS execution evidence and controlled live acceptance

**Files:** Create `tests/e2e/tablecheck-booking.spec.ts` and `docs/reports/tablecheck-humanos-acceptance.md`. Reuse the existing controlled browser fixture and isolated test database helpers.

**Interfaces:** Acceptance report distinguishes fixture, live read-only preparation and live final submission. It records workflow/version/run IDs, ENS binding/name and chain evidence, observed provider reference, status and measured timestamps without secrets or raw personal form bodies.

- [ ] Write and run a failing app-level test: intake → ENS authority → actual worker preparation → exact confirmation → one controlled reservation → receipt. Assert the local fixture's write ledger, not mocked success text. Cover failure/cancellation and ambiguous dispatch without resubmission.
- [ ] Run `pnpm test`, `pnpm typecheck`, `pnpm build` and `uv run --project apps/browser-worker pytest`. Expected: all required tests/builds pass; disclose any expected failure or skipped case and do not treat it as live acceptance.
- [ ] Perform a final independent review of network boundaries, private token handling, exact confirmation, binding pinning, expiry/revocation, durable dispatch and honest receipts. Resolve important findings with failing regression tests before enabling submission.
- [ ] Restart the local HumanOS API with verified code. Use the HumanOS UI to save the user's confirmed details and review/register the scoped Sepolia agent. If a separate chain-consent action is required, present the exact scope/gas/expiry at that action, not a generic repeated permission prompt.
- [ ] Run live read-only preparation from that ENS-bound HumanOS workflow. Do not use an assistant-operated TableCheck tab as the booking executor. Show actual availability and full terms, or the concrete provider handoff.
- [ ] Immediately before the actual final write, obtain confirmation of the displayed provider details and fees. Submit once through HumanOS; require the provider confirmation/reference. If outcome is uncertain, reconcile read-only and never automatically resubmit or cancel.
- [ ] Record the outcome, link the visible HumanOS run and commit acceptance evidence. No live-success claim without provider evidence; no automatic push.

## Plan self-review

All seven spec changes map to Tasks 2–5. Task 1 is an explicit evidence gate for unknown provider semantics, not permission to guess final endpoints. The private transport envelope remains worker-owned; API and UI consume semantic evidence only. The five review-focus cases are covered in the owning tasks. Existing email/JAW and routing edits are preserved. Execution is direct/native as requested, after plan review.
