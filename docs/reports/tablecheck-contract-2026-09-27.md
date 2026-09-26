# TableCheck contract inspection — September 27, 2026

Status: public preparation behavior inspected; live submission/receipt not verified.

## Implemented HumanOS path

Complete saved restaurant details now assemble a `browser.availability` step. This is an ENS-required **read**, scoped to `web.search`, not `application.submit`. Legacy account-owned workflows are upgraded to require ENS when this step is assembled; registration and live authorization are still required separately.

The installed Brooklyn Parlor worker policy has **no submission contract**. It binds one exact availability query (date/time, party size and inspected offer) before navigation. Guest names, phone numbers, email addresses and allergy details remain out of that request. Responses produce an availability report with `booked: false`, never a reservation receipt. Final creation and receipt verification remain unimplemented.

A real Chromium test against a local provider-shaped server exercises the worker, observes one availability GET and zero writes, and rejects forged submission. This is integration-test evidence, not evidence of a live restaurant booking or a live ENS-authorized availability run. A private nested-form validator is also implemented for later submission work, but is deliberately not connected to dispatch.

Sources inspected: [selected venue](https://www.tablecheck.com/en/shops/brooklynparlor-shinjuku/reserve) and its first-party application JavaScript, asset hash `cc43035403a6940cbe4862d431581fa1a559874132f6076dc2ce0dd209b2a16c`.

- Form `#new_reservation`: POST `/en/shops/brooklynparlor-shinjuku/reserve/create`, `data-remote=true`.
- `BusinessTimes.fetch`: GET `/en/shops/brooklynparlor-shinjuku/sheets`; start date, party counts, duration and selected orders. Response `slots` populates `#reservation_start_at_epoch` with label/epoch pairs.
- `OnlineAvailability.sendRequestForSameDay`: GET `/en/shops/brooklynparlor-shinjuku/available`; sanitizes customer data out, retains epoch, party counts and selected orders. `success` is availability, NOT a confirmed reservation.
- Selected dinner table-only offer in the public page: `66c4d4411c588898fe3bb84b`.
- Nested reservation fields, CSRF token and duplicated checkbox names preclude the worker's current flat-form contract.
- Scripts/resources outside TableCheck's approved origins, analytics and payment code are not automatically required or permitted.
- Venue policy: same-day bookings and parties of six or more must call; table-only bookings require one food and one drink per guest; busy periods may be limited to two hours. Review the live terms again before any final approval.

No CSRF token, cookie or customer field was sent during this inspection. No reservation creation endpoint was called. Exact creation response, any subsequent confirmation/OTP stage, and receipt extraction remain unverified. Automatic submission must remain disabled.

## Follow-up: submission is not a single confirmed write

Read-only inspection of the same first-party [application bundle](https://cdn1.tablecheck.com/assets/table_check/application-cc43035403a6940cbe4862d431581fa1a559874132f6076dc2ce0dd209b2a16c.js) establishes the following static code facts, not a live execution trace:

- The remote-form transport accepts executable script responses by default. Do not assume `/reserve/create` returns reservation JSON or that HTTP 200 means success.
- Review/payment-form code chooses its final form action from server-injected configuration (`urlForCCPayment` or `urlForWalletPayment`), including the no-payment branch. The initial page does not establish that final action URL.
- Review terms can cause a separate PUT to `/shops/{shop}/reserve/update_terms`. Merely checking a terms control can therefore be a provider-side write. The current read-only policy must not permit this accidentally.
- Reservation-page code reads a confirmation code from `#reservation-data`. This is a candidate receipt field, not a proven selector on this venue's completed booking. A reference alone does not establish the reservation's status.
- The bundle contains OTP resend and magic-link review handlers. The latter polls a server-provided status URL and handles completed/expired/failed, with a returned confirmation URL on completion. This proves possible branches exist; it does **not** prove this venue or offer requires either branch.
- The selected venue explicitly says the booking confirmation is sent to the provided email. HumanOS should distinguish provider-promised email from verified email delivery; it need not manufacture a separate confirmation message to make a booking appear successful.

The [official confirmation-path report](tablecheck-official-confirmation-path.md) corroborates an intermediate review and a final confirmation step, and distinguishes reservation status from payment receipts.

### Implementation consequence

The existing private form envelope validates only the initial request. It is insufficient for production booking dispatch. Required state sequence: saved intake → authorized provider preparation → observed review → exact user approval → live ENS authorization → one final provider submission → observed reservation ID **and status** → optional email-delivery evidence. Login/OTP/card requirements require a user handoff; an uncertain final response requires reconciliation, not automatic resubmission.

Remaining acceptance gate: capture an authorized test-session response and review DOM, final action/method/payload, and final reservation-status DOM. Public source inspection cannot supply that session-specific evidence. No live write, test-data submission, email, or booking was made in this follow-up.

## Verified read-only probe and supported integration alternatives

A public availability GET for September 28, 2026, 19:00 JST, two adults and the table-only dinner offer returned HTTP 200 with `status: success`. This was a development inspection outside the HumanOS executor, not an ENS-authorized workflow run and not a reservation. Availability may change.

TableCheck's [Web Booking documentation](https://tablecheck.atlassian.net/wiki/spaces/API/pages/48595292/Web%20Booking%20v1) describes a website handoff, optional customer autofill, and querying completed reservations. It directs implementers to request test data from its API team; its read-only Web Booking API is not a direct reservation-creation API.

Its [Distribution API](https://tablecheck.atlassian.net/wiki/spaces/API/pages/4637950094) supports native reservation creation and menu selection, but not payments. API access is a separate integration path, not something the existing Brave, Resend or model keys grant. This report does not switch the approved Browser Use architecture to that API or assert that such access exists.
