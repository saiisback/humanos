# Live validation — September 26, 2026 (JST)

## Verdict

Infrastructure is configured, and live model requests succeed after the OpenCode top-up. The requested general-purpose workflow product is **not yet implemented end to end**. No email was sent, restaurant reserved, or external calendar event created in this validation.

## Evidence

- API `/api/ready`: six configured services. This endpoint checks configuration, not provider health or connector coverage.
- Flue `/health`: `{"status":"ok"}`.
- Live OpenCode DeepSeek: HTTP 200, model `deepseek-v4.1-flash`, approximately 4.35 seconds. Existing adapter parsed a synthetic checklist proposal.
- Live OpenCode Jev: HTTP 200, model `jev-1.13`, approximately 1.32 seconds. Existing adapter parsed its structured evaluation. Earlier requests returned HTTP 402 with insufficient account funds; the later requests succeeded.
- A real unauthenticated POST to `/api/missions` returned HTTP 401 `UNAUTHENTICATED`; no session was forged or authentication bypassed.
- Controller `pnpm test`: exit 0, 450 tests at that point, including four temporary HTTPS configuration tests. HTTPS work was then removed at the user's request; the restored web suite passed all 40 remaining tests. Other packages were unchanged except the provider-test isolation fix.
- A separate concurrent agent suite encountered a receipt timeout in the ENS parent-detachment test. The controller's ENS run passed 51 tests. This timeout is recorded, not hidden as an unconditional repeatability claim.
- Web production build passed while HTTPS support was present, with a bundle-size warning. After withdrawing HTTPS, the original Vite configuration was restored and the web tests rerun.

## Gaps against the intended product

| Requirement | Observed implementation |
| --- | --- |
| Jev selects deterministic workflow blocks | New constrained selector passes a live offered-candidate/parameter check. Legacy web missions still use DeepSeek proposals; new assembly and execution routes are not wired yet. |
| DeepSeek generates content only | New content-only adapter passed a live typed greeting test. Legacy mission adapter remains until workflow UI cutover. |
| Real email and restaurant reservations | No production connector in the current effect adapter. It supports only application/calendar effects against the configured local development service. |
| Research-backed itinerary | No live research connector or assembled itinerary workflow verified. Model-only text must not be represented as checked current availability. |
| Durable general workflow graphs and local recurrence | Approved design/plan exist; corresponding general workflow engine is not present. |
| User's logged-in browser fallback | Not implemented in HumanOS. Codex operating Helium is not evidence that HumanOS has that capability. |
| Single final confirmation, optional PoH | Existing missions still require a World-bound root; the proposed workflow-specific trust model has not replaced that route. |
| ENSv2 identity and scoped permissions | Real deployed contracts and adapter; live hierarchy verified, but no root/agent registrations existed at the checked block. |

## ENSv2 live reads

- Chain: Ethereum Sepolia.
- Parent: `test-humanos.eth`, attached to HumanOS registry `0x795f86005477F76B892cdE4BA0367bC333CB13eD`.
- Registrar: `0x727c3B6bDF63719d262CcA9090D9E5311bB72B51`.
- Parent expiry: September 25, 2027.
- At checked block 11780790, no root/agent registration events since deployment block 11780753.
- Registrar has register/unregister/renew roles; agents are designed to receive only scoped status/receipt resolver rights. Off-chain effect authorization remains the API policy's responsibility.
- `ENS_AGENT_FUNDING_WEI=0`: derived signers need gas before publishing receipts. Finalized-chain checks can also delay new authorizations.
- Backend currently does not supply `jawPermissionVerifier`; wallet permission grants remain unverified and cannot authorize protected wallet effects.

## Helium and login

Helium is signed in and displays the real saved proposal `58b7a288-8077-4d68-897c-18cffa7312d9`, titled “Three-Day Japan Itinerary Research and Draft,” with `web.search` and `drafts.write` only. A read-only database check also confirmed `PROPOSED` state. The UI displays expiry September 26 at 04:07 JST. This proves live proposal creation and persistence, not research execution or itinerary delivery. The permission-grant button has not been clicked; action-time confirmation was requested.

Live creation initially failed because the model proposed a date in the past. The server now owns the default one-hour expiry, validates an explicit requested expiry before calling the provider, and rechecks it after the call. Regression tests passed (5 API tests). Provider credit/auth/rate-limit/timeout errors now have distinct sanitized messages (26 model tests passed). The composer reports preparation, requests time out without automatic mutation retries, and hot refresh reuses the React root (44 web tests and web typecheck passed). These are implementation checks, not evidence of provider effect completion.

Native Helium captures intermittently appeared blank while changes reloaded. Later accessibility output visibly showed the complete saved proposal. Console included browser-extension errors; these alone do not establish an application authentication failure.

The user cancelled embedded-login work. Original HTTP/popup behavior was restored; `.env` origin was never switched. `mkcert` and local certificate files were created during the previously approved attempt, but system trust installation failed awaiting administrator authentication. Certificates remain ignored and unused; no browser security warning was bypassed.

## Next implementation order

1. Fixed typed block catalog and Jev selection, with DeepSeek restricted to content.
2. Account-owned durable run state, visible steps, actual missing-connection pauses.
3. One real service connector with account authorization, exact final confirmation, provider reference, and reconciliation.
4. ENS agent registration, scoped permissions, funded receipt publication, and observable revocation.
5. Browser fallback and recurrence only after their safety/recovery paths are implemented and tested.

The proposed $10–20 price point remains a business target, not a measured result. Measure model tokens, connector costs, browser runtime, retry rate, and support overhead per completed workflow before making a savings claim.

## Constrained adapter check

OpenCode synthetic requests validated the new boundaries: Jev selected an offered candidate and enum parameter in 1.463 seconds; DeepSeek returned a typed greeting in 5.609 seconds. Jev's confidence was 0.49 and it requested review, so this selection is **not** safe to auto-execute. Assembly must enforce review/confidence thresholds. Model suite: 38 tests passed and typecheck passed. Whole-workspace typecheck and the web production build passed before these added adapters; web build still reports a large-bundle warning.

## Durable workflow checkpoint — September 26, continued

- **Live success in Helium:** saved workflow `eccfa73d-0a7e-4f30-9bd3-1c1c7ecc4e95` was reviewed and run. The UI displayed `Run complete`, a completed DeepSeek step, and the real two-sentence welcome draft. This was a content-only task, not an email delivery.
- **Live stopped path:** `Research a three-day Japan itinerary` was saved but Jev requested review; no research or external action occurred. Confidence/review thresholds were not relaxed. Generic research reliability remains an acceptance gap.
- **Flue:** its health endpoint returns `ok`. Saved-workflow assembly is now wired through the authenticated private Flue bridge when configured; unit tests cover configuration and transport. The subsequent live workflow was saved, but its outcome was not verified before Helium was in use by the user.
- **Confirmation safety:** approval probes are separate from an atomic, run-locked final dispatch claim. Concurrent claims for one step yield exactly one winner. Changed payload, wrong actor, stale revision, expired lease, cancelled run, expired/revoked session, and repeat dispatch are rejected or halted for reconciliation. This is automated-test evidence, not proof of a live third-party send.
- **Schedules:** local recurring/one-time schedules pin a workflow version and execution session, skip overlaps, and persist occurrences. The local server must remain running. Expired/revoked sessions stop execution; external effects still require exact confirmation. Live scheduled delivery has not been demonstrated.

### Setup still required for live external tests

`OPENCODE_API_KEY` provides model access only. Real web research uses `BRAVE_SEARCH_API_KEY`. The implemented email adapter uses `RESEND_API_KEY` plus an authorized `RESEND_FROM_EMAIL`. `CONNECTOR_ACCOUNT_ID` must be the signed-in HumanOS account ID, not just an unqualified wallet address. Set these only in the private server `.env`; never expose them as `VITE_*` keys. Provider credentials being present is not proof of valid account permissions or successful delivery.

The real email test also needs an explicitly chosen recipient and final content approval. A reservation test needs an approved booking service/site and browser connection. A working logged-in browser driver is **not yet implemented**, and no reservation has been made. New standalone workflows currently display that no ENS agent is linked; the existing ENS mission flow remains separate. General workflow-to-ENS permission binding is **not complete**. Unsupported work pauses and must not be advertised as universal automation.
