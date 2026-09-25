# HumanOS

Human-owned, temporary AI agents with deterministic permissions, fresh human approval and revocable ENSv2 authority.

**Status:** local MVP implemented and tested; live deployment and sponsor qualification remain blocked by account/credential setup. External credentials are required for real World, DeepSeek, Jev and Sepolia execution. No production qualification or deployment is claimed. Local fixtures are tests only; the application fails closed when an integration is unavailable.

Source: [saiisback/humanos](https://github.com/saiisback/humanos). Final local checks:335 TypeScript tests,26 contract tests and40 browser tests.

## Run locally

Requires Node 22 (22.12 or newer), pnpm 10.12.4 and PostgreSQL 17. Foundry is required for contract tests.

```sh
pnpm install --frozen-lockfile
pnpm --filter @humanos/contracts deps
cp .env.example .env
# Set DATABASE_URL and generate FLUE_INTERNAL_SECRET / DEMO_SERVICE_SECRET.
# Add provider and World credentials to enable real missions.
pnpm dev
```

Open http://localhost:5173. The API is on 3001, Flue on 3002, and the protected development application/calendar service on 3003. The development calendar is a durable record in this service, not an external Google Calendar booking.

The task's prepared local `.env` uses an isolated PostgreSQL instance on port 55432; it contains only local service credentials. Do not commit it. See [deployment instructions](docs/deployment.md) for external integration setup and exact resume commands.

## Verify

```sh
pnpm format:check
pnpm lint
pnpm typecheck
pnpm test
pnpm test:e2e
pnpm build
pnpm test:contracts
pnpm calibrate
pnpm scan
pnpm audit
```

Tests use real local PostgreSQL, the real ENSv2 contracts on Anvil, and synthetic provider transports. Foundry/Anvil must be installed; the contract script also discovers ~/.foundry/bin. The prepared local database is on port55432. Set TEST_DATABASE_URL in `.env` when using a different database; the root `pnpm test` command loads it. The browser suite distinguishes intercepted UI journeys from backend-connected journeys and live readiness. Read [verification evidence](docs/verification.md) for actual command results and limitations.

## Architecture

Flue 2 is the only agent framework. DeepSeek `deepseek-flash` proposes, Jev `jev-1.13.0` assesses, TypeScript policy authorizes. A model never grants capabilities or executes protected effects. IDKit 4 Proof of Human establishes a root; a fresh action-bound proof uses the official World Agents human-in-the-loop wire protocol. ENSv2 Permissioned Registry, Resolver and Enhanced Access Control constrain task identities.

See [architecture](docs/architecture.md), [threat model](docs/threat-model.md), [frozen interfaces](docs/interfaces.md), and [plan progress](docs/superpowers/plans/2026-09-24-humanos-mvp.md).
