# ENS-backed durable workflows implementation plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Connect the durable workflow workspace to enforceable ENSv2 agents with owner-visible lifecycle management.

**Architecture:** Add explicit version-bound agent records, separate from legacy missions. Reuse the existing durable ENS writer and authorization reader through a neutral task identity interface. Compose ENS checks with the workflow runner's current ownership/lease/confirmation controls and expose management within the workflow workspace.

**Tech Stack:** TypeScript, Valibot, PostgreSQL, Hono, React, viem, Vitest, Playwright, existing ENSv2 contracts on Sepolia/Anvil.

**Spec:** `docs/superpowers/specs/2026-09-26-workflow-ens-integration-design.md`

## Global constraints

- Default expiry is 24 hours, clipped to live parent/root expiry; no automatic renewal.
- Content-only operations require `drafts.write`; search requires `web.search`.
- Existing workflows remain readable and are not automatically registered or replayed.
- One active agent per approved workflow version; graph/scope changes require a replacement generation.
- Maintain finalized/latest authority intersection, fresh-chain checks, lease/session ownership and exact final confirmations.
- Agent permissions remain scoped to status/receipt resolver records; no registry administration or spending grants.
- Preserve existing legacy mission APIs and their unsupported-workflow rejection.
- Keep private keys and personal payloads off API responses and ENS records.
- No production hotel booking, external email send or live chain broadcast is part of automated verification without separate concrete authorization.
- Preserve dirty JAW files, live-scenario notes, `.claude/` and the unrelated native-design spec.

## Review focus

- Crash after broadcast but before binding activation: reconcile the identical journaled transaction, never register twice (Tasks 2–3).
- Revocation between preparation and dispatch: local deny and live ENS checks prevent the effect (Tasks 3–4).
- Scope edit while an older schedule exists: pin generations and stop stale scheduling rather than silently upgrade authority (Tasks 1, 4).
- RPC interruption versus confirmed revocation: show unavailable/pending without granting authority or falsely reporting final revocation (Tasks 3, 5).
- Mobile back navigation after opening an agent: preserve selected workflow and keyboard focus (Task 5).

## File boundaries and interfaces

Create focused modules rather than putting the whole feature in `runtime.ts` or `main.tsx`.

- `packages/schemas/src/workflow-agents.ts`: validated public binding, registration-review and request/response types; export from `src/index.ts`.
- `packages/database/migrations/0003_workflow_agents.sql`, `src/workflow-agents.ts`: binding lifecycle, compare-and-swap and receipt-publication jobs; export from `src/index.ts`, integrate migrations in existing mechanism.
- `packages/ens/src/workflow-agent.ts`: neutral ENS adapter interface and workflow-specific identifiers; legacy `adapter.ts` delegates shared registration logic without manufacturing a Mission.
- `apps/api/src/workflows/agents.ts`: ownership, registration reviews, lifecycle and recovery worker.
- `apps/api/src/workflows/agent-authorizer.ts`: live version/capability/chain authorization.
- `apps/api/src/workflows/agent-receipts.ts`: independent receipt publication queue, never execution retries.
- `apps/api/src/workflows/agent-routes.ts`: authenticated management routes.
- `apps/web/src/workflows/agent-panel.tsx`: management UI; `main.tsx`, `workspace.tsx`, `app-shell.tsx` handle deep links and panel mounting.

### Task 1: Persist immutable version-bound identities

**Modify:** schema/database exports and migration loader; workflow schemas as needed for optional legacy-compatible `agentBindingId` and `authorityMode: account | ens` pins on runs/schedules.
**Tests:** `packages/schemas/test/workflow-agents.test.ts`, `packages/database/test/workflow-agents.test.ts`.

**Interfaces:** `WorkflowAgentBinding` contains `id, accountId, rootId, workflowId, versionId, graphHash, capabilities, expiresAt, generation, derivationId, chainId:11155111, ensName, node, agentAddress, state, revision, registrationTxHashes, revocationTxHashes, createdAt, updatedAt`. Chain identity fields are nullable only before registration. State enum is exactly `PENDING_REGISTRATION | ACTIVE | REVOKING | REVOKED | FAILED | EXPIRED`.

Produce `WorkflowAgentStore(db)` with `get(id)`, `listOwned(accountId)`, `reserve(input)`, and `transition(id, expectedRevision, nextState, evidence)`; input is the binding's immutable fields, timestamps and initial state, excluding nullable chain evidence and revision. `reserve` returns the persisted binding and reuses an identical pending request; mismatched immutable values conflict. One nonterminal binding per workflow; generation allocation and insertion are transactional under a workflow-scoped lock.

- [ ] Add tests asserting unknown fields/private-key fields are rejected, duplicate reservation returns the same ID, and differing graph/account conflicts. Assert `Promise.all` reservations create one record.
- [ ] Run `pnpm --filter @humanos/schemas test` and `pnpm --filter @humanos/database test`; confirm new cases fail before implementation.
- [ ] Implement schemas/store/migration with typed ownership queries, optimistic revisions and indexes. Persist run/schedule binding pins without mutating historical rows' authority.
- [ ] Rerun both packages; confirm legacy records deserialize and pinned generations cannot be overwritten.
- [ ] Commit only Task 1 files: `feat: persist workflow ENS agent bindings`.

### Task 2: Share the existing ENS lifecycle safely

**Modify:** `packages/ens/src/adapter.ts`, `src/register.ts` only where needed for confirmed evidence; add `src/workflow-agent.ts` and export it.
**Tests:** `packages/ens/test/workflow-agent.test.ts`, existing registration/journal suites.

**Interfaces:** `WorkflowEnsPort` exposes `review({rootId, rootOwner, requestedExpiry}): Promise<{parentName, effectiveExpiry, chainId:11155111}>`, `register({derivationId, rootId, rootOwner, capabilities, expiresAt}): Promise<{ensName,node,agentAddress,txHashes}>`, `readAuthorization(ensName): Promise<AgentAuthorization>`, `revoke(binding): Promise<{txHashes}>`, `writeReceipt(binding, receiptHash): Promise<{txHashes}>`. Here `binding` is `WorkflowAgentBinding`; `receiptHash` is `Hex`. Hashes must come from journal/confirmed receipts, not guessed transaction identifiers.

- [ ] Add tests for domain-separated `workflow:<workflowId>:<generation>` derivation, clipped expiry, only `drafts.write` for content, and correct owner/controller matching. Existing mission derivations must not change.
- [ ] Run `pnpm --filter @humanos/ens test`; confirm new tests fail.
- [ ] Extract neutral registration logic while preserving the legacy `register(mission, owner)` wrapper. Use the existing signed-transaction journal and separate DB pool; never introduce a second signing path.
- [ ] Add local-chain tests: retry after receipt timeout yields identical transaction hash; expired/revoked hierarchy cannot be reactivated; mismatched live owner is rejected.
- [ ] Rerun ENS tests and commit: `feat: expose journaled ENS workflow agent lifecycle`.

### Task 3: Owner-scoped activation and revocation service

**Modify:** `server.ts`, workflow `runtime.ts`, `routes.ts`, `service.ts`; create `agents.ts`, `agent-routes.ts`.
**Tests:** `apps/api/test/workflow-agents.test.ts`, `workflow-agent-routes.test.ts`.

**Interfaces:** `createWorkflowAgentService({db, store, agentStore, ens, clock})` returns `review(actor, workflowId, versionId)`, `enable(actor, workflowId, reviewId, expectedReviewHash)`, `list(actor)`, `detail(actor, workflowId)`, `revoke(actor, bindingId)`, `recover(signal)`. `actor` is existing `WorkflowActor`; review is persisted, account/version/graph/capability/expiry-bound and valid for five minutes. Enable consumes the review once and returns the same binding on an identical retry.

Routes: `GET /workflow-agents`; `GET /workflows/:id/agent`; `POST /workflows/:id/agent/review` with `{versionId}`; `POST /workflows/:id/agent/enable` with `{reviewId, expectedReviewHash}`; `POST /workflow-agents/:id/revoke` with `{}`. Return validated public types and explicit unavailable/pending/conflict responses.

- [ ] Write failing tests for cross-account/root requests, stale review, changed graph, duplicate enable, missing ENS configuration and concurrent revoke/enable. Assert no registration occurs before review consent.
- [ ] Run `pnpm --filter @humanos/api exec vitest run test/workflow-agents.test.ts test/workflow-agent-routes.test.ts` and observe failure.
- [ ] Implement short reservation transactions, external journaled registration, verified activation and recoverable pending states. Inject the existing ENS adapter from `server.ts` rather than constructing independent signer/journal instances.
- [ ] Persist local `REVOKING` and pause schedules before chain revocation. Make retries resume the same intent; RPC failure cannot restore ACTIVE. Verify account-to-root ownership in the database, not only session input.
- [ ] Test crash-after-registration recovery and root-owner changes before activation; run route/service suites and commit: `feat: add owner-controlled workflow agent activation`.

### Task 4: Enforce agents at execution and separate receipt publication

**Modify:** workflow `runtime.ts`, `runner.ts`, `service.ts`, `scheduler.ts`; create `agent-authorizer.ts`, `agent-receipts.ts`.
**Tests:** `apps/api/test/workflow-agent-runtime.test.ts`, `workflow-agent-receipts.test.ts`, existing confirmations/scheduler suites.

**Interfaces:** `createWorkflowAgentAuthorizer({db, agentStore, ens, clock})` returns `(context: StepExecutionContext) => Promise<boolean>`; compose it with existing authorizer for ENS-pinned runs, never substitute for session/lease checks. Receipt publisher exposes `enqueue(bindingId, runId, receiptHash): Promise<void>` and `start(signal): Promise<void>` backed by a unique durable publication job; successful chain evidence is stored separately from provider outcome.

- [ ] Write failing tests: correct binding permits draft/search; wrong version/account/controller, scope narrowing, expired parent, latest-head revocation and RPC failure prevent dispatch. Revoke between preparation and dispatch and assert executor call count is zero.
- [ ] Run new runtime tests and confirm failure.
- [ ] Implement binding pinning at run creation and on schedules. Require live authority before steps and immediately before effects; retain the legacy mission-bound rejection. ENS-required runs never fall back to account mode.
- [ ] Test one unchanged email payload consumes exactly one confirmation and dispatches once; changed payload/expiry still stops. Use controlled transports, not live mail.
- [ ] Implement outbox receipt publication using only hashes. Test failed publication retries without executing the workflow again; assert payload text, email addresses and private material never enter ENS records.
- [ ] Test schedules pause on agent expiry/revocation and do not inherit a new generation. Run API/ENS/database suites and commit: `feat: enforce live ENS authority for workflow runs`.

### Task 5: Workflow-native agent management

**Modify:** web `main.tsx`, `shell/app-shell.tsx`, `workflows/workspace.tsx`, scoped styles; create `workflows/agent-panel.tsx` and `agent-panel.test.tsx`; add `tests/e2e/workflow-agents.spec.ts`.

**Interfaces:** `WorkflowAgentPanel({workflowId: string | null, onClose: () => void, onChanged: () => Promise<void>})` uses Task 3 routes and displays server-verified binding data. `AppShell` accepts an optional `identityPanel` override. Route `?workflow=<id>&identity=1` keeps WorkflowWorkspace mounted; a separate explicit `?legacy=1` path preserves legacy root-verification/mission access and `?mission=` links.

- [ ] Add regression tests asserting Identity & permissions opens agent details without losing workflow ID, back navigation closes the panel, and an account switch discards stale responses. Verify legacy mission links still work.
- [ ] Run `pnpm --filter @humanos/web test`; observe new failures.
- [ ] Implement owner account/root display, staging label, agent name/address/network, scope/version/expiry, custody disclosure and actual transaction references. Never infer ACTIVE from `missionId` or environment configuration.
- [ ] Integrate activation review with the existing run review: show exact scope/expiry, consent once, wait for ACTIVE, then create the run. Existing workflows use explicit Enable ENS agent; failed registration shows recovery, not a Run button that downgrades authority.
- [ ] Add revoke/replace controls and accessible pending/unavailable states. Test 390px/1280px layouts, dialog focus, repeated clicks and failed RPC responses.
- [ ] Run web tests and `pnpm exec playwright test tests/e2e/workflow-agents.spec.ts --workers=1` using the repo's isolated backend fixture configuration; commit: `feat: manage ENS agents inside workflows`.

### Task 6: Integration verification and accurate documentation

**Modify:** README, `docs/verification.md`; create `docs/reports/workflow-ens-integration.md`.

- [ ] Exercise registration → activated binding → real runner → receipt → revocation with local PostgreSQL and Anvil. Test HTTP/API ownership boundaries as well as direct service calls. Clearly label model/provider fixtures.
- [ ] Run `pnpm typecheck`, `pnpm -r --workspace-concurrency=1 test`, `pnpm build`, relevant browser tests and `git diff --check`; record actual output and remaining failures.
- [ ] Obtain an independent code review focused on authorization gaps, registration/revocation races, secret leakage, immutable consent, stale schedules and double-dispatch. Resolve important findings and rerun affected tests.
- [ ] Update documentation to reflect implemented behavior only. Keep booking/email and staging-vs-production caveats; do not erase historical demo findings.
- [ ] If the user authorizes the concrete Sepolia registration, show network, scope, expiry, wallet/operator and gas implications first; then record confirmed transaction/agent evidence and a read-only live workflow run. If not authorized or blocked, mark live Sepolia validation pending rather than passed.
- [ ] Commit scoped implementation/evidence with normal timestamps. Preserve unrelated user changes and report the exact local/remote status.

## Execution handoff

Plan review is required before runtime implementation. Preserve the user's earlier preference for Claude Code implementation with Codex coordination and evidence-based review, subject to current availability and normal permission controls. Independent work may overlap only after shared interfaces are fixed; do not let separate workers edit the same files concurrently. No permission bypass flags, live account actions or secret disclosure are delegated.

Self-review: Tasks 1–5 cover every data/lifecycle/authorization/UI requirement; Task 6 covers verification and migration documentation. Five review-focus failures have explicit owning tests. Existing account-only workflows remain labeled during migration, while new ENS-enabled runs fail closed; this is not automatic conversion of prior approvals.
