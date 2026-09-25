# HumanOS JAW + World chat workspace

**Status:** approved product design; implementation pending

## Intent

Turn the existing HumanOS dashboard into one responsive, chat-first web application for desktop and mobile. JAW supplies passkey-backed smart-account signup and backend authentication. World ID Proof of Human supplies the one-human/one-root trust decision. ENSv2 remains the identity and revocable authority layer for agents. DeepSeek Flash proposes work, Jev assesses it, and deterministic HumanOS policy remains the only authorization decision-maker.

The finished application must let a judge complete one coherent journey without navigating a dashboard: sign in with JAW, establish a PoH-backed root, describe a task, review the proposed authority, create an ENSv2 task agent, observe progress, approve or cancel sensitive actions, and inspect the outcome and receipt in the conversation.

## Scope

This slice includes:

- Responsive web UI for phone and desktop from the existing React/Vite application.
- JAW passkey smart-account connection and SIWE authentication.
- Durable binding between one authenticated JAW account and one verified HumanOS root.
- Existing IDKit 4 Proof of Human flow, presented as a trust gate rather than ordinary login.
- Existing mission, ENSv2 authorization, agent execution, World approval, cancellation, revocation and receipt behavior exposed through a unified chat interface.
- JAW permission visibility and a grant/revoke interface for supported onchain constraints.
- Provider configuration seams for DeepSeek Flash and Jev; secrets remain server-side.
- Automated backend, frontend and browser coverage for new behavior.

This slice does not include a native Expo application, production deployment, invented provider credentials, automatic ENS custody migration, live purchases, or claims that synthetic World/ENS/provider tests qualify for sponsor prizes.

## Product authority model

Each system answers a different question:

| System          | Question it answers                                                                                               |
| --------------- | ----------------------------------------------------------------------------------------------------------------- |
| JAW             | Which passkey-controlled smart account is operating this HumanOS account?                                         |
| World PoH       | Is this account being linked to a unique human eligible for a single HumanOS root?                                |
| ENSv2           | Which agent identity exists, what authority is published for it, and is that authority still active?              |
| JAW permissions | Which onchain calls, spend limits and time window may a delegated signer use?                                     |
| HumanOS policy  | Is this exact proposed action allowed by the mission, human grant, ENS state, risk assessment and fresh approval? |
| DeepSeek/Jev    | What action is proposed, and what advisory risk/alignment assessment applies?                                     |

No client callback, model response, wallet address, ENS record or JAW permission is sufficient by itself to authorize a protected side effect.

## Authentication and root linking

### JAW sign-in

The frontend uses the supported JAW web SDK and passkey experience. Sign-in requests a fresh nonce from the HumanOS backend and asks JAW for a SIWE response. The backend parses and verifies the message, including:

- nonce matches an unconsumed, unexpired server challenge;
- signature is valid for the asserted smart account, including contract-account verification;
- domain and URI exactly match configured HumanOS origin;
- chain is in the configured allowlist;
- issued-at and expiration are valid;
- the challenge is consumed atomically before a session is issued.

The backend stores the normalized account address and chain identity. Web sessions remain same-origin, `HttpOnly`, `Secure` in production and `SameSite=Strict`. Logging out deletes the server session and disconnects the client account presentation.

JAW configuration uses a public application key in Vite configuration only where JAW documents it as client configuration. World, model, ENS signer and application secrets remain server-only. The UI reports JAW as unavailable when its public configuration is absent; it does not fall back to an injected wallet and call that JAW.

### Proof of Human

PoH is not required to open the application or sign in. It is required when the account first attempts to create a human root or authorize an agent namespace. This is the product's trust moment: a scarce human-backed namespace and any associated sponsored allowance are issued once per verified human.

The existing IDKit 4 backend verification remains authoritative. The root challenge is bound to both the browser challenge and authenticated JAW account. On success, one transaction:

1. consumes the World challenge;
2. claims or loads the normalized World nullifier;
3. creates or loads the HumanOS root;
4. binds the root to the authenticated JAW account if neither side is already bound incompatibly;
5. upgrades the current authenticated session to include that root.

An account cannot silently replace its root, and a root cannot silently move to a different account. Relinking is excluded from this slice and fails closed.

If PoH is cancelled, rejected or unavailable, the user keeps their JAW-authenticated session and can explore the interface, but cannot authorize an ENS agent or execute a protected action. The conversation explains the unavailable capability without presenting fixtures as proof.

### Fresh sensitive approval

Root establishment and sensitive approval remain separate events. The existing action-bound World flow stays behind an adapter so it can be replaced by the official World human-in-the-loop package without changing policy or execution interfaces. Until sponsor acceptance is established, the application labels this accurately and makes no World Agents qualification claim.

Every approval binds the stored action ID to the complete canonical action payload, mission, ENS agent, nonce and expiry. The backend verifies and consumes it once inside the existing execution transaction. Cancellation, expiry, rejection or verification failure leaves the side effect unexecuted.

## JAW permission model

JAW permissions apply only to onchain authority. A permission request is derived from a reviewed HumanOS mandate and may include:

- allowed target contracts;
- allowed function selectors;
- per-token spending allowance and period;
- absolute expiry;
- delegated signer identity.

The client displays the exact permission request before invoking JAW. The backend stores the returned permission identifier and normalized reviewed constraints, never just a boolean. Mission execution intersects JAW permission state with approved HumanOS capabilities and current ENS authorization. Revoking either layer denies new effects.

Email, calendar, application and booking rights remain server/provider capabilities. They are not represented as JAW permissions unless an actual onchain call is involved.

For the first implementation, unsupported or unconfigured JAW permission methods display an unavailable state and do not weaken existing policy. A mock permission response is permitted only in explicitly labelled automated tests.

## ENS ownership

The authenticated JAW smart-account address becomes the intended owner recorded for a newly created human root rather than defaulting silently to the server operator. The registrar continues to control registration and lifecycle operations in this slice. Root ownership and ENS management roles remain distinct:

- root address record and token ownership identify the JAW account;
- the registrar retains only the roles needed to create, narrow, renew and revoke HumanOS-managed agents;
- agent accounts retain argument-scoped resolver rights for status and receipt records;
- no JAW connection silently receives registrar-wide authority;
- existing roots and missions are not reinterpreted or migrated automatically.

The implementation must test this owner selection and preserve current fail-closed authorization reads.

## Chat-first experience

### Shared shell

The application uses a restrained warm-white and charcoal visual system derived from the supplied reference. It uses crisp black typography, subtle grey surfaces, thin borders and minimal shadow. There are no gradients, glass effects, decorative dashboards or nested card grids.

The persistent interface contains:

- compact top bar with menu, HumanOS identity/status and account control;
- one vertically scrolling conversation;
- fixed or sticky composer with attachment affordance, model/provider status and send control;
- drawers or sheets for missions, identity, connections and permissions;
- one inline status region for recoverable errors.

### Empty state

After sign-in, the center of the conversation presents the HumanOS mark, a time-sensitive greeting and one sentence explaining the current next step. The composer remains the primary action. If PoH is missing, a contextual verification prompt appears above the composer rather than replacing the application with a separate onboarding page.

### Conversation objects

The transcript renders a small set of semantic message types:

- human message;
- agent response;
- system progress event;
- identity/PoH request;
- mission mandate review;
- ENS identity and permission summary;
- sensitive action review;
- denial or cancellation;
- execution receipt.

Mission and action reviews are readable conversation blocks, not dashboard panels. Advanced details such as hashes, model confidence, EAC grants and audit identifiers expand on demand.

### Approval interaction

A sensitive action block shows the human-readable effect first: recipient or target, contents or calldata summary, amount/currency, relevant constraints and expiry. The user can approve, cancel or inspect the full binding. The protected action cannot execute because the UI optimistically changed state; it executes only after the server confirms verified and consumed authorization.

### Responsive behavior

Phone layout is a single full-height column with safe-area padding, touch targets of at least 44px, a bottom composer and modal sheets for secondary information. It supports widths down to 320px without horizontal scrolling.

Desktop layout keeps the conversation centered at a readable maximum width. A collapsible left mission rail may remain visible at wide widths, while identity and permission detail appears in a right-side inspector only when requested. The primary conversation and composer remain visually dominant.

Keyboard navigation, focus visibility, reduced motion, semantic headings, screen-reader status announcements and contrast are required.

## Frontend structure

The current monolithic `main.tsx` is split at these interfaces:

- `auth/`: JAW connection and SIWE orchestration;
- `identity/`: PoH state and root verification presentation;
- `chat/`: transcript, composer and conversation message renderers;
- `missions/`: mission selection and mandate review;
- `approvals/`: World request, cancellation and action review;
- `permissions/`: JAW permission request and current grant presentation;
- `shell/`: responsive navigation and sheets;
- `lib/api.ts`: typed backend transport only.

JAW and World SDK details remain behind narrow adapters so components consume stable application-level states rather than provider payloads.

## Backend interfaces and persistence

New routes:

- `POST /api/auth/siwe/nonce` creates a short-lived challenge and browser binding.
- `POST /api/auth/siwe/verify` verifies and consumes SIWE, then creates the authenticated session.
- `POST /api/auth/logout` revokes the current session.
- `GET /api/auth/session` returns account, root and integration readiness without secrets.
- `GET /api/jaw/permissions` returns stored reviewed grants for the authenticated account.
- `POST /api/jaw/permissions/record` validates and records a completed JAW grant result where required by the SDK flow.
- `POST /api/jaw/permissions/:id/revoke` records verified revocation after the wallet operation succeeds.

The existing `/api/world/root/*`, mission and action routes require the authenticated account session. Root verification adds the account/root binding transaction described above.

Persistence adds records for SIWE challenges, wallet accounts, root-account bindings and reviewed JAW permission grants. Uniqueness constraints prevent one active incompatible root binding per account/root. Sensitive raw signatures and World proof bytes are not retained after verification.

## Model provider configuration

DeepSeek Flash and Jev stay behind their existing model interfaces. The implementation accepts only documented provider configuration. If the supplied "OpenCode API key" is a gateway credential, its endpoint, authentication format, model identifiers and response compatibility must be documented before adding an adapter. The key must be placed in local or deployment secret storage, never in chat, source control, Vite public variables or test snapshots.

The UI displays provider readiness independently. Missing Jev fails closed for protected execution; missing DeepSeek prevents live proposal generation but does not fabricate a live result.

## Error and recovery behavior

- Missing JAW configuration: show account service unavailable; no injected-wallet fallback.
- SIWE rejection or expiry: preserve unauthenticated UI and permit a fresh attempt.
- World cancellation or unsupported credential: preserve JAW session and exploration access.
- Account/root binding conflict: deny and direct the user to support; never auto-rebind.
- ENS registration failure: keep the reviewed mission without marking it authorized.
- JAW permission rejection: leave onchain authority absent and execution blocked.
- Provider outage: show unavailable and retain durable mission state.
- Ambiguous external effect: preserve `RECONCILIATION_REQUIRED`; do not repeat blindly.
- Session expiry: retain local draft text but require sign-in before submission.

## Test strategy

Backend tests are written first and cover:

- SIWE nonce replay, expiry, wrong origin, wrong chain and invalid signature;
- smart-account signature verification behavior;
- account/root binding uniqueness and concurrent attempts;
- World cancellation and unavailable PoH retaining a JAW session;
- protected routes refusing unauthenticated or unlinked accounts;
- JAW permission constraint validation, expiry and revocation;
- ENS root owner selection from the bound JAW account;
- existing execution denial and idempotency behavior.

Frontend tests cover adapter state transitions and semantic conversation rendering. Playwright covers phone and desktop viewports for:

- JAW sign-in success and rejection;
- PoH success, cancellation and unavailable paths;
- empty chat, message submission and retained draft;
- mandate review and ENS authorization;
- sensitive approval success and cancellation;
- expired/revoked agent denial;
- keyboard navigation, focus, contrast and accessible status output;
- no horizontal overflow at 320px, representative phone and desktop widths.

Live evidence remains separate from fixture evidence. Trial runs with real JAW, World, DeepSeek/Jev and Sepolia configuration are recorded only after those credentials and environments are available.

## Delivery sequence

1. Add SIWE persistence, verification interface and authenticated account sessions.
2. Integrate JAW client connection and complete real SIWE round trip.
3. Bind PoH roots to authenticated JAW accounts and pass the JAW address into new ENS root ownership.
4. Replace the dashboard with the responsive chat shell and conversation renderers.
5. Surface existing mission, authorization, approval, cancellation, revocation and receipt flows in the transcript.
6. Add JAW permission grant/revoke presentation behind a tested adapter.
7. Run complete automated verification, then conduct credentialed trial runs without committing secrets.

## Acceptance criteria

- A new user can create or connect a JAW passkey smart account and establish a verified backend session.
- The session is not authenticated from client account metadata alone.
- A signed-in user can complete PoH and bind exactly one compatible human root.
- A user who cancels or cannot satisfy PoH remains signed in but cannot create an authorized agent.
- A new root records the bound JAW address as its intended ENS owner without granting global registrar rights.
- The entire primary journey is usable through one conversation on phone and desktop.
- Sensitive actions expose exact effects and cannot execute after cancellation, rejection, expiry or revocation.
- Model output cannot expand JAW, ENS or HumanOS authority.
- Missing live integrations are shown as unavailable rather than replaced by hidden fixtures.
- Typecheck, unit/integration tests, contract tests, responsive Playwright tests, lint, build and security scan pass.
