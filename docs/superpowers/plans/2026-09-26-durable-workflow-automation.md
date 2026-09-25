# HumanOS Durable Workflow Automation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let a signed-in user turn a natural-language goal into a versioned, durable workflow that Jev assembles from registered blocks, DeepSeek supplies content for, and HumanOS safely executes through connectors or a confirmation-gated browser fallback.

**Architecture:** The existing API remains the authority for sessions, policy, persistence, confirmations, and effects. A new `@humanos/workflows` package owns pure block definitions, graph validation, state transitions, assembly, scheduling calculations, and runtime decisions; `@humanos/models` supplies strict OpenCode-backed Jev and DeepSeek adapters; API services persist and execute runs. Flue remains the user-facing conversational agent and may request operations only through authenticated/internal API boundaries.

**Tech Stack:** TypeScript 5.8, Node 22, pnpm workspaces, Valibot 1.5, Hono 4.13, PostgreSQL, Vitest 4, React, Vite, Playwright, Flue 2.1, OpenCode Zen/SystemOne APIs.

**Spec:** `docs/superpowers/specs/2026-09-26-durable-workflow-automation-design.md`

**Execution ownership:** Claude Code performs approximately 70% of bounded implementation tasks. The primary Codex agent retains the remaining implementation, all architecture/security integration decisions, review of every Claude-produced diff, full-suite verification, and the final main-branch handoff.

## Global Constraints

- JAW/SIWE remains the backend authentication and account-control layer; workflows require an authenticated `accountId`, while `rootId` is nullable until an explicit World ID gate binds it. Current World ID and ENSv2 flows must continue passing unchanged.
- World ID Proof of Human is requested only by an explicit workflow gate that needs uniqueness; ordinary runs and browser fallback do not trigger it.
- Jev model `jev-1.13` may select only candidate IDs and bounded candidate parameters computed by HumanOS.
- DeepSeek model `deepseek-v4.1-flash` may generate content only; it cannot add blocks, authorize effects, invoke tools, or advance state.
- Use `OPENCODE_API_KEY` server-side for both model adapters; never return or log the key.
- Connectors execute before browser fallback; missing connectivity pauses as `CONNECTION_REQUIRED`.
- Browser preparation may navigate/extract/fill, but an irreversible submit requires one server-issued, payload-bound, short-lived, single-use confirmation.
- Activated workflow versions and run input snapshots are immutable.
- Every effect is idempotent or enters reconciliation when its outcome is unknown.
- V1 scheduling is local and durable; recurring runs default to non-overlap with `skip` behavior.
- No arbitrary generated code, arbitrary connector installation, background cookie export, or anti-automation bypass.
- Preserve the user's untracked `docs/superpowers/specs/2026-09-25-humanos-native-design.md` file.

## Review Focus

- Jev returns an unlisted candidate or injects an executable field: reject the response without changing the draft graph (Task 3 model tests and Task 4 assembler tests).
- An irreversible connector call times out after the provider may have accepted it: mark the attempt `RECONCILIATION_REQUIRED`, never retry blindly (Task 5 runner tests).
- A browser field, destination, attachment, value, or material page fingerprint changes after confirmation: invalidate confirmation and refuse submission (Task 7 confirmation tests).
- A recurring local time falls into or appears twice across a daylight-saving transition: create at most one occurrence with the documented timezone behavior (Task 8 scheduler tests).
- A connector account or JAW permission is revoked between step readiness and effect execution: re-check authority immediately before dispatch and pause/revoke without an effect (Tasks 6 and 9 integration tests).

---

## File Structure

### New pure workflow package

- `packages/workflows/package.json` — package scripts and workspace dependencies.
- `packages/workflows/tsconfig.json` — TypeScript project configuration.
- `packages/workflows/src/catalog.ts` — block registry and initial audited block definitions.
- `packages/workflows/src/graph.ts` — graph validation, dependency ordering, input bindings, and graph hashing.
- `packages/workflows/src/assembly.ts` — deterministic candidate computation and Jev-driven graph assembly.
- `packages/workflows/src/state.ts` — run/step transition tables and terminal/pause predicates.
- `packages/workflows/src/runtime.ts` — pure selection of ready steps, retry decisions, and idempotency keys.
- `packages/workflows/src/schedule.ts` — timezone-aware occurrence and overlap calculations.
- `packages/workflows/src/index.ts` — public exports only.
- `packages/workflows/test/*.test.ts` — catalog, graph, assembly, state, runtime, and schedule tests.

### Shared contracts and persistence

- `packages/schemas/src/workflows.ts` — all workflow/version/run/step/attempt/confirmation/schedule schemas.
- `packages/schemas/src/api.ts` — workflow request/response schemas.
- `packages/schemas/src/index.ts` — workflow contract exports.
- `packages/schemas/test/workflows.test.ts` — strict parsing, cross-field invariants, and bounds.
- `packages/database/migrations/0002_workflows.sql` — workflow tables, generated foreign-key columns, unique occurrence/idempotency indexes, and lease indexes.
- `packages/database/src/schema.ts` — workflow table names and schema mapping.
- `packages/database/src/workflows.ts` — transactional workflow store, run claiming, state compare-and-swap, and confirmation consumption.
- `packages/database/src/index.ts` — migration runner and workflow store exports.
- `packages/database/test/workflows.test.ts` — migration, immutability, concurrency, and atomicity tests.

### Model and execution services

- `packages/models/src/opencode.ts` — OpenCode endpoints, model IDs, and server-only configuration.
- `packages/models/src/jev/workflow-selector.ts` — strict candidate-selection client.
- `packages/models/src/deepseek/content.ts` — strict content-only client.
- `packages/models/src/index.ts` — exports for the two new adapters.
- `packages/models/test/workflow-models.test.ts` — wire-format, injection, strictness, timeout, and retry tests.
- `apps/api/src/workflows/service.ts` — create/assemble/activate/read workflow application service.
- `apps/api/src/workflows/runner.ts` — lease-based durable worker and effect dispatch.
- `apps/api/src/workflows/connectors.ts` — connector registry and connector-first routing.
- `apps/api/src/workflows/browser.ts` — browser preparation/submission port and safe URL checks.
- `apps/api/src/workflows/confirmations.ts` — normalized browser payload hashing and confirmation policy.
- `apps/api/src/workflows/scheduler.ts` — local polling scheduler and recovery loop.
- `apps/api/src/workflows/routes.ts` — authenticated workflow/run/schedule endpoints.
- `apps/api/src/workflows/types.ts` — injected service ports used by routes and test fakes.
- `apps/api/test/workflow-*.test.ts` — focused service, runner, connector, browser, scheduler, and route integration tests.
- `apps/api/src/app.ts` — mounts workflow routes and exposes readiness.
- `apps/api/src/server.ts` — builds OpenCode clients and starts/stops the runner/scheduler.
- `.env.example` — documents `OPENCODE_API_KEY` and safe local scheduler/browser settings.

### Flue and web experience

- `apps/agent/src/workflow.ts` — safe internal API calls to assemble, activate, and run workflows.
- `apps/agent/src/agents/humanos.ts` — mounts only workflow tools permitted by current state.
- `apps/agent/src/provider.ts` — points Flue content generation at OpenCode without exposing authority.
- `apps/agent/test/workflow.test.ts` — tool boundary and redaction tests.
- `apps/web/src/workflows/types.ts` — view-state helpers over shared API contracts.
- `apps/web/src/workflows/workflow-review.tsx` — graph/permission/fallback/schedule review card.
- `apps/web/src/workflows/run-timeline.tsx` — durable run and step timeline.
- `apps/web/src/workflows/confirmation-card.tsx` — exact browser submission preview and confirm action.
- `apps/web/src/workflows/schedule-editor.tsx` — one-time/recurring local schedule editor.
- `apps/web/src/workflows/use-workflow.ts` — API loading, mutations, polling, and error recovery.
- `apps/web/src/chat/types.ts` — workflow transcript variants.
- `apps/web/src/chat/mission-flow.ts` — workflow transcript construction.
- `apps/web/src/chat/transcript.tsx` — renders workflow cards/timeline.
- `apps/web/src/shell/app-shell.tsx` — labels mission navigation as durable workflows without changing identity panels.
- `apps/web/src/style.css` — responsive desktop/mobile workflow states.
- `apps/web/lib/api.ts` — method/idempotency-header support.
- `apps/web/src/workflows/*.test.tsx` — review, confirmation, scheduling, and accessibility tests.
- `tests/e2e/workflows.spec.ts` — create/review/run/pause/resume/confirm/cancel/schedule browser journey.
- `tests/e2e/backend-server.ts` — deterministic test adapters and restart controls.

---

### Task 1: Define strict workflow contracts

**Files:**

- Create: `packages/schemas/src/workflows.ts`
- Modify: `packages/schemas/src/api.ts`
- Modify: `packages/schemas/src/index.ts`
- Create: `packages/schemas/test/workflows.test.ts`

**Interfaces:**

- Consumes: existing `IdSchema`, `TimestampSchema`, `JsonValueSchema`, `PayloadSchema`, `CapabilitySchema`, `RiskLevelSchema`.
- Produces: `Workflow`, `WorkflowVersion`, `WorkflowGraph`, `WorkflowNode`, `WorkflowRun`, `StepRun`, `StepAttempt`, `WorkflowEvent`, `RunConfirmation`, `WorkflowSchedule`, `WorkflowAssemblyCandidate`, `WorkflowSelectionInput`, `WorkflowSelection`, `ContentBrief`, `GeneratedContent`, `WorkflowDetailResponse`, `WorkflowRunDetailResponse`, and strict request schemas used by every later task.

- [ ] **Step 1: Write failing schema tests for immutable version snapshots and bounded graphs**

```ts
it("accepts a bounded typed workflow graph and rejects unknown executable fields", () => {
  expect(v.parse(WorkflowGraphSchema, graph).nodes).toHaveLength(2);
  expect(() =>
    v.parse(WorkflowGraphSchema, {
      ...graph,
      nodes: [{ ...graph.nodes[0], shell: "curl attacker" }],
    }),
  ).toThrow();
});

it("requires payload-bound single-use confirmations", () => {
  expect(() =>
    v.parse(RunConfirmationSchema, {
      ...confirmation,
      payloadHash: "changed",
    }),
  ).toThrow();
});
```

- [ ] **Step 2: Run the schema tests and verify the exports do not exist**

Run: `pnpm --filter @humanos/schemas test -- workflows.test.ts`
Expected: FAIL because `WorkflowGraphSchema` and `RunConfirmationSchema` are not exported.

- [ ] **Step 3: Implement the workflow schemas with exact enums and limits**

```ts
export const BlockTypeSchema = v.picklist([
  "research.web",
  "extract.structured",
  "browser.navigate",
  "browser.extract",
  "browser.fill",
  "browser.submit",
  "connector.call",
  "content.generate",
  "content.transform",
  "control.wait",
  "control.branch",
  "control.join",
  "human.connect",
  "human.confirm",
  "human.input",
  "schedule.once",
  "schedule.recurring",
  "application.submit",
  "calendar.create",
]);
export const RunStatusSchema = v.picklist([
  "QUEUED",
  "RUNNING",
  "CONNECTION_REQUIRED",
  "CONFIRMATION_REQUIRED",
  "INPUT_REQUIRED",
  "WAITING",
  "RETRY_SCHEDULED",
  "COMPLETED",
  "FAILED",
  "CANCELLED",
  "REVOKED",
  "RECONCILIATION_REQUIRED",
]);
export const WorkflowNodeSchema = v.strictObject({
  id: IdSchema,
  type: BlockTypeSchema,
  blockVersion: v.pipe(v.string(), v.regex(/^\d+\.\d+\.\d+$/)),
  dependsOn: v.pipe(v.array(IdSchema), v.maxLength(32)),
  input: PayloadSchema,
  capability: v.nullable(CapabilitySchema),
  timeoutMs: v.pipe(
    v.number(),
    v.integer(),
    v.minValue(100),
    v.maxValue(300000),
  ),
  maxAttempts: v.pipe(v.number(), v.integer(), v.minValue(1), v.maxValue(5)),
});
```

Define the remaining records as `v.strictObject`, cap graphs at 64 nodes/128 edges, cap user strings at 10,000 characters, use ISO timestamps, and require 32-byte canonical hashes with the existing `HexSchema`. `WorkflowSchema` requires `accountId` and accepts a nullable `rootId`; only explicit Proof-of-Human nodes require a non-null root.

- [ ] **Step 4: Add workflow API contracts**

```ts
export const CreateWorkflowRequestSchema = v.strictObject({
  goal: v.pipe(v.string(), v.minLength(1), v.maxLength(10000)),
});
export const ActivateWorkflowRequestSchema = v.strictObject({
  versionId: IdSchema,
  expectedGraphHash: HexSchema,
});
export const ConfirmWorkflowStepRequestSchema = v.strictObject({
  confirmationId: IdSchema,
  expectedPayloadHash: HexSchema,
});
```

Add list/detail/run/schedule response schemas, then export `./workflows.js` from `src/index.ts`.

- [ ] **Step 5: Run schema tests and typecheck**

Run: `pnpm --filter @humanos/schemas test -- workflows.test.ts && pnpm --filter @humanos/schemas typecheck`
Expected: PASS.

- [ ] **Step 6: Commit the contracts**

```bash
git add packages/schemas/src/workflows.ts packages/schemas/src/api.ts packages/schemas/src/index.ts packages/schemas/test/workflows.test.ts
git commit -m "feat: define durable workflow contracts"
```

### Task 2: Build the pure workflow kernel

**Files:**

- Create: `packages/workflows/package.json`
- Create: `packages/workflows/tsconfig.json`
- Create: `packages/workflows/src/catalog.ts`
- Create: `packages/workflows/src/graph.ts`
- Create: `packages/workflows/src/state.ts`
- Create: `packages/workflows/src/runtime.ts`
- Create: `packages/workflows/src/index.ts`
- Create: `packages/workflows/test/catalog.test.ts`
- Create: `packages/workflows/test/graph.test.ts`
- Create: `packages/workflows/test/state.test.ts`
- Create: `packages/workflows/test/runtime.test.ts`

**Interfaces:**

- Consumes: Task 1 workflow contracts and existing `hashCanonical`.
- Produces: `BlockRegistry`, `createDefaultCatalog()`, `validateWorkflowGraph(graph, registry)`, `transitionRun`, `transitionStep`, `readySteps`, `retryDecision`, `stepIdempotencyKey`, and structural `WorkflowSelector`/`ContentGenerator` ports based on shared schemas.

- [ ] **Step 1: Write failing catalog and graph tests**

```ts
it("registers every initial block exactly once", () => {
  const catalog = createDefaultCatalog();
  expect(catalog.list().map((b) => b.type)).toEqual(
    expect.arrayContaining([
      "connector.call",
      "browser.submit",
      "content.generate",
      "control.join",
    ]),
  );
  expect(() => catalog.register(catalog.get("connector.call"))).toThrow(
    "DUPLICATE_BLOCK",
  );
});

it.each([
  cyclicGraph,
  missingInputGraph,
  unreachableGraph,
  unconfirmedSubmitGraph,
])("rejects unsafe graph %#", (candidate) => {
  expect(() =>
    validateWorkflowGraph(candidate, createDefaultCatalog()),
  ).toThrow();
});
```

- [ ] **Step 2: Run kernel tests and observe module-not-found failures**

Run: `pnpm --filter @humanos/workflows test`
Expected: FAIL because the new package and functions do not exist.

- [ ] **Step 3: Implement the versioned registry**

```ts
export interface BlockDefinition {
  type: BlockType;
  version: `${number}.${number}.${number}`;
  executor: "local" | "connector" | "browser" | "timer" | "human" | "content";
  effect: "pure" | "read" | "reversible_write" | "irreversible_write";
  input: v.GenericSchema;
  output: v.GenericSchema;
  capability: Capability | null;
  requiresConfirmation: boolean;
}

export class BlockRegistry {
  register(definition: BlockDefinition): void;
  get(type: BlockType): BlockDefinition;
  list(): readonly BlockDefinition[];
}
```

Use strict Valibot schemas per definition and require `browser.submit`, `application.submit`, and effectful `connector.call` operations to declare an approval/confirmation dependency.

- [ ] **Step 4: Implement graph/state/runtime pure functions**

```ts
export function validateWorkflowGraph(
  graph: WorkflowGraph,
  registry: BlockRegistry,
): ValidatedGraph;
export function transitionRun(
  run: WorkflowRun,
  next: RunStatus,
  at: string,
): WorkflowRun;
export function transitionStep(
  step: StepRun,
  next: StepStatus,
  at: string,
): StepRun;
export function readySteps(
  graph: ValidatedGraph,
  steps: readonly StepRun[],
): readonly WorkflowNode[];
export function retryDecision(input: {
  effect: EffectClass;
  error: ErrorClass;
  attempt: number;
  maxAttempts: number;
}): "retry" | "fail" | "reconcile";
export function stepIdempotencyKey(input: {
  versionId: string;
  runId: string;
  nodeId: string;
  occurrenceId: string;
  inputHash: Hex;
}): Hex;
```

Make transition tables explicit constants, use Kahn's algorithm for acyclicity/topological order, and reject duplicate dependencies and unbound `$ref` inputs.

- [ ] **Step 5: Add review-focus tests for unknown outcomes and invalid transitions**

```ts
expect(
  retryDecision({
    effect: "irreversible_write",
    error: "unknown_outcome",
    attempt: 1,
    maxAttempts: 3,
  }),
).toBe("reconcile");
expect(() => transitionRun(completedRun, "RUNNING", now)).toThrow(
  "INVALID_RUN_TRANSITION",
);
expect(stepIdempotencyKey(input)).toBe(stepIdempotencyKey(input));
```

- [ ] **Step 6: Run package and workspace checks**

Run: `pnpm --filter @humanos/workflows test && pnpm --filter @humanos/workflows typecheck && pnpm typecheck`
Expected: PASS.

- [ ] **Step 7: Commit the kernel**

```bash
git add packages/workflows pnpm-lock.yaml pnpm-workspace.yaml
git commit -m "feat: add deterministic workflow kernel"
```

### Task 3: Add OpenCode Jev selection and DeepSeek content adapters

**Files:**

- Create: `packages/models/src/opencode.ts`
- Create: `packages/models/src/jev/workflow-selector.ts`
- Create: `packages/models/src/deepseek/content.ts`
- Modify: `packages/models/src/index.ts`
- Modify: `packages/models/src/transport.ts`
- Modify: `.env.example`
- Create: `packages/models/test/workflow-models.test.ts`

**Interfaces:**

- Consumes: Task 1 `WorkflowAssemblyCandidate`, `WorkflowSelectionInput`, `WorkflowSelection`, `ContentBrief`, and `GeneratedContent` contracts, canonicalization/hash utilities, and the existing bounded `requestJson` transport.
- Produces: `createWorkflowSelector(config).select(input): Promise<WorkflowSelection>` and `createContentGenerator(config).generate(input): Promise<GeneratedContent>`.

- [ ] **Step 1: Write failing wire-contract tests**

```ts
it("rejects a Jev candidate that was not offered", async () => {
  const selector = createWorkflowSelector(
    configReturning({ selectedCandidateId: "shell.exec" }),
  );
  await expect(selector.select(selectionInput)).rejects.toThrow(
    "Model integration unavailable",
  );
});

it("keeps DeepSeek output inside the requested content schema", async () => {
  const generator = createContentGenerator(
    configReturningCompletion({ text: "Draft", capability: "email.send" }),
  );
  await expect(generator.generate(brief)).rejects.toThrow();
});
```

- [ ] **Step 2: Run model tests and verify both constructors are missing**

Run: `pnpm --filter @humanos/models test -- workflow-models.test.ts`
Expected: FAIL on missing exports.

- [ ] **Step 3: Implement pinned OpenCode configuration**

```ts
export const OPENCODE_CHAT_ENDPOINT =
  "https://opencode.ai/zen/v1/chat/completions";
export const OPENCODE_SYSTEMONE_ENDPOINT =
  "https://opencode.ai/zen/v1/systemone";
export const WORKFLOW_JEV_MODEL = "jev-1.13";
export const CONTENT_MODEL = "deepseek-v4.1-flash";
```

Allow endpoint overrides only through explicit constructor options used by tests; reject non-HTTPS production endpoints.

- [ ] **Step 4: Implement strict Jev selection**

```ts
export interface WorkflowSelection {
  selectedCandidateId: string | "complete";
  parameters: Record<string, JsonValue>;
  confidence: number;
  alignment: number;
  risk: number;
  injection: number;
  needsReview: boolean;
  reasonCodes: string[];
}
export interface WorkflowSelector {
  select(input: WorkflowSelectionInput): Promise<WorkflowSelection>;
}
export function createWorkflowSelector(
  config: ModelConfig & { endpoint?: string },
): WorkflowSelector;
```

Construct the SystemOne state from opaque candidate IDs and bounded parameter schemas. Parse with `v.strictObject`, reject a selected ID absent from `input.candidates`, reject parameters that fail the chosen candidate schema, and never include secrets or raw page contents.

- [ ] **Step 5: Implement content-only DeepSeek generation**

```ts
export interface ContentBrief {
  instruction: string;
  context: JsonValue;
  outputSchema: "text" | "email" | "form_fields";
  maxCharacters: number;
}
export interface ContentGenerator {
  generate(input: ContentBrief): Promise<GeneratedContent>;
}
export function createContentGenerator(
  config: ModelConfig & { endpoint?: string },
): ContentGenerator;
```

Send `response_format: { type: "json_object" }`, parse only the schema selected by `outputSchema`, and reject keys such as `steps`, `capabilities`, `tools`, `approved`, or `execute`.

- [ ] **Step 6: Test retry/auth/timeout/log redaction behavior**

Run: `pnpm --filter @humanos/models test && pnpm --filter @humanos/models typecheck`
Expected: PASS, including one retry for 429/5xx, none for 401/403/4xx, and logs containing hashes/model IDs but not prompt text or the API key.

- [ ] **Step 7: Commit the model boundary**

```bash
git add packages/models/src packages/models/test/workflow-models.test.ts .env.example
git commit -m "feat: add constrained OpenCode workflow models"
```

### Task 4: Implement Jev-driven deterministic assembly

**Files:**

- Create: `packages/workflows/src/assembly.ts`
- Create: `packages/workflows/test/assembly.test.ts`
- Modify: `packages/workflows/src/index.ts`

**Interfaces:**

- Consumes: Task 2 `BlockRegistry`/graph validator and Task 3-compatible `WorkflowSelector` port.
- Produces: `computeCandidates(state, registry)` and `assembleWorkflow(input, selector, registry)` returning a validated draft plus decision trace.

- [ ] **Step 1: Write failing assembly tests**

```ts
it("lets Jev choose only from HumanOS-computed blocks", async () => {
  const result = await assembleWorkflow(
    input,
    scriptedSelector([
      "research.web",
      "content.generate",
      "human.confirm",
      "application.submit",
      "complete",
    ]),
    catalog,
  );
  expect(result.graph.nodes.map((node) => node.type)).toEqual([
    "research.web",
    "content.generate",
    "human.confirm",
    "application.submit",
  ]);
});

it("does not mutate the draft when Jev returns an invented candidate", async () => {
  await expect(
    assembleWorkflow(input, scriptedSelector(["shell.exec"]), catalog),
  ).rejects.toThrow("INVALID_SELECTION");
  expect(input.draft.nodes).toEqual([]);
});
```

- [ ] **Step 2: Run the assembly test and verify missing functions**

Run: `pnpm --filter @humanos/workflows test -- assembly.test.ts`
Expected: FAIL.

- [ ] **Step 3: Implement deterministic candidate computation**

```ts
export function computeCandidates(
  state: AssemblyState,
  registry: BlockRegistry,
): readonly AssemblyCandidate[] {
  return registry
    .list()
    .filter((block) => inputsAvailable(block, state.values))
    .filter((block) => capabilitiesAllowed(block, state.allowedCapabilities))
    .filter((block) => transitionAllowed(block, state))
    .map(toOpaqueCandidate)
    .concat(state.graph.nodes.length > 0 ? [completeCandidate] : []);
}
```

Sort candidates deterministically, include no executor implementation details, and make browser fallback an explicit alternative only when the goal requires an unsupported external effect and workflow policy permits it.

- [ ] **Step 4: Implement bounded iterative assembly**

```ts
export async function assembleWorkflow(
  input: AssemblyInput,
  selector: WorkflowSelector,
  registry: BlockRegistry,
): Promise<AssemblyResult>;
```

Clone the input draft, stop at 64 nodes/80 decisions/60 seconds, validate every selection before append, persist decision hashes in the returned trace, stop on `complete`, and run `validateWorkflowGraph` before returning.

- [ ] **Step 5: Exercise low-confidence, review, injection, missing-capability, and budget paths**

Run: `pnpm --filter @humanos/workflows test -- assembly.test.ts && pnpm --filter @humanos/workflows typecheck`
Expected: PASS; unsafe/injected/over-budget selections fail closed without a graph mutation.

- [ ] **Step 6: Commit assembly**

```bash
git add packages/workflows/src/assembly.ts packages/workflows/src/index.ts packages/workflows/test/assembly.test.ts
git commit -m "feat: assemble workflows from typed Jev choices"
```

### Task 5: Add durable PostgreSQL workflow storage

**Files:**

- Create: `packages/database/migrations/0002_workflows.sql`
- Create: `packages/database/src/workflows.ts`
- Modify: `packages/database/src/schema.ts`
- Modify: `packages/database/src/index.ts`
- Create: `packages/database/test/workflows.test.ts`

**Interfaces:**

- Consumes: Task 1 records and Task 2 transition/idempotency concepts.
- Produces: `WorkflowStore` methods for draft/version/run/step/attempt/schedule persistence, lease claims, append-only events, and atomic confirmation consumption.

- [ ] **Step 1: Write failing migration and atomicity tests**

```ts
it("keeps activated workflow versions immutable", async () => {
  await store.insertVersion(activeVersion);
  await expect(
    store.updateVersion({ ...activeVersion, graphHash: otherHash }),
  ).rejects.toThrow("IMMUTABLE_VERSION");
});

it("allows only one worker to claim a queued run", async () => {
  const claims = await Promise.all([
    store.claimRun("a", now),
    store.claimRun("b", now),
  ]);
  expect(claims.filter(Boolean)).toHaveLength(1);
});
```

- [ ] **Step 2: Run database tests and verify the workflow tables are absent**

Run: `pnpm --filter @humanos/database test -- workflows.test.ts`
Expected: FAIL on missing `WorkflowStore`/tables.

- [ ] **Step 3: Create normalized workflow tables and indexes**

```sql
CREATE TABLE IF NOT EXISTS workflows (
  id text PRIMARY KEY,
  account_id text NOT NULL REFERENCES accounts(id),
  root_id text REFERENCES roots(id),
  mission_id text REFERENCES missions(id),
  data jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS workflow_versions (
  id text PRIMARY KEY,
  workflow_id text NOT NULL REFERENCES workflows(id),
  version integer NOT NULL,
  graph_hash text NOT NULL,
  data jsonb NOT NULL,
  UNIQUE(workflow_id, version)
);
CREATE TABLE IF NOT EXISTS workflow_occurrences (
  schedule_id text NOT NULL,
  occurrence_at timestamptz NOT NULL,
  run_id text NOT NULL UNIQUE,
  PRIMARY KEY(schedule_id, occurrence_at)
);
```

Also create run, step, attempt, event, confirmation, and schedule tables with foreign keys; unique step idempotency keys; indexes for due schedules, retry times, pause status, and expired leases.

- [ ] **Step 4: Make the migration runner apply both migrations in lexical order**

```ts
const migrationFiles = ["0001_initial.sql", "0002_workflows.sql"] as const;
for (const file of migrationFiles) {
  const sql = await readFile(
    new URL(`../migrations/${file}`, import.meta.url),
    "utf8",
  );
  await tx.query(sql);
}
```

Keep the existing advisory migration lock.

- [ ] **Step 5: Implement transactional storage operations**

```ts
export interface WorkflowStore {
  createDraft(workflow: Workflow, version: WorkflowVersion): Promise<void>;
  activateVersion(
    workflowId: string,
    versionId: string,
    expectedGraphHash: Hex,
  ): Promise<WorkflowVersion>;
  createRun(run: WorkflowRun, steps: readonly StepRun[]): Promise<void>;
  claimNextRun(
    workerId: string,
    now: Date,
    leaseMs: number,
  ): Promise<WorkflowRun | null>;
  compareAndSwapRun(
    id: string,
    expectedRevision: number,
    next: WorkflowRun,
    event: WorkflowEvent,
  ): Promise<void>;
  recordAttempt(attempt: StepAttempt): Promise<void>;
  consumeConfirmation(
    id: string,
    expectedPayloadHash: Hex,
    now: Date,
  ): Promise<RunConfirmation>;
  createOccurrence(
    scheduleId: string,
    occurrenceAt: string,
    run: WorkflowRun,
  ): Promise<boolean>;
}
```

Use `SELECT ... FOR UPDATE SKIP LOCKED` for claims, revision columns for compare-and-swap, and update/append-event operations in one transaction.

- [ ] **Step 6: Run concurrency, immutability, rollback, and workspace tests**

Run: `pnpm --filter @humanos/database test && pnpm --filter @humanos/database typecheck && pnpm test`
Expected: PASS.

- [ ] **Step 7: Commit persistence**

```bash
git add packages/database
git commit -m "feat: persist versioned workflow runs"
```

### Task 6: Add workflow application service and durable runner

**Files:**

- Create: `apps/api/src/workflows/types.ts`
- Create: `apps/api/src/workflows/service.ts`
- Create: `apps/api/src/workflows/runner.ts`
- Create: `apps/api/test/workflow-service.test.ts`
- Create: `apps/api/test/workflow-runner.test.ts`

**Interfaces:**

- Consumes: Task 3 selector/content clients, Task 4 assembler, Task 5 store, existing mission ownership/policy/receipt services.
- Produces: `WorkflowService` and `WorkflowRunner` used by routes/scheduler.

- [ ] **Step 1: Write failing service tests for draft, activation, and run snapshots**

```ts
it("activates only the graph the user reviewed", async () => {
  await expect(
    service.activate(rootId, workflowId, versionId, wrongHash),
  ).rejects.toThrow("GRAPH_CHANGED");
});

it("pins a run to its workflow version and input hash", async () => {
  const run = await service.runNow(rootId, workflowId, inputs);
  expect(run.workflowVersionId).toBe(activeVersion.id);
  expect(run.inputHash).toBe(hashCanonical(inputs));
});
```

- [ ] **Step 2: Run service tests and verify missing services**

Run: `pnpm --filter @humanos/api test -- workflow-service.test.ts workflow-runner.test.ts`
Expected: FAIL.

- [ ] **Step 3: Implement service ports and draft lifecycle**

```ts
export interface WorkflowActor {
  accountId: string;
  rootId: string | null;
}
export interface WorkflowService {
  createDraft(
    actor: WorkflowActor,
    missionId: string | null,
    goal: string,
  ): Promise<WorkflowDetailResponse>;
  assemble(
    actor: WorkflowActor,
    workflowId: string,
  ): Promise<WorkflowDetailResponse>;
  activate(
    actor: WorkflowActor,
    workflowId: string,
    versionId: string,
    graphHash: Hex,
  ): Promise<WorkflowDetailResponse>;
  runNow(
    actor: WorkflowActor,
    workflowId: string,
    input: Payload,
  ): Promise<WorkflowRunDetailResponse>;
  cancel(
    actor: WorkflowActor,
    runId: string,
  ): Promise<WorkflowRunDetailResponse>;
  resume(
    actor: WorkflowActor,
    runId: string,
  ): Promise<WorkflowRunDetailResponse>;
}
```

Ownership is checked by `accountId` before existence is disclosed. `rootId` is required only when a declared Proof-of-Human gate or root-owned Mission is attached. Assembly writes a new draft version; activation freezes it. Run creation snapshots version/input and creates all step rows atomically.

- [ ] **Step 4: Implement lease-based runner loop**

```ts
export function createWorkflowRunner(deps: RunnerDependencies) {
  return {
    tick(now = new Date()): Promise<boolean>,
    recover(now = new Date()): Promise<number>,
    start(signal: AbortSignal): Promise<void>,
  };
}
```

Each tick claims one run, checks cancellation/revocation, finds ready steps, validates materialized inputs, records an attempt, dispatches through the executor registry, and atomically records output/receipt/state. Heartbeat before half the lease duration.

- [ ] **Step 5: Implement safe retry and reconciliation behavior**

```ts
if (decision === "reconcile") {
  await store.pauseRun(run.id, "RECONCILIATION_REQUIRED", attempt.id);
  return;
}
if (decision === "retry") {
  await store.scheduleRetry(
    step.id,
    nextBackoff(attempt.number, deps.random),
    error.code,
  );
  return;
}
```

Re-check JAW/session/capability authority immediately before dispatch. Content blocks call only `content.generate`. Existing application/calendar execution is wrapped as registered executors and retains current policy checks and receipts.

- [ ] **Step 6: Test crash recovery at every write boundary**

```ts
it.each(["before_attempt", "after_intent", "after_effect", "before_receipt"])(
  "recovers %s without a duplicate effect",
  async (crashPoint) => {
    await runWithInjectedCrash(crashPoint);
    await restartedRunner.recover(later);
    expect(effect.callsFor(idempotencyKey)).toHaveLength(1);
  },
);
```

- [ ] **Step 7: Run runner and existing execution tests**

Run: `pnpm --filter @humanos/api test -- workflow-service.test.ts workflow-runner.test.ts execute-sensitive-action.test.ts approval-retry.test.ts`
Expected: PASS.

- [ ] **Step 8: Commit the service and runner**

```bash
git add apps/api/src/workflows/types.ts apps/api/src/workflows/service.ts apps/api/src/workflows/runner.ts apps/api/test/workflow-service.test.ts apps/api/test/workflow-runner.test.ts
git commit -m "feat: run workflows durably"
```

### Task 7: Implement connector-first routing and connection pauses

**Files:**

- Create: `apps/api/src/workflows/connectors.ts`
- Create: `apps/api/test/workflow-connectors.test.ts`
- Modify: `apps/api/src/workflows/runner.ts`
- Modify: `apps/api/src/workflows/types.ts`

**Interfaces:**

- Consumes: runner executor port and `connector.call` nodes.
- Produces: `ConnectorRegistry`, `ConnectorAdapter`, `routeExternalStep`, and connection-required details safe for the UI.

- [ ] **Step 1: Write failing route-selection tests**

```ts
it("uses a connected deterministic connector before browser fallback", async () => {
  expect(await routeExternalStep(step, context)).toMatchObject({
    kind: "connector",
    connectorId: "calendar",
  });
});

it("pauses without side effects when the required account is disconnected", async () => {
  await runner.tick(now);
  expect(await store.getRun(run.id)).toMatchObject({
    status: "CONNECTION_REQUIRED",
  });
  expect(connector.execute).not.toHaveBeenCalled();
});
```

- [ ] **Step 2: Run connector tests and verify routing is absent**

Run: `pnpm --filter @humanos/api test -- workflow-connectors.test.ts`
Expected: FAIL.

- [ ] **Step 3: Implement connector registry and operation contracts**

```ts
export interface ConnectorAdapter {
  id: string;
  supports(operation: string): boolean;
  connection(accountId: string): Promise<{
    status: "connected" | "missing" | "revoked";
    accountLabel?: string;
  }>;
  execute(input: ConnectorExecutionInput): Promise<ConnectorExecutionResult>;
  reconcile(
    input: ConnectorReconciliationInput,
  ): Promise<ConnectorExecutionResult | null>;
}
```

Reject duplicate IDs/operations, pass idempotency keys where supported, and expose only connector label/scopes—not tokens—in pause metadata.

- [ ] **Step 4: Add pre-dispatch revocation checks and explicit fallback selection**

Re-read connector status and JAW permission after the step is claimed. Return browser fallback only when the workflow version explicitly enables it; never switch modes silently.

- [ ] **Step 5: Run connector, runner, and permission regression tests**

Run: `pnpm --filter @humanos/api test -- workflow-connectors.test.ts workflow-runner.test.ts jaw-permissions.test.ts`
Expected: PASS; revoked accounts and JAW grants create no effect.

- [ ] **Step 6: Commit connector routing**

```bash
git add apps/api/src/workflows/connectors.ts apps/api/src/workflows/runner.ts apps/api/src/workflows/types.ts apps/api/test/workflow-connectors.test.ts
git commit -m "feat: route workflow effects through connectors"
```

### Task 8: Add browser fallback and exact final confirmation

**Files:**

- Create: `apps/api/src/workflows/browser.ts`
- Create: `apps/api/src/workflows/confirmations.ts`
- Create: `apps/api/test/workflow-browser.test.ts`
- Create: `apps/api/test/workflow-confirmations.test.ts`
- Modify: `apps/api/src/workflows/runner.ts`

**Interfaces:**

- Consumes: Task 5 confirmation store and Task 7 fallback route.
- Produces: `BrowserExecutor` port, `normalizeSubmission`, `submissionPayloadHash`, `prepareConfirmation`, and `consumeAndSubmit`.

- [ ] **Step 1: Write failing confirmation-binding tests**

```ts
it.each(["destination", "fields", "attachments", "value", "pageFingerprint"])(
  "rejects submission when %s changes after confirmation",
  async (field) => {
    const changed = changeMaterialField(preparedSubmission, field);
    await expect(
      confirmations.consumeAndSubmit(confirmation.id, changed, now),
    ).rejects.toThrow("CONFIRMATION_MISMATCH");
    expect(browser.submit).not.toHaveBeenCalled();
  },
);

it("consumes a matching confirmation exactly once", async () => {
  await confirmations.consumeAndSubmit(
    confirmation.id,
    preparedSubmission,
    now,
  );
  await expect(
    confirmations.consumeAndSubmit(confirmation.id, preparedSubmission, now),
  ).rejects.toThrow("CONFIRMATION_NOT_CONSUMABLE");
});
```

- [ ] **Step 2: Run browser/confirmation tests and verify missing ports**

Run: `pnpm --filter @humanos/api test -- workflow-browser.test.ts workflow-confirmations.test.ts`
Expected: FAIL.

- [ ] **Step 3: Implement normalized submission and safe URL policy**

```ts
export interface BrowserSubmission {
  destination: string;
  fields: Record<string, string>;
  attachments: Array<{ name: string; contentHash: Hex }>;
  value: { amount: string; currency: string } | null;
  pageFingerprint: Hex;
}
export function submissionPayloadHash(
  versionId: string,
  runId: string,
  nodeId: string,
  submission: BrowserSubmission,
): Hex;
```

Normalize URL scheme/host/path, sort fields/attachments, normalize Unicode/newlines, and reject localhost, private/link-local ranges, credentials in URLs, non-HTTP(S) schemes, and redirects to disallowed origins.

- [ ] **Step 4: Implement preparation and final submission boundary**

```ts
export interface BrowserExecutor {
  prepare(input: BrowserPreparationInput): Promise<BrowserSubmission>;
  submit(input: BrowserSubmitInput): Promise<BrowserReceipt>;
}
```

The runner may call `prepare` for navigate/extract/fill, persist the preview/hash, then pause `CONFIRMATION_REQUIRED`. Only the server's atomic confirmation consumption may invoke `submit`.

- [ ] **Step 5: Test expiry, actor/run/step binding, replay, redirects, and prompt injection**

Run: `pnpm --filter @humanos/api test -- workflow-browser.test.ts workflow-confirmations.test.ts workflow-runner.test.ts`
Expected: PASS; page text cannot alter workflow graph, destination policy, or confirmation scope.

- [ ] **Step 6: Commit browser fallback**

```bash
git add apps/api/src/workflows/browser.ts apps/api/src/workflows/confirmations.ts apps/api/src/workflows/runner.ts apps/api/test/workflow-browser.test.ts apps/api/test/workflow-confirmations.test.ts
git commit -m "feat: gate browser submissions by exact confirmation"
```

### Task 9: Add durable local scheduling and recovery

**Files:**

- Create: `packages/workflows/src/schedule.ts`
- Create: `packages/workflows/test/schedule.test.ts`
- Modify: `packages/workflows/src/index.ts`
- Create: `apps/api/src/workflows/scheduler.ts`
- Create: `apps/api/test/workflow-scheduler.test.ts`

**Interfaces:**

- Consumes: Task 5 schedules/occurrences and Task 6 run creation/recovery.
- Produces: `nextOccurrence`, `createWorkflowScheduler`, and startup recovery.

- [ ] **Step 1: Write failing timezone and overlap tests**

```ts
it("creates at most one occurrence across a repeated DST local time", () => {
  const occurrences = enumerateOccurrences(fallBackSchedule, window);
  expect(new Set(occurrences.map((item) => item.logicalId)).size).toBe(
    occurrences.length,
  );
});

it("records an overlap as skipped instead of launching another run", async () => {
  await scheduler.tick(now);
  expect(await store.getOccurrence(schedule.id, logicalTime)).toMatchObject({
    status: "SKIPPED_OVERLAP",
  });
});
```

- [ ] **Step 2: Run schedule tests and verify schedule calculation is missing**

Run: `pnpm --filter @humanos/workflows test -- schedule.test.ts && pnpm --filter @humanos/api test -- workflow-scheduler.test.ts`
Expected: FAIL.

- [ ] **Step 3: Implement timezone-aware occurrence calculation**

```ts
export function nextOccurrence(
  schedule: WorkflowSchedule,
  after: Date,
): {
  at: string;
  logicalId: string;
} | null;
```

Use the platform `Intl.DateTimeFormat` timezone database, store the named timezone and local schedule components, choose the first valid instant for ambiguous times, and advance to the next valid local time for nonexistent times. Include UTC instant in `logicalId`.

- [ ] **Step 4: Implement local scheduler and startup recovery**

```ts
export function createWorkflowScheduler(deps: SchedulerDependencies) {
  return {
    tick(now?: Date): Promise<number>;
    recover(now?: Date): Promise<{ leases: number; retries: number; schedules: number }>;
    start(signal: AbortSignal): Promise<void>;
  };
}
```

Atomically insert occurrence plus run, skip overlap by default, pin the schedule's workflow version, recover expired leases/retries on startup, and leave human pauses untouched.

- [ ] **Step 5: Run missed-tick, duplicate-scan, restart, DST, and cancellation tests**

Run: `pnpm --filter @humanos/workflows test -- schedule.test.ts && pnpm --filter @humanos/api test -- workflow-scheduler.test.ts`
Expected: PASS.

- [ ] **Step 6: Commit scheduling**

```bash
git add packages/workflows/src/schedule.ts packages/workflows/src/index.ts packages/workflows/test/schedule.test.ts apps/api/src/workflows/scheduler.ts apps/api/test/workflow-scheduler.test.ts
git commit -m "feat: schedule durable local workflow runs"
```

### Task 10: Expose authenticated workflow APIs and wire the process

**Files:**

- Create: `apps/api/src/workflows/routes.ts`
- Create: `apps/api/test/workflow-routes.test.ts`
- Modify: `apps/api/src/app.ts`
- Modify: `apps/api/src/server.ts`
- Modify: `.env.example`

**Interfaces:**

- Consumes: Tasks 3, 5–9 services.
- Produces: authenticated `/api/workflows`, `/api/workflow-runs`, and `/api/workflow-schedules` endpoints and a live local worker/scheduler lifecycle.

- [ ] **Step 1: Write failing route authorization/idempotency tests**

```ts
it("does not reveal another account's workflow", async () => {
  expect(
    (await clientAs(otherAccount).get(`/api/workflows/${workflow.id}`)).status,
  ).toBe(404);
});

it("re-checks JAW authority immediately before a protected effect", async () => {
  await permissions.revoke(grant.id);
  await runner.tick(now);
  expect(effect).not.toHaveBeenCalled();
  expect((await store.getRun(run.id))?.status).toBe("REVOKED");
});
```

- [ ] **Step 2: Run route tests and verify 404/missing routes**

Run: `pnpm --filter @humanos/api test -- workflow-routes.test.ts`
Expected: FAIL because workflow routes are not mounted.

- [ ] **Step 3: Implement the authenticated route module**

```ts
export function createWorkflowRoutes(
  deps: WorkflowRouteDependencies,
): Hono<Env>;
```

Routes: create/list/read drafts, assemble, activate, run, read run, cancel, resume, create/update/pause schedule, list connection requirements, create confirmation preview, and consume confirmation. Parse every body with Task 1 schemas, require an authenticated JAW/SIWE account session, check account ownership, and require an `Idempotency-Key` header for effectful POSTs. Refactor the existing session helpers into `accountSession` and `worldBoundSession`; workflow routes use the first by default and explicit World/Mission gates use the second.

- [ ] **Step 4: Mount services without enlarging `createApi` responsibility**

Add a `workflows?: WorkflowRouteDependencies` field to `ApiConfig` and `app.route("/api", createWorkflowRoutes(config.workflows))` only when configured. Add workflow readiness entries separately for OpenCode, worker, scheduler, connectors, and browser executor.

- [ ] **Step 5: Wire OpenCode and background lifecycle in the server**

```ts
const openCodeKey = process.env.OPENCODE_API_KEY;
if (openCodeKey) {
  selector = createWorkflowSelector({ apiKey: openCodeKey });
  content = createContentGenerator({ apiKey: openCodeKey });
}
const controller = new AbortController();
void runner.start(controller.signal);
void scheduler.start(controller.signal);
for (const signal of ["SIGINT", "SIGTERM"] as const)
  process.once(signal, () => controller.abort());
```

Do not fall back to client-supplied keys. Keep the current mission model configuration working during migration; mark separate legacy keys as deprecated in `.env.example`.

- [ ] **Step 6: Run API security and regression tests**

Run: `pnpm --filter @humanos/api test && pnpm --filter @humanos/api typecheck`
Expected: PASS, including origin, ownership, root binding, permission revocation, malformed body, and confirmation replay cases.

- [ ] **Step 7: Commit the API surface**

```bash
git add apps/api/src/workflows/routes.ts apps/api/src/app.ts apps/api/src/server.ts apps/api/test/workflow-routes.test.ts .env.example
git commit -m "feat: expose authenticated workflow automation APIs"
```

### Task 11: Integrate Flue without moving authority into the model

**Files:**

- Create: `apps/agent/src/workflow.ts`
- Create: `apps/agent/test/workflow.test.ts`
- Modify: `apps/agent/src/agents/humanos.ts`
- Modify: `apps/agent/src/provider.ts`
- Modify: `apps/agent/src/config.ts`

**Interfaces:**

- Consumes: Task 10 authenticated/internal workflow endpoints.
- Produces: Flue tools that request draft assembly/run state and never accept proof, authority, connector secrets, or arbitrary execution parameters.

- [ ] **Step 1: Write failing agent-boundary tests**

```ts
it("sends only the bound workflow ID to internal operations", async () => {
  await requestAssembly("wf_1", config, transport);
  expect(JSON.parse(String(lastRequest.body))).toEqual({});
  expect(String(lastRequest.headers.authorization)).toBe(
    "Bearer internal-test",
  );
});

it("never returns credentials or raw provider payloads to chat", async () => {
  expect(await readRunSummary("run_1", config, transport)).toEqual({
    runId: "run_1",
    status: "CONFIRMATION_REQUIRED",
    nextAction: "Review in HumanOS",
  });
});
```

- [ ] **Step 2: Run agent tests and verify workflow helpers are missing**

Run: `pnpm --filter @humanos/agent test -- workflow.test.ts`
Expected: FAIL.

- [ ] **Step 3: Add bounded internal workflow helpers**

```ts
export function requestAssembly(
  id: string,
  config: AgentConfig,
  transport?: typeof fetch,
): Promise<WorkflowSummary>;
export function requestRun(
  id: string,
  config: AgentConfig,
  transport?: typeof fetch,
): Promise<RunSummary>;
export function readRunSummary(
  id: string,
  config: AgentConfig,
  transport?: typeof fetch,
): Promise<RunSummary>;
```

Validate IDs, require `FLUE_INTERNAL_SECRET`, use 60-second timeouts, follow no redirects, and return only safe summaries.

- [ ] **Step 4: Mount state-dependent Flue tools**

Expose `assemble_workflow` for drafts and `run_workflow` for active versions. Never mount confirmation, connector-secret, browser-submit, permission-change, or arbitrary URL tools. Update the agent prompt to state that Jev chooses registered blocks and DeepSeek content is non-authoritative.

- [ ] **Step 5: Point the Flue content provider to OpenCode**

Resolve `OPENCODE_API_KEY`, use `https://opencode.ai/zen/v1` as the OpenAI-compatible base URL and `deepseek-v4.1-flash` as the model ID. Keep browser-only code from importing the provider.

- [ ] **Step 6: Run agent security and type checks**

Run: `pnpm --filter @humanos/agent test && pnpm --filter @humanos/agent typecheck`
Expected: PASS.

- [ ] **Step 7: Commit Flue integration**

```bash
git add apps/agent/src/workflow.ts apps/agent/src/agents/humanos.ts apps/agent/src/provider.ts apps/agent/src/config.ts apps/agent/test/workflow.test.ts
git commit -m "feat: connect Flue to durable workflows"
```

### Task 12: Build the workflow review and live-run interface

**Files:**

- Create: `apps/web/src/workflows/types.ts`
- Create: `apps/web/src/workflows/use-workflow.ts`
- Create: `apps/web/src/workflows/workflow-review.tsx`
- Create: `apps/web/src/workflows/run-timeline.tsx`
- Create: `apps/web/src/workflows/confirmation-card.tsx`
- Create: `apps/web/src/workflows/schedule-editor.tsx`
- Create: `apps/web/src/workflows/workflow-review.test.tsx`
- Create: `apps/web/src/workflows/confirmation-card.test.tsx`
- Create: `apps/web/src/workflows/run-timeline.test.tsx`
- Modify: `apps/web/lib/api.ts`
- Modify: `apps/web/src/chat/types.ts`
- Modify: `apps/web/src/chat/mission-flow.ts`
- Modify: `apps/web/src/chat/transcript.tsx`
- Modify: `apps/web/src/shell/app-shell.tsx`
- Modify: `apps/web/src/style.css`

**Interfaces:**

- Consumes: Task 10 endpoints and Task 1 response contracts.
- Produces: review/activate/run/schedule UI and exact final-confirmation experience on desktop and mobile.

- [ ] **Step 1: Write failing component tests for the review and final confirmation states**

```tsx
it("shows steps, connectors, fallback, permissions, and schedule before activation", () => {
  render(<WorkflowReview detail={detail} onActivate={activate} />);
  expect(screen.getByText("4 steps")).toBeVisible();
  expect(screen.getByText("Browser fallback: allowed")).toBeVisible();
  expect(
    screen.getByRole("button", { name: "Activate workflow" }),
  ).toBeEnabled();
});

it("renders the exact destination and payload hash before the only final confirmation", () => {
  render(<ConfirmationCard confirmation={confirmation} onConfirm={confirm} />);
  expect(screen.getByText(confirmation.destination)).toBeVisible();
  expect(screen.getByText(shortHash(confirmation.payloadHash))).toBeVisible();
  expect(
    screen.getByRole("button", { name: "Confirm and submit" }),
  ).toBeEnabled();
});
```

- [ ] **Step 2: Run component tests and verify components are missing**

Run: `pnpm --filter @humanos/web test -- workflow-review.test.tsx confirmation-card.test.tsx run-timeline.test.tsx`
Expected: FAIL.

- [ ] **Step 3: Extend the API helper for methods and idempotency**

```ts
export async function api<T>(
  path: string,
  options: {
    method?: "GET" | "POST" | "PUT" | "DELETE";
    body?: unknown;
    idempotencyKey?: string;
  } = {},
): Promise<T>;
```

Preserve same-origin credentials and current error parsing. Generate mutation idempotency keys once per user intent and reuse them on a retry.

- [ ] **Step 4: Implement workflow data hook and transcript variants**

```ts
export function useWorkflow(id: string | null): {
  detail: WorkflowDetailResponse | null;
  run: WorkflowRunDetailResponse | null;
  busy: boolean;
  error: string | null;
  assemble(): Promise<void>;
  activate(versionId: string, graphHash: Hex): Promise<void>;
  runNow(input: Payload): Promise<void>;
  confirm(id: string, payloadHash: Hex): Promise<void>;
  cancel(): Promise<void>;
};
```

Poll only non-terminal runs, stop on unmount, keep the last successful view during transient errors, and represent pauses as explicit transcript items.

- [ ] **Step 5: Implement review, timeline, schedule, and confirmation components**

Use semantic headings/lists, visible focus, status text in addition to color, exact external destination/value/attachment display, and a single `Confirm and submit` button. Do not show a second World ID verification step. Disable activation when graph hash/version changes.

- [ ] **Step 6: Integrate into the existing compact chat shell**

Keep the composer fixed and the conversation independently scrollable. Desktop shows a 320px mission rail and centered conversation; mobile collapses the rail into the existing sheet. Use the current warm monochrome visual language, flat cards, 44px minimum touch targets, no gradients, and no horizontal overflow at 320px.

- [ ] **Step 7: Run web unit, accessibility, responsive, and build checks**

Run: `pnpm --filter @humanos/web test && pnpm --filter @humanos/web typecheck && pnpm --filter @humanos/web build && pnpm exec playwright test tests/e2e/accessibility.spec.ts tests/e2e/responsive.spec.ts`
Expected: PASS.

- [ ] **Step 8: Commit the workflow UI**

```bash
git add apps/web
git commit -m "feat: add workflow review and run timeline"
```

### Task 13: Prove the complete durable workflow journeys

**Files:**

- Create: `tests/e2e/workflows.spec.ts`
- Modify: `tests/e2e/backend-server.ts`
- Modify: `tests/e2e/fixtures.ts`
- Modify: `README.md`
- Modify: `docs/demo-script.md`
- Modify: `docs/architecture.md`
- Modify: `docs/threat-model.md`
- Modify: `docs/integration-debrief.md`

**Interfaces:**

- Consumes: all earlier tasks.
- Produces: deterministic acceptance coverage and user/developer documentation.

- [ ] **Step 1: Add deterministic E2E adapters and restart controls**

```ts
export const workflowTestControl = {
  disconnectConnector(id: string): void,
  failNextAttempt(kind: "transient" | "unknown_outcome"): void,
  changePreparedPayload(field: string, value: string): void,
  restartWorker(): Promise<void>,
  advanceClock(iso: string): Promise<void>,
};
```

These controls exist only under the E2E server entrypoint and never ship in the production API.

- [ ] **Step 2: Write the successful connector and browser-fallback journeys**

```ts
test("creates, reviews, activates, runs, and receipts a connector workflow", async ({
  page,
}) => {
  await createWorkflow(
    page,
    "Draft an event application and add the deadline to my calendar",
  );
  await expect(page.getByText("Workflow ready for review")).toBeVisible();
  await page.getByRole("button", { name: "Activate workflow" }).click();
  await page.getByRole("button", { name: "Run now" }).click();
  await expect(page.getByText("Completed")).toBeVisible();
  await expect(page.getByText("Execution receipt")).toBeVisible();
});
```

Add a browser fallback journey that pauses, displays exact destination/hash, confirms once, and completes with a browser receipt.

- [ ] **Step 3: Write denied, disconnected, stale-confirmation, restart, cancellation, and recurring journeys**

Assert that no protected effect occurs on each denied/expired/cancelled path; reconnect/resume continues from the checkpoint; worker restart does not duplicate effects; recurring runs skip overlap.

- [ ] **Step 4: Run focused E2E tests on desktop and mobile**

Run: `pnpm test:e2e -- tests/e2e/workflows.spec.ts --project=chromium-desktop --project=chromium-mobile`
Expected: PASS.

- [ ] **Step 5: Update architecture, demo, threat model, setup, and integration feedback**

Document `OPENCODE_API_KEY`, migration/start commands, block/authority boundaries, local scheduler limitation, successful and alternative demo paths, time to first success, friction, missing capability, and the highest-impact documentation improvement. Do not include real credentials or unverifiable claims.

- [ ] **Step 6: Run the full release gate**

Run: `pnpm format:check && pnpm lint && pnpm typecheck && pnpm test && pnpm build && pnpm test:e2e && pnpm scan && git diff --check`
Expected: every command exits 0; live-only tests may skip only when their documented credentials/services are unavailable.

- [ ] **Step 7: Commit acceptance coverage and documentation**

```bash
git add tests/e2e README.md docs
git commit -m "test: cover durable workflow automation journeys"
```

### Task 14: Final integration review and main-branch handoff

**Files:**

- Review: all files changed by Tasks 1–13.
- Create only if findings exist: `docs/reports/durable-workflow-review.md`.

**Interfaces:**

- Consumes: complete implementation.
- Produces: evidence that the implementation matches the approved spec without regressions or unreviewed authority paths.

- [ ] **Step 1: Review spec coverage requirement by requirement**

Record concrete file/test evidence for Jev selection, DeepSeek isolation, immutable versions, recovery, connector-first routing, browser confirmation binding, scheduling, JAW revocation, World ID minimality, receipts, and responsive UI.

- [ ] **Step 2: Inspect all model-to-effect and client-to-server trust boundaries**

Run: `rg -n "OPENCODE_API_KEY|apiKey|cookie|authorization|browser\.submit|connector\.execute|effect\(" apps packages --glob '!**/dist/**'`
Expected: keys and cookies stay server-side; every effect route reaches policy/ownership/idempotency checks; no model output calls an executor directly.

- [ ] **Step 3: Re-run the full release gate from a clean process state**

Stop prior local processes gracefully, then run: `pnpm db:migrate && pnpm format:check && pnpm lint && pnpm typecheck && pnpm test && pnpm build && pnpm test:e2e && pnpm scan`
Expected: all configured checks pass.

- [ ] **Step 4: Verify git scope and commit chronology**

Run: `git status --short && git log --oneline --decorate -20`
Expected: only the user's pre-existing untracked native-design spec remains; implementation commits are scoped and have the requested Japan-time metadata.

- [ ] **Step 5: Commit review fixes if and only if the review changed files**

```bash
git diff --name-only -z | xargs -0 git add --
git commit -m "fix: address durable workflow review findings"
```

- [ ] **Step 6: Start the verified local stack for user acceptance**

Run: `pnpm dev`
Expected: web at `http://localhost:5173`, API/agent/demo health checks ready, and the browser can complete the deterministic acceptance journey.
