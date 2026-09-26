![HumanOS — Delegate the work. Keep the final say.](docs/assets/humanos-banner.png)

# HumanOS

**Delegate the work. Keep the final say.**

HumanOS is a local-first workspace for reusable AI-assisted workflows. A user describes an outcome; server-authored bindings offer typed steps, Jev evaluates those steps, and DeepSeek writes the content. A durable runner records execution, pauses for missing connections or details, and requires an exact final confirmation before supported external effects.

The product aims to make everyday automation accessible without paying for an unconstrained model to reason through every operation. Lower cost is a design objective, **not a measured pricing or savings claim**.

> **Development status:** research, drafts and local schedules have completed real-provider runs. Not every generated answer passes factual/source-quality review. Email delivery and production hotel/restaurant booking are not yet verified end to end. Durable workflows now support explicitly enabled, version-bound ENSv2 agents with live execution authorization. Local test evidence is not proof of a live Sepolia deployment. Do not treat a key or configured badge as proof of live integration.

Source: [saiisback/humanos](https://github.com/saiisback/humanos). Start with the [latest fifteen-demo results](docs/demo-results-2026-09-26.md), [verification record](docs/verification.md), and [live-scenario notes](docs/live-scenarios-2026-09-26.md).

For judges: [Why HumanOS uses ENSv2](docs/ens-judge-guide.md) explains agent naming, permission assignment, off-chain enforcement, the web-only alternative, custody limitations, and a short demo pitch.

## Contents

- [What works today](#what-works-today)
- [How a workflow runs](#how-a-workflow-runs)
- [Run locally](#run-locally)
- [Configuration](#configuration)
- [Identity and permissions](#identity-and-permissions)
- [Real-world actions and approval](#real-world-actions-and-approval)
- [Scheduling](#scheduling)
- [Example tasks](#example-tasks)
- [Verify](#verify)
- [Architecture](#architecture)
- [Troubleshooting](#troubleshooting)

## What works today

| Capability | Implementation | Important limit |
|---|---|---|
| Account sign-in | JAW with backend-verified SIWE sessions | Wallet control is not proof of a unique person |
| Human verification | World ID / IDKit root verification in the identity flow | Staging/simulator verification is not production assurance |
| Workflow planning | Deterministic intent bindings and typed blocks evaluated by Jev | Not an unrestricted planner for arbitrary tasks |
| Content generation | DeepSeek through OpenCode Zen | Generated text needs factual review; no guaranteed savings or accuracy |
| Web research | Account-bound Brave Search adapter with source URLs | Search snippets can be incomplete, stale, or insufficient |
| Email | Resend adapter, exact payload preview, confirmation and dispatch controls | Actual delivery has not been demonstrated by the fifteen-demo batch |
| Browser actions | Optional dedicated local Chromium driver and audited-recipe interface | No production booking recipes ship by default; not control of a user's everyday logged-in browser |
| Durable execution | Persisted graphs, steps, attempts, outputs and receipts | A completed run can still contain an inadequate answer |
| Local scheduling | One-time and daily/weekday schedules with timezone support | Requires the local services and valid authorization to remain available |
| ENSv2 | Workflow agent registration, version-bound permissions, live checks, expiry/revocation and receipt-hash publication | Explicit owner enablement and funded Sepolia configuration required; live workflow-agent validation pending |

The latest test batch produced completed executions for all fifteen saved requests. Several research results were only partial, and earlier source/factual issues remain documented. One-time and recurring scheduling were demonstrated using a draft workflow; the recurring demo was paused afterwards.

## How a workflow runs

```text
User request
    ↓
Save draft → deterministic intent/parameter bindings
    ↓
Jev evaluates offered steps → validate the typed graph
    ↓
Activate version → persist and run steps
    ├─ Research: account-bound Brave adapter
    ├─ Content: DeepSeek, validated output
    ├─ Missing detail/service: pause and explain
    └─ External effect: exact preview → final confirmation → dispatch
    ↓
Persist outputs, attempts and available provider receipts
```

Jev returns structured choices and scores; it does not author arbitrary executable code. DeepSeek supplies content, not capabilities. The server decides which blocks, parameters and connectors are allowed. Graph versions and hashes bind execution to reviewed material.

The UI currently distinguishes **starting/reviewing a workflow** from **confirming a final external action**. Neither a planning approval nor an earlier run authorizes an unknown future email, reservation, or payment. A changed destination, payload, account binding, or expired confirmation can require another review.

## Run locally

Requires Node 22 (22.12 or newer), pnpm 10.12.4 and PostgreSQL 17. Foundry is required for contract tests.

```sh
pnpm install --frozen-lockfile
pnpm --filter @humanos/contracts deps
cp .env.example .env
# Set DATABASE_URL and generate FLUE_INTERNAL_SECRET / DEMO_SERVICE_SECRET.
# Configure the public JAW browser key, backend Sepolia RPC, World and model credentials for live use.
pnpm dev
```

Open http://localhost:5173. The API is on 3001, Flue on 3002, and the protected development application/calendar service on 3003. The development calendar is a durable record in this service, not an external Google Calendar booking.

Set `OPENCODE_API_KEY` in the root `.env` to route the API and Flue through OpenCode Zen: DeepSeek uses `deepseek-v4.1-flash` at `/chat/completions`, and Jev uses `jev-1.13` at `/systemone`. This key takes precedence over the optional direct-provider `DEEPSEEK_API_KEY` and `JEV_API_KEY`. Restart `pnpm dev` after changing environment values. The Connections screen reports configuration, not a successful paid model request.

For ENSv2, register a parent name with a dedicated test wallet at https://app.ens.dev on Ethereum Sepolia. Registration requires Sepolia ETH for gas and test MockUSDC for the registrar fee. Set `HUMANOS_PARENT_LABEL` to the label without `.eth`, and provide the owning wallet's `DEPLOYER_PRIVATE_KEY` locally. Follow [the deployment guide](packages/contracts/README.md) to simulate, deploy, and record HumanOSRegistrar. Set `ENS_REGISTRAR_ADDRESS` to that deployment's address, `ENS_OPERATOR_PRIVATE_KEY` to its owner's key, and `ENS_AGENT_KEY_SEED` to a stable random 32-byte `0x`-prefixed secret. Keep these values in the ignored `.env`; never commit keys. `SEPOLIA_RPC_URL` supplies chain access. ENSv2 uses Ethereum Sepolia, independently of the wallet's other supported chains.

Some development sessions use an isolated PostgreSQL instance on port 55432 rather than 5432. Use the actual port of your database. The root `.env` can contain real provider keys and signing keys: keep it private, ignored by Git, and out of screenshots, issue reports and logs. See [deployment instructions](docs/deployment.md) for additional setup.

## Configuration

Copy `.env.example` and populate only the services you intend to use. Never paste secrets into a workflow prompt. Restart the affected server after changing configuration.

| Variables | Purpose |
|---|---|
| `DATABASE_URL`, `TEST_DATABASE_URL` | Runtime and isolated test PostgreSQL connections |
| `WEB_ORIGIN`, `API_URL` | Frontend origin and API address; origin must match authentication configuration |
| `VITE_JAW_API_KEY` | Public JAW browser application key; allowlist the development origin in JAW |
| `VITE_JAW_APP_LOGO_URL` | Optional public HTTPS logo used by JAW |
| `OPENCODE_API_KEY` | Server-only OpenCode credential for supported model calls |
| `FLUE_URL`, `FLUE_INTERNAL_SECRET` | Flue endpoint and private internal authentication |
| `DEMO_SERVICE_URL`, `DEMO_SERVICE_SECRET` | Protected local demonstration service, not a production booking provider |
| `CONNECTOR_ACCOUNT_ID` | Full authorized HumanOS account ID in `chainId:address` form |
| `BRAVE_SEARCH_API_KEY` | Brave web-search credential bound to that account |
| `RESEND_API_KEY`, `RESEND_FROM_EMAIL` | Resend credential and an authorized sender address |
| `WORLD_APP_ID`, `WORLD_RP_ID`, `WORLD_SIGNING_KEY`, `WORLD_ENVIRONMENT` | World verification configuration; keep signing material server-side |
| `SEPOLIA_RPC_URL`, `ENS_REGISTRAR_ADDRESS` | ENSv2 Sepolia RPC and the deployed HumanOS registrar |
| `ENS_OPERATOR_PRIVATE_KEY`, `ENS_AGENT_KEY_SEED` | Private operator signing and deterministic scoped-agent derivation |
| `ENS_CONFIRMATIONS`, `ENS_AGENT_FUNDING_WEI` | Confirmation policy and optional testnet agent gas funding |
| `DEPLOYER_PRIVATE_KEY`, `HUMANOS_PARENT_LABEL` | Registrar deployment inputs; parent label excludes `.eth` |
| `HUMANOS_BROWSER_DRIVER` | `local-chromium` for audited recipes, or `browser-use` for the local Browser Use worker |
| `HUMANOS_BROWSER_PROFILE_DIR`, `HUMANOS_BROWSER_HEADLESS` | Dedicated automation profile (root of per-account profiles for Browser Use) and visibility setting |
| `HUMANOS_BROWSER_WORKER_PYTHON`, `HUMANOS_BROWSER_CHROMIUM` | Browser Use worker interpreter (`apps/browser-worker/.venv/bin/python` after `uv sync`) and Chromium binary |

### Local Browser Use worker

`apps/browser-worker` is a Python 3.12 worker pinned to `browser-use==0.13.10`. It uses only `BrowserSession` and the actor `Page`/`Element` APIs; the autonomous Agent loop is never used. The API launches it as a child process with a scrubbed environment and talks newline-framed JSON over pipes (there is no network port). Every browser request goes through one fail-closed guard. Jev picks among finite, sanitized options, and DeepSeek stays content-only. A booking is submitted once, only for the exact reviewed details, under a single-use permit. An uncertain outcome becomes reconciliation-required and is never retried.

```bash
cd apps/browser-worker && uv sync && uv run pytest   # controlled local fixture only
```

No production booking site policy is installed. Until one site is inspected and added, Browser Use booking steps pause with setup instructions, and the Connections screen never shows the worker as connected.

`VITE_` values are exposed to the browser; never put private keys there. Direct-provider keys remain in the environment template for other adapter paths, but the durable workflow runtime currently requires OpenCode. No separate Flue account is needed to run its local service.

The Connections screen describes configuration and account binding. A successful search needs real results; a send needs a provider receipt and, where available, delivery evidence. Merely entering a key proves neither.

## Identity and permissions

These layers answer different questions:

| Layer | Responsibility | Does not establish |
|---|---|---|
| JAW / SIWE | Control of an account and authenticated sessions | Human uniqueness, unlimited agent permission |
| World ID | The selected credential's human assurance | Approval of every future action |
| ENSv2 | Names, workflow-agent hierarchy, scoped onchain roles and runtime authorization | Automatic permission to call arbitrary offchain services |
| HumanOS policy | Account ownership, scope, run state and final effect checks | That generated claims are accurate |

The ENSv2 hierarchy is designed as:

```text
<parent>.eth
└── <human-root>.<parent>.eth
    └── <task-agent>.<human-root>.<parent>.eth
```

Each agent has its own Permissioned Resolver. Agent grants are limited to the `humanos.status` and `humanos.receipt` text records; agents do not receive registry transfer, renewal, resolver replacement, or administrative roles. Expiry is bounded by the parent hierarchy. See the [contract guide](packages/contracts/README.md) and [ENS adapter guide](packages/ens/README.md) for exact implementation and test boundaries.

### Enable an ENS workflow agent

1. Select a prepared workflow and open **Identity & permissions** (or **Enable ENS agent** beside the run review). `/?workflow=<id>&identity=1` preserves the workflow instead of switching to legacy missions.
2. Sign in with the account bound to your verified human root. Review the exact workflow version, graph hash, capability scope, Sepolia network and effective expiry. Default lifetime is 24 hours, clipped to the parent hierarchy.
3. Confirm registration once. This can submit several operator-funded Sepolia transactions. The panel shows pending status until finalized/latest chain authorization agrees, then exposes the actual name, controller and observed transaction references.
4. Run the workflow. Each step retains account/session/lease checks and also checks the pinned ENS generation, owner, controller, hierarchy, expiry and capability before dispatch. Registration does **not** approve an email, booking or other external payload; the exact final-action confirmation still applies.
5. Revoke in the same panel. Local permission is denied immediately, schedules pause, and onchain revocation retries independently. Cancelling an incomplete registration may first reconcile its original journaled transaction before revoking; it never enables local execution during cancellation.

Unbound workflows remain explicitly **account-only** until the owner chooses the ENS upgrade; registration is never automatic. Once a binding exists, failure, expiry or revocation cannot silently restore account-only execution. A replacement requires a new review. Runs and schedules keep their original generation; old schedules do not adopt a replacement automatically. Chain unavailability pauses due ENS schedules without falsely marking the agent revoked.

Only opaque execution receipt hashes are published in the agent resolver. Message bodies, email addresses and booking details remain offchain. Publication retries never repeat the external effect. Derived agent signing keys remain in backend custody; resolver roles allow status/receipt records, not registry administration or wallet spending. See [implementation and verification details](docs/reports/workflow-ens-integration.md).

## Real-world actions and approval

### Email

1. Configure Resend with an authorized sender and the correct account binding.
2. Provide exactly one recipient and the intended message, including dates or other necessary details.
3. HumanOS prepares the subject/body and presents the exact recipient, sender binding and content.
4. Confirm that payload before dispatch. The executor rechecks the binding and records the outcome.

The configured sender is not automatically the user's Gmail address. Reply-to support and sender identity must be checked before representing a message as coming from a particular personal mailbox. A provider accepting an email is not proof that it reached the recipient's inbox.

### Hotel or restaurant booking

Booking requires a supported production connector or an audited site recipe. The current recipe registry is empty by default, so a request to “book a hotel” cannot yet complete inside HumanOS. Enabling Chromium alone does not add a booking integration.

A meaningful hotel test needs dates, guests, guest name, budget, location preference, contact details and the exact offer. Final review must show the price, cancellation conditions and any payment obligation. Search results or a drafted inquiry are **not** a reservation. Never report success without a provider confirmation/reference.

### Approval and retry boundaries

- Preparatory research and drafting do not send messages or create reservations.
- Final approval binds to the exact run, step, account, destination and material payload.
- An unchanged approved action should proceed without another prompt inside the same valid authorization window.
- A new run, material change, expired approval or changed service binding is not the same approved action.
- Unknown write outcomes require reconciliation rather than blindly repeating a potentially completed effect.
- Unsupported services pause; the app does not silently fall back to a mock booking or delivery.

## Scheduling

Open a runnable workflow and expand **Schedule this workflow**. Choose a one-time local date/time or a daily time and timezone; recurring schedules can be restricted to weekdays. Pause/resume controls manage future runs.

Schedules persist in PostgreSQL. The local runner and scheduler must be running, the account session must remain valid, and the required services must remain connected. Overlapping runs are skipped. Scheduling a workflow does not preapprove unknown future external effects; those still pause at their confirmation boundary.

## Example tasks

Drafting and research examples:

```text
Draft a concise project update from these notes: login works;
research is being tested; booking integration is pending.
Draft only; do not send anything.

Research Haneda Airport to Shinjuku transport options.
Compare published fares and travel times, cite sources,
and clearly identify details you could not verify.
```

Email preparation example (replace all placeholders before use):

```text
Send an email to <recipient> requesting full-day leave from
<start date> through <end date>. Sign it <your name>.
Reason: <the reason you want included, or omit it>.
```

Do not include multiple email addresses in a natural-language send request until sender/reply-to roles are supported explicitly; current recipient routing requires exactly one distinct address. Review the final content before approving it. More scenarios are listed in the [demo menu](docs/demo-task-menu.md).

## Verify

```sh
pnpm format:check
pnpm lint
pnpm typecheck
pnpm test
pnpm build
TEST_DATABASE_URL=postgresql://humanos:humanos@127.0.0.1:5432/humanos pnpm test:e2e --workers=1
pnpm test:contracts
pnpm calibrate
pnpm scan
pnpm audit
```

Tests use real local PostgreSQL, the ENSv2 contracts on Anvil, and clearly labelled synthetic provider transports. Foundry/Anvil must be installed; the contract script also discovers ~/.foundry/bin. The prepared local database is on port 55432. Set `TEST_DATABASE_URL` explicitly for Playwright; unlike the root unit-test script, Playwright does not load `.env`. `pnpm test:e2e` builds the current production web UI once before starting Playwright, so backend-connected browser tests never consume a missing or stale `apps/web/dist`. The separate `pnpm build` gate checks the entire workspace. The browser suite distinguishes intercepted UI journeys from backend-connected journeys and live readiness. Read [verification evidence](docs/verification.md) for actual command results and limitations.

## Architecture

The repository contains a legacy mission/identity path and the durable workflow workspace. Workflows use their own ENS bindings while reusing the same authorization reader, signer and transaction journal. The integration is locally tested; it is not yet a verified live Sepolia/provider journey.

| Location | Responsibility |
|---|---|
| `apps/web` | Responsive workspace, JAW login, workflow review, output timeline and schedule controls |
| `apps/api` | Authentication, workflow API, execution worker, scheduler, confirmations and connectors |
| `apps/agent` | Local Flue service |
| `apps/demo-service` | Protected local demonstration application/calendar service |
| `packages/workflows` | Typed block catalog, graph assembly, state transitions and retry policy |
| `packages/models` | Jev evaluation and DeepSeek content adapters |
| `packages/database` | Durable storage for runs, attempts, confirmations and receipts |
| `packages/schemas` | Shared validated data contracts |
| `packages/policy` | Authorization and policy logic |
| `packages/ens`, `packages/contracts` | ENSv2 reads/writes, transaction journal and registrar contracts |
| `packages/world` | World credential integration |
| `tests/e2e` | Browser tests, including explicitly controlled test-provider scenarios |

The durable workflow model versions are currently `jev-1.13` and `deepseek-v4.1-flash`, as pinned in `packages/models/src/opencode.ts`. Jev selects/evaluates offered blocks; DeepSeek writes content. TypeScript code owns capabilities and protected dispatch. Flue and the local database are infrastructure, not substitutes for third-party service integrations.

## Troubleshooting

| Symptom | Check |
|---|---|
| JAW does not open or stalls | Public browser key, allowed origin, popup behavior, wallet response and server connectivity; do not repeatedly approve unknown requests |
| A QR code opens installation | Confirm the World environment/app combination; staging/simulator flows differ from production |
| “Configured” but no model response | Provider credit/authentication, timeout, model output validation and backend restart after environment changes |
| Brave/Resend unavailable | Exact `CONNECTOR_ACCOUNT_ID`, corresponding key and authorized sender |
| No ENS agent registered | Open Identity & permissions, select the prepared version and explicitly enable its scoped agent; a configured registrar does not register every workflow |
| Asked for confirmation again | Check whether the run, payload, destination, account binding or five-minute confirmation window changed |
| Booking asks for a connection or details | No production recipe is installed by default; do not treat that stop as a successful booking |
| Schedule does not run | Local service uptime, session validity, timezone, paused state and overlapping executions |
| Run completes but answer is weak | Inspect source excerpts and content; completion records execution, not research completeness |

Report failures with the workflow/run ID, expected behavior and redacted error details. Never include `.env`, cookies, private keys or access tokens. Prefer the smallest reproducible scenario and preserve provider receipts when available.

See [architecture](docs/architecture.md), [threat model](docs/threat-model.md), [frozen interfaces](docs/interfaces.md), and [plan progress](docs/superpowers/plans/2026-09-24-humanos-mvp.md).
