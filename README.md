# HumanOS

Human-owned, temporary AI agents with deterministic permissions, fresh human approval and revocable ENSv2 authority.

**Status:** the responsive JAW → Proof of Human → ENSv2 chat flow is implemented locally. Live deployment and sponsor qualification still require account setup, provider credentials and Sepolia transactions. Local browser fixtures are tests only; unavailable integrations fail closed.

Source: [saiisback/humanos](https://github.com/saiisback/humanos). Current verification evidence is in [docs/verification.md](docs/verification.md).

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

The task's prepared local `.env` uses an isolated PostgreSQL instance on port 55432; it contains only local service credentials. Do not commit it. See [deployment instructions](docs/deployment.md) for external integration setup and exact resume commands.

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

JAW passkey accounts sign in through backend-verified SIWE. IDKit 4 Proof of Human then binds one human root to that account. The JAW account is the intended owner of a newly registered ENSv2 root; the registrar retains scoped lifecycle roles. Flue 2 is the only agent framework. DeepSeek `deepseek-flash` proposes, Jev `jev-1.13.0` assesses, and TypeScript policy authorizes. A model never grants capabilities or executes protected effects. Fresh action-bound World approval and ENSv2 Permissioned Registry, Resolver and Enhanced Access Control constrain task identities.

See [architecture](docs/architecture.md), [threat model](docs/threat-model.md), [frozen interfaces](docs/interfaces.md), and [plan progress](docs/superpowers/plans/2026-09-24-humanos-mvp.md).
