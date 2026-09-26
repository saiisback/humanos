# TableCheck contract inspection — September 27, 2026

Status: public preparation behavior inspected; live submission/receipt not verified.

Sources inspected: [selected venue](https://www.tablecheck.com/en/shops/brooklynparlor-shinjuku/reserve) and its first-party application JavaScript, asset hash `cc43035403a6940cbe4862d431581fa1a559874132f6076dc2ce0dd209b2a16c`.

- Form `#new_reservation`: POST `/en/shops/brooklynparlor-shinjuku/reserve/create`, `data-remote=true`.
- `BusinessTimes.fetch`: GET `/en/shops/brooklynparlor-shinjuku/sheets`; start date, party counts, duration and selected orders. Response `slots` populates `#reservation_start_at_epoch` with label/epoch pairs.
- `OnlineAvailability.sendRequestForSameDay`: GET `/en/shops/brooklynparlor-shinjuku/available`; sanitizes customer data out, retains epoch, party counts and selected orders. `success` is availability, NOT a confirmed reservation.
- Selected dinner table-only offer in the public page: `66c4d4411c588898fe3bb84b`.
- Nested reservation fields, CSRF token and duplicated checkbox names preclude the worker's current flat-form contract.
- Scripts/resources outside TableCheck's approved origins, analytics and payment code are not automatically required or permitted.
- Venue policy: same-day bookings and parties of six or more must call; table-only bookings require one food and one drink per guest; busy periods may be limited to two hours. Review the live terms again before any final approval.

No CSRF token, cookie or customer field was sent during this inspection. No reservation creation endpoint was called. Exact creation response, any subsequent confirmation/OTP stage, and receipt extraction remain unverified. Automatic submission must remain disabled.

## Verified read-only probe and supported integration alternatives

A public availability GET for September 28, 2026, 19:00 JST, two adults and the table-only dinner offer returned HTTP 200 with `status: success`. This was a development inspection outside the HumanOS executor, not an ENS-authorized workflow run and not a reservation. Availability may change.

TableCheck's [Web Booking documentation](https://tablecheck.atlassian.net/wiki/spaces/API/pages/48595292/Web%20Booking%20v1) describes a website handoff, optional customer autofill, and querying completed reservations. It directs implementers to request test data from its API team; its read-only Web Booking API is not a direct reservation-creation API.

Its [Distribution API](https://tablecheck.atlassian.net/wiki/spaces/API/pages/4637950094) supports native reservation creation and menu selection, but not payments. API access is a separate integration path, not something the existing Brave, Resend or model keys grant. This report does not switch the approved Browser Use architecture to that API or assert that such access exists.
