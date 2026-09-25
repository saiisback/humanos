# Primary review fixes

Implemented the review's reconciliation corrections plus the requested gateway and optional ENS receipt update hook. Ownership was limited to packages/tools, the sensitive executor and its tests, and this report. No API app route changes or dependency manifest semantic changes.

## Changes

- Successful reconciliation atomically persists SUCCEEDED receipt, advances EXECUTING application missions to RUNNING/calendar missions to COMPLETED, and records RECONCILED audit. Already revoked/expired/otherwise terminal missions retain their state.
- Shared `validateEffectResult(action, unknown)` checks exact response fields, matching effect kind and payload hash, and nonempty external ID. Both transport paths and the executor use it. Contradictory results stay RECONCILIATION_REQUIRED. Reconciliation also verifies the persisted receipt hash and recomputes the action payload digest.
- `createToolGateway(deps).invoke(actionId)` resolves backend state and calls deterministic authorize on every invocation. It accepts no model-provided authorization. Side effects delegate to the atomic executor for independent recheck and consumption. The raw signing transport is explicitly backend-private and must not be registered directly as an agent tool.
- Routine READ_DOCUMENT accepts only `{documentId}` and checks backend-supplied approvedDocumentIds. Its scoped store callback receives rootId/missionId/documentId; the result explicitly labels content UNTRUSTED_DATA. There is no filesystem or URL reading authority.
- Routine WRITE_DRAFT accepts only `{text}` (bounded to 100000 characters) and saves through an owner/mission/action-scoped callback, whose contract requires idempotency by actionId. Additional path or authority fields are rejected. Escalated internal actions require the atomic approval flow rather than silently consuming an approval in a routine tool.
- Optional executor `updateEnsReceipt({agentEns,receiptHash,receipt}): Promise<void>` runs only after the effect receipt transaction commits. Callback must write only the allowed receipt record, be idempotent by receiptHash, and resolve only after a real finalized write. Receipt metadata persists PENDING and its stable hash; callback failure records ENS_UPDATE_PENDING, while later execute calls retry only this callback. Success records CONFIRMED and ENS_UPDATE_CONFIRMED. No configured callback means no on-chain write or confirmation claim. The hook contains no fake chain success.

## API integration contract

Gateway dependencies: `resolve(actionId): Promise<ToolContext>`, pinnedJevModelVersion, questionVersion, `readDocument({rootId,missionId,documentId})`, `saveDraft({rootId,missionId,actionId,text})`, `executeApproved(actionId)` (atomic executor), optional clock. ToolContext combines trusted policy input with approvedDocumentIds. Resolve must obtain current owner-scoped persisted mission/action, fresh ENS authorization and matching model assessment; routes still enforce session ownership. Callbacks are backend services, never caller-supplied tool inputs.

The optional ENS hook is an integration seam, not proof of live ENS execution. An application without a finalized ENS receipt writer must leave it unset. Database failure after a successful chain write can retry the same commitment, so the callback's idempotency contract is necessary.

## Verification

- Wrote regression tests first and observed wrong-kind acceptance, stranded EXECUTING state and absent pending ENS tracking fail before production changes.
- `pnpm --filter @humanos/tools test`: **7 passed** (3 gateway, 4 transport).
- `pnpm --filter @humanos/api exec vitest run test/execute-sensitive-action.test.ts`: **10 passed** on real PostgreSQL, including concurrent execution, revocation, ambiguity reconciliation, state/audit recovery, preserved revocation, wrong-kind rejection, ENS-only retries, calendar completion, payload replacement and stale ENS authorization.
- Tools and API typechecks passed in the final scoped run.
- Root `pnpm test`: schemas20/models20/policy163/world9/database11/tools7 and agent humans11 passed; **agent recovery.test.ts failed** at `accepted direct prompt survives pool restart and expired owner is reclaimable` (expected persisted user prompt, got undefined). Root owner notified; the unrelated agent implementation was not edited. The recursive run stopped before remaining API/demo suites.

No live World proof or ENS write was performed. Tests inject provider transports/hooks only and do not authorize production with fixtures.
