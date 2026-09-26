# HumanOS native everyday assistant — design proposal

Status: proposal; identity choice awaiting user response. This document does not claim implementation or live provider readiness.

## Intended experience

Build an Expo iOS/Android app on the existing HumanOS backend and Flue runtime. A person signs in through JAW, gives a task in ordinary language, and receives a confirmed outcome from an agent operating within their delegated authority. ENSv2 supplies the agent identity and management layer. Initial task examples are sending email and booking a ticket. The type of ticket/provider must be established before implementing booking.

The user requested native Expo, JAW onboarding, human-backed agents, ENSv2 identities, Flue, subagents, and final browser testing. Retaining World ID for unique-human proof is a recommendation awaiting clarification, not an accepted new requirement.

## Architecture decision

Recommended: native Expo client plus the existing server-side Flue orchestrator, with typed service connectors and the existing deterministic authorization executor. This preserves durable background execution even when the phone closes and reuses the current approval, revocation, idempotency, and receipt infrastructure.

An alternative is a generic browser automation worker controlled by Flue. It covers more websites but introduces brittle checkout, session management, and uncertain recovery. It can be added as an explicitly scoped connector after the first provider-backed flows; it is not the default execution path.

Running the agent primarily on the phone would make background work depend on mobile lifecycle constraints. It is not recommended for tasks that must survive app closure.

## Identity and authority

- JAW supplies native passkey onboarding and a smart account. The backend authenticates account ownership with a fresh, single-use, domain- and chain-bound signature challenge. Stored client account metadata never authenticates an API request.
- Recommended human proof: retain server-verified World ID and bind its existing human root to the authenticated JAW account through a fresh proof. A wallet address alone does not establish unique humanity. Account relinking/recovery must require existing ownership and explicit authorization; no automatic root takeover.
- Each agent has a human root, authenticated owner account binding, ENSv2 identity, task mandate, capabilities, expiry, and revocation state. The agent represents a human; it is not itself described as human.
- Introduce persistent Agent records separately from Missions. Existing mission-specific ENS identities remain valid legacy records; reusable assistants issue narrower per-task mandates. Do not silently reinterpret existing names or permissions.
- JAW account naming and HumanOS ENSv2 agent names are distinct namespaces until their integration is verified. Do not assume a JAW-issued name permits creation of HumanOS subnames.
- Preserve existing ENSv2 registry/controller custody rules until an explicit, tested ownership migration exists. A newly connected JAW account must not silently gain registry administrator rights.
- ENS records hold public identifiers, lifecycle information, and receipt commitments. Email contents, passengers, OAuth credentials, itineraries, and private instructions stay offchain.
- JAW delegated permissions constrain onchain calls. Email and booking permissions are enforced separately by server policy and provider authorization. Neither layer substitutes for the other.

## Native app

Create `apps/mobile` with native screens for onboarding, task conversation, agent management, approvals, activity/receipts, and connected services. Agent details expose purpose, allowed actions, expiry, progress, and revoke controls in plain language.

Use JAW's headless Account integration with native passkey callbacks, an app-associated HTTPS domain, and a custom Expo development build. Persist required account metadata appropriately; protect API refresh credentials with platform secure storage. Backend/provider secrets are never Expo public configuration. Keep native imports separate from web fallback modules.

Use short-lived API access sessions and rotating, revocable refresh credentials, independent of browser cookies. Retain the existing web authentication protections. Opening an approval notification retrieves the current server action; deep links never contain bearer authority or mark an action approved.

## Flue and task execution

Keep Flue as the durable orchestration framework. Expand its current preparation-only tool set with authorized tools for search, drafting, proposing an action, requesting approval, executing a committed action, and checking its result.

Each connector declares its inputs, outputs, capabilities, risk, credential requirements, execution method, idempotency support, and reconciliation method. Mount only tools allowed for the current agent. Recheck authorization at execution time regardless of earlier tool availability.

Assign explicit workflow-step and action identifiers. Current deduplication by mission and action type must not collapse two separately intended emails into one. Determine task completion from its required steps and verified outcomes, replacing the existing calendar-specific completion rule.

Reuse canonical payload hashes, single-use approvals, database locking, ENS lifecycle checks, and durable receipts. Expiry/revocation stops new effects. Ambiguous provider outcomes enter reconciliation; they never trigger blind repeat purchases or sends. If a provider cannot safely reconcile an uncertain result, the task remains unresolved for review.

An agent may complete routine work within its mandate without repeated prompts. Sending, disclosure, and purchase boundaries follow the explicit task permissions. A purchase approval binds the actual passenger, itinerary, provider, currency, total, and expiry; a changed price or itinerary requires renewed authorization.

## First service flows

### Email

Connect an email account with provider OAuth. Store encrypted provider tokens server-side, bind them to the authenticated human root, request only necessary scopes, and support disconnect/revocation. The first vertical supports drafting and sending, with exact recipients, subject, body, and attachments visible before the authorized send. Record the provider message identifier and reconciled status. Reading the mailbox is a separately granted capability.

### Tickets

Start with one selected ticket category and a provider that supports real fulfillment. The flow is requirements → search → compare → select → exact quote → approval → book → verify → return booking reference. Expired offers, changed prices, unavailable inventory, cancellations, and ambiguous checkout are explicit states.

A search result, outgoing booking link, or test fixture is not a completed booking. Live fulfillment requires provider credentials, inventory access, and a supported payment path. Provider selection remains open because the user's example does not distinguish flight, train, or event tickets.

## Delivery boundaries

1. Native app and account linking: JAW onboarding, API session lifecycle, agreed human proof, ENS agent list/detail/revoke, and existing Flue task progress.
2. Connector execution foundation and one complete email vertical.
3. One complete ticket vertical after category/provider selection.

Each slice must be runnable and independently verified. Preserve the existing web demo and its evidence. Do not relabel previous fixture tests as validation of the new native app or live connectors.

## Acceptance evidence

- Backend tests cover account-link replay/ownership attacks, native session refresh/revocation, cross-user connector access, changed action payloads, agent expiry/revocation, and duplicate or ambiguous provider effects.
- Browser tests cover task creation, approvals, progress, failures, reconnection, and receipts through the API, with fixture/live coverage explicitly distinguished.
- Native development-build testing covers passkey creation/import, app restart, deep-link return, secure session restoration, and task continuation after backgrounding. Browser tests cannot certify these native behaviors.
- Live email verification uses an explicitly authorized test recipient. Live booking verification uses provider sandbox fulfillment or a separately authorized purchase. No email or purchase is authorized merely by this design document.
- Completion reporting distinguishes implemented code, passing automated checks, tested native devices/builds, and externally blocked live integrations.

## Primary references checked 2026-09-25

- JAW native integration: https://docs.jaw.id/guides/react-native
- JAW backend account authentication: https://docs.jaw.id/guides/siwe
- JAW permission concepts: https://docs.jaw.id/concepts/permissions

The JAW native documentation confirms the headless Account path, native passkey callbacks, domain association requirement, and custom build requirement. Its browser dialogs and wagmi connector are web-only.
