# HumanOS live scenario evidence — 26 September 2026

This record distinguishes live execution from automated fixture tests. No email or restaurant reservation has been submitted.

## Current live checks

| Scenario | Observed outcome |
| --- | --- |
| API health | `GET /api/health` returned 200, `status: ok`. |
| Unauthorized workflow access | Anonymous list, connection status and run detail requests returned 401. |
| Flue workflow route | Initially returned 404 despite healthy `/health`. The running process predated the workflow route. Restarted only the local agent service; unauthenticated workflow route now returns 401 as expected. |
| Real Jev assembly | Saved workflow `36ef5029-7e0f-4e41-a3b8-82968fbbc1b3` initially stopped on the unavailable Flue route. After restart, retry produced a single “Write with DeepSeek” plan. |
| Real DeepSeek generation | Same workflow reached “Run complete” in the authenticated UI and showed: “Welcome to HumanOS — we're glad you're here. Take a look around, get comfortable, and reach out if you need anything as you settle in.” No sending step existed. |
| Persistence after reload | Reloaded the same URL; authenticated session, saved workflow, completed timeline and identical output reappeared. |
| Real connection status | OpenCode configured; Brave and Resend require setup; local browser off. No secrets displayed. |
| Unsupported booking | `9a4aa49d-ca86-4e46-b2e6-cdb999df3331`, initially “Book a restaurant for dinner.”, stopped for Jev review. Nothing was booked. |
| Refinement and classifier regression | Refining to a reservation-inquiry draft exposed a routing bug: the word “reservation” overrode “draft only.” Added three failing regression cases, corrected the booking condition, and observed all 17 binding/booking tests pass. Live retry then produced a content-only plan. |
| Second live DeepSeek result | The refined workflow completed with a reservation inquiry template containing placeholders for restaurant/date/party size/contact details. This is a draft, not an availability check or reservation. |

The live browser check used HumanOS in the in-app browser, which already had an authenticated session. Helium was in use by the user and was left alone.

## Separate automated evidence

After integrating the reviewed batch and booking routing into main and fixing the live-discovered classifier bug, the final `pnpm test` run passed **763 tests**, including 250 API tests and 59 frontend tests. Full typecheck passed, followed by an API typecheck after the classifier fix; the frontend production build passed with the existing large-bundle warning. Browser executor tests used isolated Chromium with fixture servers; they are **not** proof of a real reservation.

## Still required for a real external-action demo

- User-selected booking site/restaurant, date, time and party size; an audited production recipe and required login. Stop before submission for exact final confirmation.
- User-selected email recipient and approved message; a connected real email provider. Stop before sending for exact final confirmation.
- Live research, schedule execution and workflow-specific ENS permission receipts remain unverified in this round.
