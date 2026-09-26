# Direct Browser Use execution review

Codex took over implementation and review directly at the user's request. All activity in this batch uses isolated local fixtures. No live reservation, login, payment, email or ENS transaction was performed. Changes remain in the feature worktree.

## Fixed: held window outlives authority

A paused login window previously stayed open after its account/agent authority expired or was revoked, until the hold timer elapsed or someone resumed the workflow. A new failing lifecycle test reproduced this. Held sessions now retain their scoped execution context; the existing sweep checks live authorization as well as run state, fails closed on authorization errors, and closes unauthorized sessions. Resume refreshes the retained context. Cleanup remains bounded by the sweep interval (default 30 seconds), not instantaneous.

Lifecycle regression: 9 tests passed after the fix (8 passed / 1 failed before it).

## Unresolved release blocker: terms changed by final click

A real Chromium fixture now reproduces a material/dispatch race: a final click handler changes deposit and cancellation terms while leaving the submitted form fields unchanged. The network gate accepts those unchanged fields after the worker's earlier material check. The fixture server received one request and the worker reported success. This is not safe enough for production booking.

The regression is explicitly marked **strict expected failure** in `test_actions.py`; it is not counted as a pass or a verified safety property. The `click-drift` fixture is retained for the eventual fix.

An attempted fix reread material while the actual request was paused by CDP. It blocked the attack but also blocked valid form navigation: the material read timed out while navigation awaited release. Both actor lookup and direct Runtime evaluation were tried. That unsuccessful implementation and temporary diagnostics were removed. The full workspace run made during that experiment failed its real-worker reservation test; final verification is recorded separately below.

Production policies remain empty, so this vulnerable fixture is not exposed as a supported live booking service. Production acceptance requires an inspected site with enforceable binding between reviewed offer/price/terms and the request (for example a provider-enforced quote identifier), or a separately verified dispatch mechanism. A DOM hash alone is not proof that the provider honors the reviewed price.

## Login handoff limitation

The lifecycle tests verify window retention and same-session resume, not a real login. The network guard still blocks unlisted login POSTs, external identity origins and CAPTCHA traffic. Enabling arbitrary writes for a manual handoff would defeat the guard and was not done. Real login support must be inspected and scoped for the selected site, and unsupported login should remain an explicit setup limitation.

## Next required input

Select the restaurant or booking-site URL, date/time/timezone, party size, booking name and budget. These are needed to inspect one genuine booking flow; no random venue or booking parameters will be invented. Exact final confirmation follows preparation, not this setup step.

## Final verification of this batch

- Full workspace `pnpm test`: exit 0, including API 391/391 and web 84/84. This rerun is after the unsuccessful paused-request experiment was removed.
- Full Python `pytest -q`: **55 passed, 1 strict expected failure**, 315.68 seconds. The expected failure is the unresolved final-click terms-change test described above, not a pass.
- Workspace `pnpm typecheck`: exit 0.
- Workspace `pnpm build`: exit 0; existing bundle-size / Flue directive warnings remain.
- `git diff --check`: clean.

The Claude monitoring automation was paused after its delegated batch was reviewed, per the user's switch to Codex-only implementation. No merge, push or live account effects occurred in this batch.
