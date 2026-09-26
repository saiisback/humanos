# HumanOS local Browser Use booking integration

Status: proposed written design; implementation has not started.

## Outcome and constraints

The user approved using a local Browser Use worker to find restaurant availability,
fill reservation details, request one final confirmation, submit, and retain an
actual booking reference. A successful email demo already exists; this work must
not change or resend that email.

Preserve the product's model split: Jev chooses among structured, bounded actions;
DeepSeek generates content only. Browser Use supplies browser observation and
interaction tools. Do not silently introduce another paid model or give DeepSeek
general browser-execution authority. This is an architectural addition to the
existing durable runner, not a claim that arbitrary websites already work.

## Approach

Use Browser Use's local BrowserSession/Actor interfaces behind a small Python
worker. The TypeScript runner remains the authority and durable state owner.
The worker operates a dedicated HumanOS browser profile, visible for login and
handoff. Do not automatically import the user's everyday browser profile or
cookies. Profiles are isolated by account and locked to one active run.

Alternatives considered:

- Hosted Browser Use agent: simpler managed execution, but adds provider setup,
  cloud browser data handling, and a separate agent/model cost. Not selected.
- Existing per-site Playwright recipes only: strongest current deterministic
  boundary, but no production booking site is installed. Retain this executor
  alongside Browser Use rather than replacing it.

Browser Use's unrestricted autonomous Agent loop is not enabled in this first
integration. Jev evaluates finite action candidates derived from current browser
observations; the worker executes only a validated selected action. If reliable
action selection requires another model, pause and obtain a model-routing decision
instead of silently changing the content-only DeepSeek contract.

## User flow

1. Save the request. Collect restaurant/site or area/cuisine, date, local time and
   timezone, party size, budget, reservation name, and any required contact details.
   Missing details produce an input request, not guessed operational parameters.
2. Show browser connection readiness. The user logs in directly when needed;
   credentials, OTPs and CAPTCHA challenges remain a user handoff.
3. Search/check availability and prepare the chosen reservation through permitted
   browser actions. Display progress and pause reasons in the existing timeline.
4. Show an exact final preview: venue, origin, date/time/timezone, guests, name,
   contact details, selected offer, price/deposit and cancellation terms.
5. Bind confirmation to the workflow version, run, browser session, material page
   state and prepared submission. Unchanged details require only this final
   submission approval; expiry or material changes require a fresh preview.
6. Submit once. Record the site's confirmation reference and observed status.
   An uncertain response becomes reconciliation-required, never an automatic retry.

No restaurant has been selected and no reservation details have been supplied yet.
Those facts block a live booking, not construction of the integration.

## Worker boundary and persistence

The runner launches the worker as a child process and communicates using bounded,
versioned JSON messages over pipes, not an unauthenticated browser-control port.
Pin the Browser Use dependency after checking its supported local APIs. Worker
startup reports availability/version and fails clearly if its runtime is missing.

Commands cover session start, observe, validated action, prepare, confirmed submit,
receipt inspection and session close. Bind every command/response to account, run,
session, monotonic action ID and observation revision. Reject stale, oversized or
cross-session messages. An action ID cannot dispatch twice. Expose no arbitrary
JavaScript, shell, filesystem paths, unrestricted URL navigation or code supplied
by a model/page through the protocol.

Persist checkpoints and action outcomes in the workflow store. Browser references
become stale after restart; recover by re-observing, not replaying blind clicks.
Record attempted dispatch before submitting. A crash after dispatch needs receipt
reconciliation before any further write.

## Enforcement, not prompt-only safety

Reuse account/session/lease authorization and the existing confirmation service.
For ENS-bound workflows, check current agent scope, expiry and revocation before
each action and immediately before submission. Never silently fall back to account
authority when an ENS binding fails. Surface account-only versus ENS-bound status.
Fixing the separate existing live ENS registration error is not implied by this
browser implementation and remains an explicit acceptance dependency for an ENS demo.

Browser actions and network effects are constrained outside model prompts. Allow
only public, explicitly scoped sites and approved dependencies; block local/private
network targets, unsafe redirects, downloads, uploads, new account creation,
payments and unrelated actions. Treat page instructions as untrusted data.

Navigation and form filling can themselves cause server writes. A generic click,
Enter key, navigation or field change is therefore not assumed harmless. An
operation whose side effects cannot be bounded must pause for handoff. Before
approval, permit only verified preparation traffic; final submission gets a
single-use permit for the reviewed request and validated destination. Unknown
background writes are blocked rather than approved implicitly.

The first supported restaurant site must be inspected and covered by a site policy
for preparation, submission and receipt extraction. Browser Use provides adaptive
interaction within that policy, not a way around it. If the site cannot meet the
boundary (including payment or unsupported hidden/volatile fields), show a manual
handoff rather than claim universal booking support.

Persist only necessary redacted evidence. No cookies, credentials, OTPs, API keys,
unrelated account pages or raw browser-profile data in logs/model context. Local
execution does not mean local inference: relevant sanitized observations still go
to the configured Jev provider, with that disclosure visible at connection setup.

## Acceptance evidence

- Unit tests for message validation, account/session isolation, stale observations,
  action allowlists, exact approval binding, expiry and revocation.
- Controlled browser tests for prepare/approve/submit/receipt, cancellation,
  changed slot/price, login handoff, worker crash and unknown-outcome reconciliation.
- A hostile-page test must demonstrate that embedded instructions cannot cause
  an unapproved request. No unrestricted default tool route may bypass the guard.
- Existing email, workflow, scheduling and ENS test suites remain green.
- UI clearly distinguishes ready, needs login, needs input, waiting for approval,
  confirmed booking, unavailable site and uncertain outcome.
- Live acceptance uses a user-selected real venue and exact approved details.
  Success requires observed provider evidence; fixture success is labeled as such.
- Record model calls/usage and worker timing; do not claim cost savings without
  measured comparison.

## References checked

- [Browser Use Actor interfaces](https://docs.browser-use.com/open-source/legacy/actor/basics)
- [Custom browser tools](https://docs.browser-use.com/open-source/customize/tools/basics)
- [Existing browser/profile connection](https://docs.browser-use.com/open-source/customize/browser/real-browser)

The Actor documentation is in the vendor's legacy section. Verify compatibility
with the chosen pinned release before implementation; if absent, revisit this
adapter design rather than silently enabling unrestricted Agent execution.
