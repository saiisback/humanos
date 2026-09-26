# ENSv2-backed durable workflows

Status: proposed design for user review; not implemented.

## Outcome

HumanOS workflows must have real, visible ENSv2 agent identities whose current permissions constrain execution. Clicking Identity & permissions must open useful workflow-agent management, not the older mission conversation screen. The user owns the account/root, can inspect scope and expiry, and can revoke an agent. Ordinary execution must not repeatedly ask for approval of unchanged material.

This is an architectural integration between the durable workflow runtime and the existing ENS adapter. It is not a cosmetic name field, a rewrite of the legacy mission engine, or authorization for live bookings/sends.

## Current evidence

- `apps/web/src/main.tsx` sends `?identity=1` to the legacy `App`, rather than a dedicated identity page.
- `apps/web/src/workflows/workspace.tsx` infers ENS linkage from `missionId`; that is not evidence of a registered, currently authorized agent.
- `apps/api/src/workflows/runtime.ts` explicitly returns false for mission-bound workflows. Removing that line alone would omit ENS checks.
- `packages/ens/src/adapter.ts` already provides registration, finalized/latest authorization reads, revocation and scoped record writes, but its public registration interface uses `Mission`.
- `packages/ens` already uses a durable signed-transaction journal. New workflow registration must reuse that protection.
- Workflow confirmations already bind the exact run/step/account and material payload, with a five-minute expiry. Registration consent and final offchain action confirmation are different permissions.

## Approach

Use an explicit workflow-agent binding and a shared, narrowly typed ENS registration interface. Keep legacy mission calls working through a compatibility wrapper. Do not construct fake missions or reuse the legacy mission execution/approval state machine to run durable workflows.

Alternatives considered:

1. Link workflows to legacy missions: reuses records but couples two incompatible lifecycles and approval models. Not selected.
2. Put an ENS name on the workflow: small UI change but offers no enforceable authority. Rejected.
3. Explicit workflow-agent lifecycle using the existing ENS writer/reader: selected; preserves the durable runner and makes authority testable.

## Identity and data model

Persist a validated workflow-agent binding with account ID, verified root ID, workflow ID, version ID, graph hash, canonical approved capabilities, expiry, generation, ENS name/node, agent address, chain ID, lifecycle state and registration/revocation transaction evidence. Never persist private agent keys in API responses or workflow inputs.

One active agent is associated with a workflow's approved version. A materially changed graph or scope creates a replacement generation; it cannot silently widen an existing agent. Agent derivation IDs are domain-separated from legacy mission IDs and stable across retries. Uniqueness constraints prevent duplicate generations or concurrent activation races.

Lifecycle: `PENDING_REGISTRATION → ACTIVE → REVOKING → REVOKED`, with explicit `FAILED` and `EXPIRED` states. Onchain timeouts remain pending/reconciling rather than triggering new signing intents. Distinguish temporary RPC unavailability from confirmed expiry or revocation.

The authenticated account must own the verified root binding. Names and agent addresses come from the adapter and verified chain evidence, never from a model or a user-entered ENS name. The registrar/operator remains backend infrastructure; the UI must accurately disclose operator custody of derived agent signing keys rather than imply that those keys live in the user's wallet.

## Activation and migration

The existing review/run action presents version, capability scope, expiry and Sepolia network before activating an ENS-backed workflow. Default expiry is 24 hours, clipped to the live parent/root expiry; display the effective expiry before consent. No automatic renewals.

Activation checks ownership and graph integrity, persists the registration intent, registers through the durable ENS journal, verifies resulting authority, then activates the version with its binding. A pending or failed registration cannot execute as if registration succeeded. Do not hold a database transaction open while waiting on RPC receipts.

Content-only steps map to the existing `drafts.write` capability; do not grant a write-to-third-party capability just to satisfy registration's nonempty capability requirement. Search maps to `web.search`; external connector capabilities come from server-owned operation definitions. Update activation's displayed capability set to include the actual required agent scope.

Existing saved workflows remain readable. Do not register old workflows automatically or replay old actions. Show an explicit owner-only “Enable ENS agent” upgrade for an existing version. Legacy account-only mode remains labeled during migration; an ENS-required run must never downgrade to account-only execution on error.

An expired/revoked agent cannot be reused or silently revived. Replacing it requires a fresh scoped activation; existing schedules pause pending that activation. Preserve original run/receipt history.

## Authorization at execution

Compose existing session, account, run-lease and graph-hash checks with workflow-agent authorization. The decision must verify:

- The binding belongs to this account, root, workflow and exact activated version.
- The current lifecycle is active, unexpired and not locally revoking.
- The ENS hierarchy, controller/agent address and root ownership match the binding.
- The operation's effective capability is in both the approved version scope and live onchain authority.
- Finalized/latest intersection, name resolution, freshness and scoped resolver-role checks remain enforced by the existing reader.
- Abort/lease loss prevents dispatch.

Recheck immediately before every external effect, not only at workflow start. Scheduled runs use the same authorizer. A revoked, moved, detached or narrowed agent must stop the corresponding action. RPC failures fail closed with an actionable unavailable state and no write dispatch.

Keep the legacy mission-bound workflow rejection until a separately tested supported bridge exists; this design does not turn `missionId` into trusted workflow authority.

## Approval semantics

Starting the task authorizes preparation within the approved workflow scope. ENS registration/permission consent is shown once at activation, not once per step. A final external-action preview still binds the exact recipient/destination, content, price where relevant and service account.

Within the same run, unchanged valid final consent is reused through the confirmation and dispatch nodes; there must not be a second redundant prompt. Payload changes, different destinations, expired consent or new runs require appropriate fresh consent. Do not merge unspecified future writes into blanket approval.

This integration adds no mandatory fresh World verification per workflow step. Existing root verification is checked as a prerequisite. It does not claim compliance with a sponsor track requiring fresh verification at a particular event.

## Revocation and receipts

Owner revocation first persists a local deny state, blocks new dispatch and pauses affected schedules, then performs the journaled onchain revocation. A failed chain transaction must not restore local permission. Report pending onchain revocation separately from final confirmation. Already completed external effects cannot be undone by revoking ENS.

Record registration and revocation transaction references. Preserve local execution/provider receipts; write an opaque receipt hash to ENS through the existing scoped writer where configured. Never publish message bodies, booking details, personal email addresses or workflow prompts onchain. A failed receipt publication must be retryable independently and must not repeat the completed external action or claim that the ENS receipt exists.

## Interface

Keep the workflow workspace mounted when managing its agent. Add a dedicated identity/agents panel with:

- Connected account and root; staging versus production assurance clearly labeled.
- Per-workflow agent name, address, network and verified lifecycle.
- Approved capabilities, effective expiry and exact bound workflow version.
- Registration/receipt transaction references where available.
- Owner-only enable/replace/revoke controls with explicit action summaries.
- Clear pending, unavailable, expired and revoked states, not a false “linked” badge.

Deep links must preserve the selected workflow and support back navigation. Keep legacy mission links explicit and separate. Mobile dialogs/panels must remain scrollable, keyboard accessible and within the existing warm-ivory layout.

## Verification and acceptance

Use regression tests before implementation. Required checks:

1. Identity link opens agent management and preserves the selected workflow.
2. Cross-account/root access, attachment and revocation are rejected.
3. Activation creates one binding and one registration intent under concurrent requests/restarts; timeout reconciliation does not duplicate transactions.
4. A successful local-chain registration becomes visible with matching name/controller/capabilities/expiry; placeholder names never count.
5. A valid ENS-bound research/draft run completes through the real workflow runner.
6. Revoked/expired/detached/narrowed authority and stale/unavailable RPC deny effects, including a revocation between preparation and dispatch.
7. Each supported external action requires exactly one final confirmation for unchanged material; dispatch remains idempotent and unknown outcomes reconcile.
8. Graph/scope edits cannot reuse a broader or mismatched binding; schedules stop on expiry/revocation.
9. Receipt publication retries cannot resend an email or rebook a reservation.
10. API responses and onchain records contain no private signing material or sensitive payloads.

Run schema, database, ENS, policy, API and relevant browser tests. Label controlled test providers as fixtures. Only claim a Sepolia end-to-end pass after an authorized real registration transaction, confirmed records and a real read-only workflow execution are recorded. Live testnet broadcasts/permission changes require their own concrete authorization at the appropriate point; writing this design performs none.

## Non-goals

No production booking integration, wallet spending authority, universal browser automation, email delivery claim, automatic renewal, secret migration or legacy mission rewrite in this batch. Existing unrelated working-tree changes stay untouched.
