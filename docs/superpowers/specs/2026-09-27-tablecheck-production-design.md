# TableCheck booking through an ENS-bound HumanOS agent

Status: approved; typed intake and routing implemented. Provider execution and live acceptance remain incomplete.

## Required result

HumanOS, not an assistant operating TableCheck separately, prepares the user's
selected restaurant reservation. A registered ENS agent authorizes every browser
action. HumanOS shows the provider's exact booking and terms, obtains one final
confirmation, submits once, and records an observed provider reference. An
unavailable slot, login challenge, uncertain outcome, or missing integration is
never presented as a booking.

Initial supported venue: Brooklyn Parlor Shinjuku, on TableCheck. Guest contact
details remain in the authenticated workflow, not this document or test fixtures.
Availability testing must not create a fake reservation.

## Evidence and correction to the earlier estimate

The public booking page was inspected on September 27, 2026:
https://www.tablecheck.com/en/shops/brooklynparlor-shinjuku/reserve

Its form declares POST `/en/shops/brooklynparlor-shinjuku/reserve/create`, with
`data-remote=true`. It has `authenticity_token`, nested `reservation[...]` names,
menu/question IDs, and duplicate checkbox parameters. Its scripts include
TableCheck CDN resources and third-party analytics/payment resources. Listing
those resources is not evidence that any of them must be allowed.

The existing Python SitePolicy/NetworkGuard supports one origin, fixed read paths,
simple field names and a single URL-encoded request with unique keys. BookingActions
also assumes fillable fields followed by one submit and a known receipt selector.
The production registry is empty. Therefore enabling a policy with guessed
selectors or an unrestricted network allowlist is not an implementation.

The next page, actual availability request contract, receipt page and any OTP
requirements remain unverified. `/reserve/create` must not be classified as a
harmless preview or called without final authorization based on its label.

The venue says same-day reservations and parties of six or more require a phone
call. HumanOS must surface this restriction rather than fabricate availability.

## Changes to the existing architecture

Retain the durable TypeScript runner, ENS authorizer, confirmation store, scoped
Python worker and Browser Use actor. Add a TableCheck-specific state machine;
do not enable an unrestricted autonomous Agent or change model routing.

States: needs_details → preparing → needs_user / unavailable / review_ready →
dispatch_claimed → confirmed / reconciliation_required.

1. **Typed intake.** Store explicit venue, date, timezone, exact time, adult/child
   counts, selected offer, guest first/last name, phone, email and allergy answer.
   Preserve user constraints. Ambiguity asks a question inside HumanOS. Do not
   treat the contact email as an instruction to send mail. Do not pick a different
   time, venue, paid course, or date without approval.
2. **ENS binding.** Make the workflow require ENS before execution. Derive the
   minimal capabilities from its executable version; register under the configured
   test namespace with scope hash and expiry. Wait for verified live authority.
   Pin each run to that binding and version. Check authorization before each worker
   operation and dispatch; fail closed on expiry/revocation. An unsupported plan
   must not be made executable merely by granting permissions.
3. **Preparation contract.** Inspect actual public availability traffic and
   source-backed field mappings. Permit only verified read-only requests with
   typed arguments. Explicitly enumerate required CDN resources; continue blocking
   telemetry, payments, account creation and unknown traffic. Public DNS checks and
   pinned destination resolution apply to every approved origin. Browser profiles
   remain dedicated and never import everyday browser cookies.
4. **Form envelope.** Separate semantic booking fields from provider transport
   fields. Validate a bounded multimap against an exact server-authored schema;
   known checkbox duplicates are explicit, not a blanket duplicate-key allowance.
   Bind hidden offer/menu/question IDs to the selected reviewed offer. Keep CSRF
   tokens private to the worker; never expose them in UI, logs or model context.
   Unknown fields or unexplained state-changing requests pause execution.
5. **Final review.** Read back exact venue, date/time/timezone, party, offer, guest
   details, fees/deposit and cancellation terms. No truncation of authorization
   evidence. Persist a canonical semantic hash and private transport commitment.
   The approval is bound to run, version, ENS agent, session, destination and expiry.
   Any changed material state requires a new review. If the provider cannot bind
   material terms to a submitted offer, automatic submission remains disabled.
6. **Dispatch and receipt.** Claim dispatch durably, check ENS and approval again,
   then allow exactly one inspected booking request matching the private envelope.
   Do not authorize later writes under the same permit implicitly. Determine any
   multi-stage provider semantics before enabling them. Confirm success only from
   an inspected provider status/reference, not a click or HTTP 200. Ambiguity
   requires read-only reconciliation; never retry the submission automatically.
7. **User handoff.** Authentication, CAPTCHA, OTP and payment requirements stay
   explicit HumanOS handoffs. No hidden acceptance of marketing or account creation.
   Unsupported operations pause visibly rather than suggesting that retries work.

## Verification and release gate

- Reproduce the real request shapes using redacted local fixtures; tests assert
  observed server writes, not just mocked success responses.
- Test form duplicates, nested fields, missing/changed CSRF, added parameters,
  wrong offer, changed terms, redirects, off-origin and private-network requests.
- Test ENS expiry/revocation before preparation and dispatch, cross-account access,
  cancellation, expired approval, restart and crash immediately after submission.
- Exercise the complete HumanOS UI with fixture preparation, exact confirmation,
  one submission and receipt, clearly labeled as a fixture.
- Perform live read-only preparation through HumanOS's ENS-bound runtime; retain
  evidence of availability and the full final review without submitting test data.
- Final live submission requires the actual user's reviewed details and an
  observed provider contract. Report a real confirmation reference or an honest
  unresolved outcome. Never label fixture success as live acceptance.

Until those gates pass, TableCheck must remain unavailable for automatic submission.
This document does not claim that a reservation or agent registration occurred.
