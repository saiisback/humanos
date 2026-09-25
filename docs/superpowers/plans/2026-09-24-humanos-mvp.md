# HumanOS MVP Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build and deploy a functional HumanOS MVP combining Flue, DeepSeek V4.1 Flash, Jev, World ID/World ID for Agents, and ENSv2 into a deterministic human-authorized agent platform.

**Architecture:** DeepSeek proposes typed plans and content, Jev returns typed assessments, and a deterministic TypeScript control plane makes every authorization decision. Flue owns durable agent execution; World establishes/freshly confirms the human; ENSv2 represents portable agent identity, expiry, and scoped permissions.

**Tech Stack:** pnpm, TypeScript, React/Next.js, Flue 2.x, Hono, DeepSeek `deepseek-flash`, Jev System One API, World IDKit, World ID for Agents, viem/wagmi, Solidity/Foundry, PostgreSQL, Valibot, Vitest, Playwright.

**Spec:** `docs/superpowers/specs/2026-09-24-humanos-design.md`

## Global Constraints

- Use `deepseek-flash`; do not use retired `deepseek-v4-flash` except as an explicitly tested fallback alias.
- Use Jev only through a backend adapter; pin the tested model version before threshold calibration.
- Models propose and assess. Deterministic code authorizes and executes.
- Use IDKit Proof of Human for root establishment and official World ID for Agents for fresh sensitive-action approval.
- Use ENSv2 Permissioned Registry, Permissioned Resolver, EAC, hierarchy, expiry, and revocation on Sepolia.
- No qualification-critical mocks, hard-coded success values, exposed secrets, unrestricted production shell, or authorization in the browser.
- Preserve unrelated workspace changes. The workspace is currently empty and not yet a Git repository.

## Review Focus

- A verified approval for payload A must never authorize payload B.
- Revocation or expiry racing with execution must block the side effect.
- Malformed/low-confidence Jev output must fail closed without widening authority.
- Prompt injection inside uploaded documents must not add tools or change the mission.
- Runtime retries must not duplicate external submissions, ENS writes, emails, or calendar events.

## File map

```text
apps/web/                 onboarding, mission UI, approval UI, audit timeline
apps/api/                 Hono API, auth, World verification, action executor
apps/agent/               Flue agents, durable mission orchestration
apps/demo-service/        protected application submission endpoint
packages/schemas/         canonical domain schemas and serialization
packages/policy/          state machine, risk rules, capability intersection
packages/models/          DeepSeek and Jev adapters
packages/world/           IDKit and World ID for Agents server verification
packages/ens/             ENSv2 clients, ABIs, role and lifecycle checks
packages/tools/           policy-gated tools and side-effect adapters
packages/database/        schema, migrations, repositories, transactions
packages/contracts/       Foundry contracts, scripts, and tests
tests/e2e/                Playwright judge journeys
docs/                     architecture, threat model, demo, deployment, debrief
```

## Delegation map

The lead agent owns interfaces, integration, reviews, deployments, and final verification. Delegate only after Task 1 freezes shared schemas.

- Claude Code A: `packages/contracts` and ENS deployment scripts/tests.
- Claude Code B: `apps/web` and Playwright UI flows using frozen API types.
- Claude Code C: `packages/models`, model fixtures, calibration harness, and adversarial evaluation dataset.
- Lead agent: database, policy engine, World verification, Flue runtime, tools, API, integration, and deployment.

No two workers may edit the same package concurrently. Each delegation must return changed files, test output, assumptions, and unresolved risks. The lead reviews diffs before integration.

---

### Task 1: Repository foundation and frozen contracts

**Files:**

- Create: `pnpm-workspace.yaml`, `package.json`, `tsconfig.base.json`, `.env.example`, `.gitignore`
- Create: `packages/schemas/src/domain.ts`, `packages/schemas/src/events.ts`, `packages/schemas/src/canonicalize.ts`
- Test: `packages/schemas/test/canonicalize.test.ts`

**Interfaces:**

- Produces `Mission`, `ActionProposal`, `Approval`, `ExecutionReceipt`, `AuditEvent`, `Capability`, `RiskLevel`, and `MissionState` schemas.
- Produces `canonicalize(value): string` and `hashCanonical(value): Hex`.

- [ ] Initialize Git and the pnpm workspace; pin Node and package-manager versions.
- [ ] Write failing tests proving object key order cannot change a canonical action hash and unsupported values are rejected.
- [ ] Implement schemas, canonical serialization, and SHA-256/Keccak helpers with one documented algorithm per use.
- [ ] Run `pnpm --filter @humanos/schemas test` and `pnpm typecheck`.
- [ ] Commit `chore: initialize humanos monorepo and domain contracts`.

### Task 2: Deterministic state machine and policy engine

**Files:**

- Create: `packages/policy/src/state-machine.ts`, `risk.ts`, `capabilities.ts`, `decision.ts`, `errors.ts`
- Test: `packages/policy/test/state-machine.test.ts`, `risk.test.ts`, `capabilities.test.ts`, `decision.test.ts`

**Interfaces:**

- Consumes domain schemas from Task 1.
- Produces `transition(state, event)`, `classifyStatic(action)`, `effectiveCapabilities(input)`, and `authorize(input): PolicyDecision`.

- [ ] Write exhaustive failing transition-table tests, including every illegal transition.
- [ ] Implement explicit states from draft through completed, rejected, expired, revoked, and failed.
- [ ] Write failing tests for capability intersection across mission allowlist, human approval, ENS roles, lifecycle state, and expiry.
- [ ] Implement fail-closed capability and risk rules; static rules always override model recommendations.
- [ ] Add review-focus tests for payload substitution, expiry, revocation, unknown capability, and malformed assessment.
- [ ] Run `pnpm --filter @humanos/policy test` and commit `feat: add deterministic humanos policy engine`.

### Task 3: Persistence, locking, idempotency, and audit

**Files:**

- Create: `packages/database/src/schema.ts`, `repositories/*.ts`, `transactions/execute-action.ts`
- Create: `packages/database/migrations/0001_initial.sql`
- Test: `packages/database/test/execution-transaction.test.ts`

**Interfaces:**

- Produces repositories for roots, missions, agent identities, actions, approvals, receipts, nullifiers, and audit events.
- Produces `withLockedAction(actionId, callback)` and unique idempotency constraints.

- [ ] Write failing tests for duplicate nullifiers, duplicate action execution, consumed approval reuse, and concurrent execution attempts.
- [ ] Implement Postgres schema and transactional repositories.
- [ ] Ensure audit events record actor, previous state, next state, policy version, model versions, and redacted payload metadata.
- [ ] Run database tests against an ephemeral Postgres instance.
- [ ] Commit `feat: add durable mission persistence and idempotency`.

### Task 4: DeepSeek V4.1 Flash adapter

**Files:**

- Create: `packages/models/src/deepseek/client.ts`, `provider.ts`, `schemas.ts`
- Test: `packages/models/test/deepseek.test.ts`

**Interfaces:**

- Produces `proposeMission(input): MissionProposal` and `proposeNextAction(input): ActionProposalDraft`.
- Uses official DeepSeek OpenAI-compatible API with model `deepseek-flash`.

- [ ] Confirm current official API format and Flue/Pi provider identifier before coding.
- [ ] Write failing contract tests for structured output, timeout, malformed output, and provider failure.
- [ ] Implement one provider adapter with backend-only key, strict schemas, timeouts, retry limits, and model-version logging.
- [ ] Ensure proposals cannot contain capabilities outside the closed schema.
- [ ] Run tests and commit `feat: integrate deepseek flash proposal model`.

### Task 5: Jev decision adapter and calibration harness

**Files:**

- Create: `packages/models/src/jev/client.ts`, `questions.ts`, `policy-map.ts`
- Create: `packages/models/evals/humanos-actions.jsonl`, `scripts/calibrate-jev.ts`
- Test: `packages/models/test/jev.test.ts`, `jev-policy-map.test.ts`

**Interfaces:**

- Produces `evaluateAction(state): JevAssessment` with typed Choice/Noul/Score results.
- Produces deterministic `applyJevThresholds(assessment): AssessmentFlags`.

- [ ] Obtain official TypeSafe access and confirm endpoint/request/response shapes; never invent an SDK package.
- [ ] Write fixtures covering routine, consequential, sensitive, ambiguous, injection, mission drift, and disclosure cases.
- [ ] Write failing tests for malformed results, unknown versions, timeout, low confidence, and unavailable service.
- [ ] Implement the backend adapter, pin the tested Jev model, log state hash/question version/model version, and cache only identical normalized decisions.
- [ ] Calibrate thresholds from the fixture dataset; save measured results and chosen thresholds.
- [ ] Enforce that Jev can escalate or block but never add authority.
- [ ] Run model tests and commit `feat: add jev typed decision layer`.

### Task 6: World IDKit root establishment

**Files:**

- Create: `packages/world/src/idkit/sign-request.ts`, `verify-proof.ts`, `nullifier.ts`
- Create: `apps/api/src/routes/world/idkit-sign.ts`, `idkit-verify.ts`
- Test: `packages/world/test/idkit.test.ts`

**Interfaces:**

- Produces `createSignedProofRequest(action, signal)` and `verifyRootProof(payload)`.

- [ ] Register the event app and record non-secret IDs in typed configuration.
- [ ] Write failing tests for valid proof, invalid proof, wrong environment, signal mismatch, duplicate nullifier, cancellation, and upstream failure.
- [ ] Implement backend RP signing and complete-payload verification following current IDKit 4.x docs.
- [ ] Store nullifiers atomically and create a root only after successful verification.
- [ ] Run tests and commit `feat: establish humanos roots with idkit`.

### Task 7: ENSv2 identity and permissions

**Files:**

- Create: `packages/contracts/src/HumanOSRegistrar.sol`, `script/Deploy.s.sol`
- Create: `packages/contracts/test/HumanOSRegistrar.t.sol`
- Create: `packages/ens/src/register.ts`, `roles.ts`, `resolve.ts`, `authorize.ts`
- Test: `packages/ens/test/authorize.test.ts`

**Interfaces:**

- Produces root/task subname registration, scoped resolver record grants, revocation, expiry queries, and `readAgentAuthorization(name)`.

- [ ] Read deployed ENSv2 Sepolia addresses and current ABIs from official docs; store verified deployment metadata.
- [ ] Write failing Foundry tests for hierarchy, expiry, non-transferability, unauthorized mutation, role escalation, revocation, and renewal restrictions.
- [ ] Implement the smallest registrar/controller necessary to compose official Permissioned Registry, Permissioned Resolver, and EAC primitives.
- [ ] Grant task agents only argument-scoped status/receipt record permissions.
- [ ] Implement viem clients and authorization reads with finality requirements.
- [ ] Run `forge test -vvv` and package tests.
- [ ] Deploy to Sepolia, record addresses/transactions, verify source where supported, and commit `feat: add ensv2 humanos agent identities`.

### Task 8: World ID for Agents sensitive approval

**Files:**

- Create: `packages/world/src/agents/request.ts`, `verify.ts`, `approval-binding.ts`
- Create: `apps/api/src/routes/world/agent-approval.ts`
- Test: `packages/world/test/agent-approval.test.ts`

**Interfaces:**

- Produces `requestFreshApproval(action)` and `verifyAndStoreApproval(result, expectedAction)`.

- [ ] Read event-environment docs and obtain required credentials before implementation.
- [ ] Define canonical approval binding: root ID, ENS agent, mission ID, action type, payload hash, nonce, and expiry.
- [ ] Write failing tests for valid, denied, cancelled, expired, replayed, wrong-agent, and wrong-payload outcomes.
- [ ] Implement secure backend validation and atomic single-use approval storage.
- [ ] Run tests and commit `feat: bind sensitive actions to fresh world approval`.

### Task 9: Flue durable HumanOS runtime

**Files:**

- Create: `apps/agent/src/agents/humanos.ts`, `hooks/use-mission.ts`, `hooks/use-capabilities.ts`, `app.ts`, `flue.config.ts`
- Test: `apps/agent/test/humanos.test.ts`, `recovery.test.ts`

**Interfaces:**

- Consumes model adapters, policy decisions, repositories, and tools.
- Exposes protected durable conversation routes and mission dispatch APIs.

- [ ] Initialize Flue 2.x using current official setup and `deepseek-flash` through a confirmed Pi/custom provider configuration.
- [ ] Write failing tests proving tools change with verified mission state and unauthorized conversations cannot be read or prompted.
- [ ] Implement the agent with schema-valid proposals, Jev assessment, policy authorization, and deterministic tool mounting.
- [ ] Add middleware for user authentication and conversation ownership.
- [ ] Write and pass restart/recovery tests with persisted mission state.
- [ ] Commit `feat: add durable flue humanos runtime`.

### Task 10: Policy-gated tools and protected demo service

**Files:**

- Create: `packages/tools/src/gateway.ts`, `documents.ts`, `application.ts`, `calendar.ts`
- Create: `apps/demo-service/src/app.ts`, `store.ts`
- Test: `packages/tools/test/gateway.test.ts`, `apps/demo-service/test/submission.test.ts`

**Interfaces:**

- Produces idempotent tools for approved document reads, draft persistence, application submission, and calendar creation.

- [ ] Write failing tests proving every tool reauthorizes independently and model-provided parameters cannot bypass constraints.
- [ ] Implement the tool gateway and prompt-injection-safe document treatment.
- [ ] Implement a persistent protected submission endpoint that validates HumanOS authorization and idempotency.
- [ ] Implement a development calendar integration with explicit consequential-action confirmation.
- [ ] Run tests and commit `feat: add policy gated humanos tools`.

### Task 11: Atomic sensitive execution pipeline

**Files:**

- Create: `apps/api/src/services/execute-sensitive-action.ts`
- Test: `apps/api/test/execute-sensitive-action.test.ts`

**Interfaces:**

- Produces `executeSensitiveAction(actionId): ExecutionReceipt`.

- [ ] Write failing race tests for simultaneous execution, approval consumption, revocation during execution, stale ENS reads, and retry after upstream timeout.
- [ ] Implement lock, executed check, digest recomputation, approval validation, fresh ENS authorization, expiry check, atomic approval consumption, idempotent execution, receipt persistence, audit event, and allowed ENS record update in that order.
- [ ] Make ambiguous upstream timeouts reconcile by idempotency key before retrying.
- [ ] Run tests and commit `feat: execute sensitive actions atomically`.

### Task 12: Product UI and judge journeys

**Files:**

- Create: `apps/web/app/**`, `apps/web/components/**`, `apps/web/lib/api.ts`
- Test: `tests/e2e/success.spec.ts`, `denied.spec.ts`, `revoked.spec.ts`, `recovery.spec.ts`

**Interfaces:**

- Consumes typed API/Flue clients and exposes onboarding, mission, timeline, approval, ENS, receipt, expiry, and revoke flows.

- [ ] Build the responsive onboarding and wallet/World verification flow.
- [ ] Build goal entry, mission/capability review, ENS creation, and live agent timeline.
- [ ] Display Jev assessment separately from the deterministic HumanOS policy decision.
- [ ] Build sensitive approval, cancellation, expiry, rejection, receipt, and revocation states.
- [ ] Write Playwright tests for successful, cancelled, revoked, expired, and restart/resume journeys.
- [ ] Run accessibility checks and e2e tests; commit `feat: ship humanos judge experience`.

### Task 13: Deployment, security validation, and submission package

**Files:**

- Create: `docker-compose.yml`, deployment configs, `docs/architecture.md`, `docs/threat-model.md`, `docs/demo-script.md`, `docs/deployment.md`, `docs/integration-debrief.md`
- Modify: `README.md`, `.env.example`

**Interfaces:**

- Produces the public demo, reproducible setup, evidence, and hackathon submission material.

- [ ] Deploy Postgres, API, Flue runtime, demo service, and web application with secrets in platform secret storage.
- [ ] Run dependency, secret, authorization, SSRF, path traversal, replay, and prompt-injection reviews.
- [ ] Run `pnpm format:check`, `pnpm lint`, `pnpm typecheck`, `pnpm test`, `forge test -vvv`, and `pnpm test:e2e`.
- [ ] Execute and screen-record the success, cancellation, expiry, revocation, and runtime-recovery journeys.
- [ ] Verify every public URL, Sepolia transaction, contract address, and repository link.
- [ ] Complete the World integration debrief with measured time-to-first-success, friction, missing capability, and one highest-impact improvement.
- [ ] Remove fake values, dead code, debug routes, exposed data, and unresolved placeholders.
- [ ] Commit `docs: finalize humanos deployment and hackathon submission`.

## Overnight execution order

1. Tasks 1–3 sequentially: shared contracts, policy, persistence.
2. After Task 1 freezes interfaces, delegate Task 7 to Claude Code A, Task 12 shell to Claude Code B, and Task 5 to Claude Code C.
3. Lead completes Tasks 4, 6, and 8 while delegates work.
4. Review delegated diffs and run their isolated test suites.
5. Complete Tasks 9–11 sequentially because they share authorization interfaces.
6. Integrate the UI, run Task 12 e2e journeys, then complete Task 13.
7. Do not deploy until unit, contract, and integration gates pass.

## Final definition of done

- Real IDKit root verification and failure path.
- Real World ID for Agents fresh approval and denied/expired path.
- Real ENSv2 Sepolia hierarchy, expiry, resolver permissions, and revocation.
- DeepSeek V4.1 Flash proposes structured plans through `deepseek-flash`.
- Jev returns logged typed assessments using a pinned tested version.
- Deterministic policy is the sole authority.
- Flue survives restart without losing accepted work.
- Sensitive execution is single-use and idempotent.
- Live public demo, public source, passing tests, deployment evidence, debrief, and judge script.

## Execution progress — 2026-09-24

This ledger is the implementation progress record; the original task lists above are preserved as the plan. Local implementation is distinguished from live qualification. Deployment/provisioning remains incomplete until real evidence exists.

- [x] Task 1: frozen schemas/canonicalization/tooling; 20 tests, commit104f30f.
- [x] Task 2: deterministic policy, exhaustive transitions and fail-closed tests; commitb66783c.
- [x] Task 3: PostgreSQL transactions, action/mission locks, nullifiers, challenges, sessions, approvals, receipts; real database tests, commitb66783c.
- [x] Task 4: strict DeepSeek deepseek-flash adapter and contract tests, commit5af12cb. Live API call awaits key.
- [x] Task 5: pinned Jev1.13 adapter, typed questions,9-case synthetic calibration and adversarial tests, commit5af12cb. Live calibration remains pending.
- [x] Task 6: real IDKit4 UI/signing/verification implementation and replay-safe database flow. Live root proof awaits World app credentials.
- [x] Task 7 local implementation: official ENSv2 contracts, strict authorization, scoped roles, exact retries and durable signed-transaction journal;48 ENS and26 Foundry tests. Commits85fe85f/b29c698/e85caab. Sepolia deployment still awaits parent/funded wallet.
- [x] Task 8: exact payload signal/nonce bound same-human approvals, single-use challenge/approval checks. Official HITL protocol adaptation implemented; live proof and organizer qualification pending.
- [x] Task 9: Flue2 runtime, protected routes, PostgreSQL storage, actual runtime start/stop/restart test with fixture model transport, production boot smoke; commit9e54c09.
- [x] Task 10: signed persistent application/calendar service, per-call policy gateway, approved document/draft library boundaries; tests pass. The current runtime mounts only prepare_next_action; document upload/read UI is not implemented. Calendar is the explicit development integration.
- [x] Task 11: locked execution, single-use approval, current authorization, idempotent effects, timeout reconciliation/audit, idempotent finalized ENS receipt publication wired to the real adapter; commits3b8c62d/9ade436/31f6870.
- [x] Task 12: responsive frontend, real local API/PostgreSQL browser journeys and UI/accessibility fixtures; commits5ab3284/e7b219b. Reconciliation, challenge refresh, receipt retry, and verified cancellation regressions pass;40 browser cases exist with recordings.
- [ ] Task 13 live acceptance: local full verification, independent security review, recordings and deployment documentation are prepared; public full-stack deployment and live sponsor evidence remain blocked. No public demo URL or HumanOS Sepolia deployment is claimed.

Ruling: parallel workers use disjoint owned paths in the requested workspace, overriding the skill's generic sequential-implementation default — user explicitly requests aggressive parallel implementation — incorrect boundaries would risk merge conflicts; final integration/review gates remain required.

Ruling: World fresh approvals retain the registered humanos-root action and use the canonical action binding as the proof signal plus a fresh nonce — official documentation scopes nullifiers by app and action, so different actions cannot establish the same root-human identity — live Proof of Human verification and organizer acceptance remain required; removing the same-human equality is not an acceptable workaround.

Ruling: adapt the official World HITL signing/verification protocol to Flue instead of introducing the Workflow SDK runtime — the specification permits only Flue as the agent framework — organizer prize qualification remains unverified and could require an official framework-neutral integration.

Ruling: use a repository-owned persistent development calendar service — the plan explicitly calls for a development calendar integration — this does not create a third-party calendar event.

Final review through e85caab: no unresolved actionable critical/high finding in reviewed paths. Durable ENS journal commits signed bytes before broadcasting, retains exact nonce/hash through ambiguity and restart, and prevents repeated initial top-ups. A separate ENS database pool avoids nested connection starvation. See docs/verification.md for the final aggregate commands and evidence.

Final local verification:335 unique TypeScript tests,26 Foundry tests and40 recorded browser tests passed. Formatting, lint, typechecking, builds, scans and dependency audit passed. Public source: https://github.com/saiisback/humanos . Full-stack deployment and live sponsor qualification remain blocked as documented.
