# HumanOS Durable Workflow Automation Design

Date: 2026-09-26
Status: Approved design, ready for implementation planning

## 1. Objective

HumanOS will let a signed-in user describe a real-world task in chat, turn that request into a durable workflow assembled from a fixed catalog of typed blocks, review the workflow, and run it immediately or on a local schedule.

The workflow engine must support research, navigation, extraction, form filling, connector calls, waits, schedules, approvals, content generation, and final submission. Connectors are preferred. When no supported connector can complete a step, the run pauses until the user connects a service or explicitly allows HumanOS to use the user's logged-in browser. A browser submission always requires one final user confirmation bound to the exact payload being submitted.

This design extends the existing HumanOS Mission, JAW session/permission, World ID, ENSv2 identity, policy, Flue, and receipt systems. It does not replace the working identity flow.

## 2. Product Trust Model

The layers have separate responsibilities:

- JAW proves control of the wallet/account, creates the authenticated backend session, and limits delegated account permissions through target, selector, spend, expiry, and revocation constraints.
- World ID Proof of Human is used only at product moments where uniqueness or humanness is actually necessary. It is not repeated for ordinary workflow execution or browser fallback.
- ENSv2 represents the durable identity/namespace and delegated roles for users and agents.
- HumanOS policy is the final deterministic authorization boundary for workflow and side-effect execution.
- Jev evaluates eligible choices and selects among registered workflow blocks. It never receives authority to invent executable capabilities.
- DeepSeek generates or transforms content only inside a content block. Its text is untrusted data, not executable workflow structure.
- Connectors and the browser executor perform effects only after all deterministic checks pass.

The minimum-assurance rule is: use JAW authentication for ordinary account control; request Proof of Human only for a workflow event whose fairness or abuse resistance actually depends on a unique human; request the user's one final confirmation immediately before an irreversible browser submission.

## 3. User Experience

### 3.1 Create

The user types a goal such as “find a suitable event, draft my application, and submit it Friday at 9:00.” HumanOS immediately saves the raw goal as a draft. The chat shows that it is assembling a workflow rather than pretending execution has already begun.

HumanOS computes the legal next blocks. Jev selects a block from that typed candidate list, returns its confidence and safety signals, and repeats until it selects `complete` or the assembly budget is exhausted. The resulting graph is validated before it is displayed.

### 3.2 Review and activate

Before activation, the user sees:

- the ordered or branching steps;
- data each step reads and writes;
- required connectors and browser fallbacks;
- external side effects and permission requirements;
- schedule or recurrence settings;
- places where execution may pause for connection or final confirmation.

The user can edit safe parameters, replace a connector, disable browser fallback, or request regeneration. Activation creates an immutable workflow version.

### 3.3 Run

The chat becomes a live run timeline. Each step shows pending, ready, running, waiting, retrying, completed, skipped, failed, or cancelled state. Generated content is visible and editable when appropriate. Connector calls and browser actions produce receipts.

If a connector is unavailable, the run pauses as `CONNECTION_REQUIRED`. After connection, it resumes from the checkpoint. If browser fallback is enabled, HumanOS may navigate, extract, and fill through the user's existing logged-in session. It must stop before the final irreversible action and show the exact destination and normalized payload.

The user's confirmation authorizes that exact payload hash once. Any relevant payload change invalidates the confirmation and requires a new one.

### 3.4 Manage

Users can resume, cancel, duplicate, inspect receipts, and schedule a workflow. Editing an activated workflow creates a new immutable version. Existing runs keep their original version snapshot.

## 4. Deterministic Block Catalog

Every executable block is registered in code with a versioned definition. A block definition contains:

- stable `type` and semantic version;
- validated input and output schemas;
- capability and permission requirements;
- effect classification: `pure`, `read`, `reversible_write`, or `irreversible_write`;
- executor kind: local, connector, browser, timer, approval, or content;
- timeout and bounded retry policy;
- idempotency strategy;
- receipt schema;
- eligibility predicate and transition rules.

Initial block families:

| Family | Initial block types | Notes |
| --- | --- | --- |
| Research | `research.web`, `extract.structured` | Read-only, sources retained in outputs. |
| Browser | `browser.navigate`, `browser.extract`, `browser.fill`, `browser.submit` | Submit is irreversible and confirmation-gated. |
| Connector | `connector.call` | Uses a registered adapter and typed operation. |
| Content | `content.generate`, `content.transform` | DeepSeek only; cannot add blocks or call tools. |
| Control | `control.wait`, `control.branch`, `control.join` | Deterministic state transitions. |
| Human | `human.connect`, `human.confirm`, `human.input` | Explicit pause states. |
| Schedule | `schedule.once`, `schedule.recurring` | Local scheduler in v1. |
| Existing effects | `application.submit`, `calendar.create` | Adapt existing execution paths into blocks. |

Adding “any workflow” means expanding this audited catalog and connector registry, not executing arbitrary model-produced code. Unsupported requests remain saved but pause with a clear missing-capability state.

## 5. Workflow Assembly

### 5.1 Candidate computation

HumanOS maintains assembly state containing the user goal, available connectors, authenticated identity, prior selected blocks, produced value types, schedule intent, and hard policy constraints. For each assembly turn, deterministic code computes only the blocks whose input types and preconditions can be satisfied.

The candidate payload sent to Jev includes opaque candidate IDs plus concise descriptions and typed parameter options. Secrets, browser cookies, raw JAW credentials, and unrelated user data are never included.

### 5.2 Jev decision contract

Jev is invoked through the OpenCode SystemOne endpoint using `jev-1.13`. It returns a strict response containing:

- selected candidate ID or `complete`;
- parameter choices restricted to candidate-provided enums/ranges;
- confidence;
- alignment, risk, and prompt-injection probabilities;
- `needs_review` and reason codes.

Jev does not emit free-form executable nodes, URLs, selectors, code, connector names, or capabilities. Unknown fields and out-of-range values are rejected. HumanOS validates the response, applies deterministic policy, and either appends the selected block or pauses for review.

Assembly has hard limits on node count, branches, evaluation turns, cost, and wall-clock time. A graph is rejected if it contains cycles, unresolved inputs, unreachable nodes, ambiguous outputs, unsupported capability requirements, or an irreversible effect without an approval path.

### 5.3 DeepSeek boundary

DeepSeek V4.1 Flash is invoked through OpenCode's OpenAI-compatible chat endpoint only by `content.generate` and `content.transform`. It receives a typed content brief and returns schema-validated content. It cannot select blocks, change graph topology, authorize effects, invoke tools, or advance run state. Generated content is labeled as model output and stored with prompt/model/version hashes.

## 6. Durable Data Model

The existing Mission remains the user-facing authorization envelope. The workflow subsystem adds the following persisted records:

### `workflow`

- `id`, `root_id`, `mission_id`, `name`, `status`
- `latest_version_id`
- `created_at`, `updated_at`, `archived_at`

### `workflow_version`

- `id`, `workflow_id`, monotonically increasing `version`
- raw user goal and normalized intent
- immutable graph JSON and graph hash
- required capabilities, connector references, browser fallback policy
- trigger definition
- assembler/model metadata
- `created_at`, `activated_at`

### `workflow_run`

- `id`, `workflow_id`, `workflow_version_id`, `mission_id`
- trigger kind and trigger occurrence ID
- immutable input snapshot and hash
- status and current pause reason
- lease owner/expiry and heartbeat timestamp
- started, completed, cancelled, and next-resume timestamps

### `step_run`

- `id`, `run_id`, block ID/type/version
- dependency snapshot
- status, attempt count, timeout, retry policy
- input/output references and hashes
- idempotency key
- started/completed timestamps and error classification

### `step_attempt`

- `id`, `step_run_id`, attempt number
- executor and provider metadata
- request/response hashes with redacted preview
- Jev decision metadata when applicable
- error, timing, and receipt ID

### `run_confirmation`

- `id`, `run_id`, `step_run_id`, actor identity
- destination, payload hash, presentation hash
- created and consumed timestamps
- expiry and status

### `workflow_schedule`

- `id`, `workflow_id`, `workflow_version_id`
- timezone-aware schedule definition
- next fire time, last fire time, status
- overlap policy, default `skip`

Large or sensitive payloads are stored through encrypted/redacted references rather than copied into every event. Logs never store connector secrets, session cookies, API keys, or full sensitive form contents.

## 7. Run State Machine

Workflow run states:

`QUEUED -> RUNNING -> COMPLETED`

From `RUNNING`, the run may enter:

- `CONNECTION_REQUIRED`
- `CONFIRMATION_REQUIRED`
- `INPUT_REQUIRED`
- `WAITING`
- `RETRY_SCHEDULED`
- `FAILED`
- `CANCELLED`
- `REVOKED`

A paused run returns to `QUEUED` only after its pause condition is satisfied. Terminal states never resume.

Step states:

`PENDING -> READY -> RUNNING -> COMPLETED`

Alternative transitions are `RUNNING -> RETRY_SCHEDULED`, `RUNNING -> FAILED`, and any non-terminal state to `CANCELLED`, `SKIPPED`, or `REVOKED` where policy permits.

Transitions use optimistic concurrency and append an audit event in the same database transaction. Workers claim runs with expiring leases. A crashed worker can be replaced after lease expiry without duplicating a completed effect.

## 8. Execution Semantics

### 8.1 Readiness and dependencies

The runner selects a step only when all required dependencies are completed and its branch predicate is true. Inputs are materialized from the immutable run snapshot and dependency outputs, then validated against the registered block schema.

### 8.2 Connector first

For an external operation, the capability router selects a registered connector operation first. If the required account is not connected, execution pauses with `CONNECTION_REQUIRED` and the UI identifies the exact service and permission needed.

If no connector supports the operation and browser fallback is allowed, the runner creates browser preparation steps. It never silently swaps execution modes.

### 8.3 Browser fallback

Browser execution uses the user's logged-in browser session. It may navigate, read page state, and fill a draft. Before clicking a button or taking another action classified as irreversible, it produces a normalized submission preview and pauses at `CONFIRMATION_REQUIRED`.

The server computes the confirmation payload hash from the workflow version, step, destination, normalized fields, attachments, price/value, and material page state. Confirmation is short-lived, single-use, scoped to the current run and step, and invalidated by any material change.

### 8.4 Idempotency and retries

Every effectful attempt has a deterministic idempotency key based on workflow version, run, step, logical trigger occurrence, and relevant input hash. Connectors receive the key when supported. Otherwise HumanOS records a prepared intent before the call and reconciles an uncertain result before retrying.

Retries are bounded, use exponential backoff with jitter, and apply only to classified transient failures. Validation, authorization, rejection, and confirmation errors do not retry automatically. Irreversible effects with an unknown outcome enter reconciliation instead of being repeated.

### 8.5 Receipts

Each completed external effect produces a receipt containing executor, destination, normalized effect summary, request/output hashes, timestamp, idempotency key, and provider reference. Existing HumanOS receipt and ENS publication mechanisms are reused where appropriate. Browser receipts include final page URL and non-sensitive success evidence.

## 9. Scheduling and Recovery

V1 scheduling runs locally in the HumanOS deployment. A durable scheduler scans due schedules, atomically records a trigger occurrence, and enqueues a run using the schedule's pinned workflow version. Timezones are stored explicitly; daylight-saving behavior is computed from the named timezone.

Recurring schedules default to no overlap. If the preceding occurrence is still non-terminal, the next occurrence is recorded as skipped rather than launched. The scheduler uses a uniqueness constraint on schedule and logical occurrence time so restarts cannot enqueue duplicates.

On startup, the runner reclaims expired leases, resumes timers, re-enqueues due retries, and leaves human-gated pauses untouched. It never reuses an expired or stale confirmation. Cancelling a workflow stops future schedule occurrences and cooperatively cancels unfinished steps. Revoking the JAW session or required permission prevents future protected effects and moves affected runs to `REVOKED` or an explicit authorization pause.

## 10. API Surface

The API remains backend-authoritative and adds versioned endpoints equivalent to:

- create/list/read/update draft workflows;
- assemble or reassemble a draft;
- validate and activate a workflow version;
- run now, cancel, and resume;
- create/update/pause schedules;
- connect or select a connector account;
- read run timeline, step outputs, and receipts;
- prepare and consume a final confirmation.

All mutating endpoints require the existing authenticated JAW/SIWE session, CSRF/origin protection, root-account binding, ownership checks, and request idempotency. The client cannot directly set run state, mark a step complete, or supply a successful connector/browser result.

## 11. Security and Safety

- Block definitions and connector operations are allowlisted and versioned in source.
- Model output is parsed through strict schemas and treated as untrusted.
- Remote page content is data; instructions found on a page cannot alter the graph, policy, destinations, or permissions.
- URL access blocks private networks, unsafe schemes, redirects to disallowed origins, and DNS rebinding.
- Browser fallback is opt-in per workflow and uses least-privilege browser control.
- Content generation cannot access connector credentials or browser cookies.
- Approval previews show actual destination, value, attachments, and material fields.
- Confirmation is server-issued, payload-bound, short-lived, single-use, and actor-bound.
- JAW expiry/revocation is checked immediately before protected effects, not only when the run begins.
- World ID is verified server-side when a declared proof-of-human gate is present; otherwise it is not requested.
- Audit records are append-only and redact secrets and sensitive values.
- Rate, cost, node, retry, browsing, and model-call budgets are enforced per run.

## 12. Testing Strategy

### Unit and property tests

- Jev can select only candidate block IDs from the registered catalog.
- Unknown fields, invalid probabilities, malformed parameters, and invented capabilities are rejected.
- DeepSeek content cannot add nodes, change capabilities, or execute an effect.
- Graph validation rejects cycles, missing inputs, unreachable nodes, ambiguous outputs, and unapproved irreversible actions.
- State machines reject invalid transitions and terminal-state resurrection.
- Payload hashes change for every material browser submission change.
- Idempotency keys remain stable across safe retries and differ across logical occurrences.
- Scheduling handles timezone transitions, missed ticks, overlap skips, and duplicate scans.

### Integration tests

- A connector-backed workflow assembles, activates, runs, and emits a receipt.
- Missing connector pauses at `CONNECTION_REQUIRED` and resumes after connection.
- Connector unavailability selects an allowed browser fallback.
- Browser preparation can navigate and fill but cannot submit without confirmation.
- Exact payload confirmation permits one submission; stale, changed, expired, reused, or cross-run confirmation is denied.
- Transient failures retry within policy; permanent failures do not.
- A restart after every transition resumes correctly without duplicate effects.
- Cancellation, JAW expiry, and permission revocation stop future protected actions.
- Recurring runs do not overlap by default.
- Existing application and calendar execution continue through adapter blocks.

### Browser end-to-end tests

- Create a workflow from chat, review it, activate it, and run it.
- Observe live timeline updates and durable receipts.
- Pause for service connection and resume.
- Use browser fallback, inspect exact submission data, confirm once, and complete.
- Cancel a waiting run.
- Schedule and inspect a recurring local run.
- Demonstrate a rejected or failed path where the protected action does not occur.
- Verify responsive behavior for the compact mobile chat and desktop workspace layouts.

## 13. Delivery Sequence

Implementation should be incremental:

1. Add workflow schemas, registry, graph validator, database tables, and state machines.
2. Add OpenCode provider adapters and enforce the Jev/DeepSeek contracts.
3. Add the assembler and adapt existing application/calendar actions into blocks.
4. Add the durable runner, leases, retries, idempotency, recovery, and receipts.
5. Add connector routing and connection pauses.
6. Add browser preparation, payload-bound confirmation, and controlled submission.
7. Add local one-time and recurring schedules.
8. Replace the hard-coded mission UI with the workflow review and live run timeline.
9. Complete unit, integration, restart-recovery, browser E2E, security, and responsive tests.

Each slice must preserve the current JAW login, optional World ID proof, ENSv2 identity, and mission authorization paths.

## 14. Scope Boundaries

V1 does not execute arbitrary generated code, install arbitrary connectors, bypass a site's anti-automation controls, share cookies with model providers, or promise support for every external website. “Any workflow” means the system can represent arbitrary compositions of registered blocks and can pause honestly when a required capability is missing.

The scheduler is local-only in v1. Distributed scheduling and hosted unattended browser sessions are future extensions. Blockchain network migration is outside this workflow-engine change; existing JAW, World ID, and ENSv2 network configuration remains authoritative.

## 15. Success Criteria

The design is successful when a user can describe a supported multi-step task, review the Jev-assembled typed graph, activate it, run it through connectors or browser fallback, give exactly one final payload-bound confirmation for an irreversible browser action, recover safely from a restart, receive durable receipts, and schedule non-overlapping recurring runs—while DeepSeek remains limited to content generation and model output never becomes authorization.
