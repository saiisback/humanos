# Workflow Usage Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Show durable provider-reported tokens, honest cost estimates and equivalent-token API comparisons below HumanOS results.

**Architecture:** Capture attempts at the model transport boundary, attach server-owned workflow context, persist independently from generated content, and summarize through account-authorized workflow detail. Versioned pricing feeds a compact expandable result footer. Restaurant work is separate and must execute through HumanOS, not manual Codex booking.

**Tech Stack:** TypeScript, PostgreSQL, Valibot, React, Vitest.

**Spec:** `docs/superpowers/specs/2026-09-27-workflow-usage-design.md`

## Global Constraints

- Unknown usage or rates are unavailable, never zero; historical runs are not reconstructed.
- Separate planning per workflow version from execution per run; never duplicate planning on reruns.
- No prompts, credentials, personal details or raw responses in telemetry.
- Compare named API models only; no subscription pricing or measured same-task savings claim.
- Preserve all existing dirty changes and ENS/final-confirmation safeguards.

## Review Focus

- Concurrent workflows cannot exchange usage: Task 2 context-isolation test.
- A provider charges for a response whose content fails validation: Task 1 recovery-attempt test.
- Timeout or process crash creates an unknown charge: Tasks 1–2 incomplete-attempt tests.
- Cached/reasoning token fields overlap totals: Task 3 billing-semantics tests.
- Historical and partially metered runs look falsely free: Tasks 3–4 unavailable/partial tests.

### Task 1: Provider attempt accounting

**Files:** create `packages/models/src/usage.ts`, `packages/models/test/usage.test.ts`; modify `packages/models/src/transport.ts` and `packages/models/src/index.ts`.

**Interfaces:** export `ModelUsageAttempt` (attemptId, requestId, provider, requestedModel, reportedModel, status, nullable input/output/cache counts); add awaited optional `ModelConfig.onAttempt(event: ModelUsageAttempt): Promise<void>`. Emit a started record before dispatch and an update with the same attempt ID afterward. Server constructs model identity from the outbound body, never content text. Existing adapters retain their content return types.

- [ ] Write tests asserting one event pair per HTTP attempt; a 429 followed by success records two attempts; missing usage is null; explicit zero remains zero; invalid/negative/noninteger counts are rejected as unknown; timeout finalizes unknown; invalid-output recovery has separate request IDs.
- [ ] Run `pnpm --filter @humanos/models test` and confirm the new tests fail for absent telemetry behavior.
- [ ] Implement usage normalization for verified Jev and chat-completion wire formats; record before output validation; cap integer values and never retain raw payloads. Test callback failure before dispatch prevents an untracked call and after dispatch never triggers a duplicate provider call.
- [ ] Run models tests and typecheck; stage only this task's owned changes for a normal-date commit.

### Task 2: Durable context and service counts

**Files:** create `packages/database/migrations/0005_workflow_usage.sql`, `packages/database/src/workflow-usage.ts`, `packages/database/test/workflow-usage.test.ts`, `apps/api/src/workflows/usage.ts`, `apps/api/test/workflow-usage.test.ts`; modify database exports, `apps/api/src/workflows/runtime.ts`, `apps/api/src/workflows/service.ts`, and `packages/workflows/src/runtime.ts` only where execution context must be passed.

**Interfaces:** `createWorkflowUsageStore(db)` exposes `upsertAttempt(context, event)` and `listForWorkflow(accountId, workflowId)`. Context contains accountId, workflowId, phase, versionId and nullable runId/stepId. Use a server-side async context or context-bound factories; never mutate a shared ModelConfig. Store operation counts with deterministic run/step/attempt identity for search, email and browser separately from model attempts.

- [ ] Write failing DB/API tests for duplicate updates, concurrent account/workflow isolation, denied cross-account reads, orphan started attempts, distinct planning/execution and reruns without duplicated planning.
- [ ] Run database/API tests to verify red, implement ledger/migration and scoped model callback wiring, then rerun to green. Failed operation counts must not be presented as successful actions.
- [ ] Expose optional usage summary on the existing authorized detail response; preserve old clients and unknown historical data. Verify read paths never invoke providers.
- [ ] Commit only owned changes after tests pass, preserving adjacent uncommitted booking work.

### Task 3: Pricing and comparison

**Files:** create `apps/api/src/workflows/usage-pricing.ts`, `apps/api/test/usage-pricing.test.ts`, `docs/model-pricing-sources.md`; extend shared workflow response types in `packages/schemas/src/workflows.ts`.

**Interfaces:** `estimateUsage(attempts, priceTable): UsageSummary`. Each immutable price entry includes model, provider, currency USD, effective date, source URL and explicit supported token billing rules. Summary has known model subtotal, completeness flag, unknown attempts, per-model tokens, service counts/nullable charges and named equivalent-token comparison estimates.

- [ ] Verify current official OpenCode, OpenAI and Anthropic prices; record exact model IDs and source dates. If no reliable rate exists, retain unavailable. Do not infer direct-provider rates for gateway billing.
- [ ] Write failing pure tests: 1M input at fixture $2 plus 500k output at fixture $8 equals $6; unknown attempt makes total partial; cache discounts cannot double count; unsupported reasoning semantics suppress estimate; historical empty ledger is unavailable.
- [ ] Implement the versioned table and estimator, preserving the applied pricing version with ledger estimates. Compare the same token volume only, label tokenizer/behavior limitations, and keep service charges separate.
- [ ] Run API/schema tests and commit owned pricing changes.

### Task 4: Response footer and integration verification

**Files:** create `apps/web/src/workflows/usage-footer.tsx`, `apps/web/src/workflows/usage-footer.test.tsx`; modify `apps/web/src/workflows/completed-task.tsx`, `apps/web/src/workflows/workflow-review.tsx`, and the existing workspace detail mapping as needed.

**Interface:** `<UsageFooter summary={summary} />` renders beneath result content. Expanded details show models, input/output, attempts/retries, pricing date, known subtotal, unknown charges and separate service counts.

- [ ] Write failing UI tests for actual zero versus unavailable, partial totals, model names, distinct retry counts and the exact comparison label: 'Equivalent-token API estimate, not a measured same-task run'. Never render a subscription or savings-percentage claim.
- [ ] Implement using existing visual styles with accessible disclosure; historical responses show 'Usage unavailable'. Render for pending/failed runs with recorded attempts as well as completed runs.
- [ ] Run `pnpm test`, `pnpm typecheck`, `pnpm build`, and `git diff --check`. Report every failure; do not treat fixture usage as live provider evidence.
- [ ] Inspect an existing historical workflow and one explicitly authorized live draft in HumanOS; verify footer, no additional confirmation changes and no unwanted external action. Record evidence and request final code review before declaring complete.

## Restaurant execution boundary

User accepted the observed ¥2,200/person same-day cancellation policy and requires all execution through HumanOS. Existing request: two adults, 28 September 2026 at 19:00 JST, ¥2,000/person dining budget. This does not yet select a guaranteed-price course or establish availability. Gurunavi requires a separate finite site adapter with email-link handoff and confirmed-receipt handling; do not relabel TableCheck's read-only integration as support. The final HumanOS review must show the chosen venue/offer, exact total/fees and cancellation terms before submission. Reinspect availability and terms at execution time; never invent verification completion or a reservation number.
