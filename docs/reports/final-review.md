# Independent final review

Reviewed 2026-09-24. **Local source-review verdict: no unresolved actionable critical/high finding in the reviewed final paths. Original findings were corrected. Full specification and prize qualification remain incomplete until credentialed integration and deployment evidence exist.** This is a scoped review, not a security certification or claim of live success.

## Scope and evidence

Read the complete design and implementation plan, frozen interfaces, schemas, policy/database, World verifier, model adapters, tools/protected service, executor, API app/server, Flue integration, relevant browser flows/tests, ENS registrar/deployer/reader/writer/adapter, transaction journal, and deployment/evidence documents. Prepared initial tracked diff `/tmp/humanos-final-review.diff`; untracked additions were inspected directly. Reviewed changes through c601396, b020823, b5af823, 9ade436, 1ae0f75, daa4dd2, b29c698 and final durable-journal/server commit e85caab.

No implementation edits or broad test reruns by this reviewer. One original transport defect was reproduced through the actual exported client. Regression test source and worker-reported outcomes were inspected; final whole-project execution belongs to the lead. External-provider fixtures, local Anvil contracts and Postgres integration tests must not be described as live sponsor evidence.

## Findings and resolution

| Original finding                                                                               | Resolution in reviewed code                                                                                                                                                                                    |
| ---------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| P1: Compose uses `http://demo:3003` while effect client rejects non-loopback HTTP              | Exact parsed-host opt-in `DEMO_SERVICE_ALLOW_HTTP_HOST=demo`; other hosts remain denied. Original constructor failure was directly reproduced before the fix.                                                  |
| P1: root and sensitive proofs use different World actions but compare action-scoped nullifiers | Both use registered `humanos-root`. Exact sensitive binding is committed through the signal, with fresh RP nonce, stored challenge and same normalized nullifier check retained.                               |
| P2: expired pending approval cannot receive a fresh challenge                                  | Refresh under action/mission lock reuses the matching approval, consumes old challenges and issues a fresh request. Tests cover replacement, replay, concurrency, cancelled approval and session takeover.     |
| P2: uncertain receipt hides the only reconciliation path in UI                                 | `Check submission status` invokes existing executor reconciliation without resubmitting the effect, including revoked missions. Pending ENS publication has a separate retry affordance.                       |
| P2: verified-but-unexecuted approval cannot be cancelled                                       | Database permits unconsumed PENDING/VERIFIED cancellation, including stale approval, while preserving evidence. API rejects consumed/terminal cases and rejects the mission atomically.                        |
| P1: stale ENS RPC head receives a fresh local authorization timestamp                          | Latest-head age/future-skew is bounded. Stale state returns inactive with empty capabilities. Finalized head is allowed to lag normally.                                                                       |
| P1: detectable head advancement during pinned ENS reads returns pre-revocation authority       | Latest number/hash is checked again; reader retries consistently or fails unavailable after bounded attempts.                                                                                                  |
| P2: ENS EAC grants absent from effective authority                                             | Both status and receipt `hasRoles` are read at finalized/latest pinned blocks and intersected with registrar/hierarchy/records/lifecycle.                                                                      |
| P2: registration retries accept different/dead bindings; funding races on operator nonce       | Exact root/agent identity, owner/account, name, capabilities, expiry and live hierarchy checks; root-label/node consistency; durable nonce reservation now covers funding and contract writes.                 |
| P2: receipt timeout can cause fresh ENS/funding transaction on retry                           | Durable journal commits signed bytes/hash/nonce before broadcast. Same logical operation reuses identical transaction bytes/nonce after timeout/restart; no fresh signing merely because receipt is missing.   |
| Potential pool starvation from outer API transaction requesting nested DB connection           | Server creates a separate, boot-time ENS pool for journal transactions and receipt-publisher reads, using the same database/schema. Journal prepare callback does RPC/signing, not another nested DB checkout. |

VERIFIED approvals past the five-minute freshness limit intentionally cannot refresh. Users can cancel safely and create a new mission. Freshness is not weakened to improve recovery. Another session cannot take over a pending challenge: this is an intentional restricted recovery path.

## World protocol assessment

The original cross-action assumption contradicted official [Core Concepts](https://docs.world.org/world-id/concepts.md) and [IDKit integration step 6](https://docs.world.org/world-id/idkit/integrate.md), which define action-scoped nullifiers. The fixed action plus cryptographically bound signal now matches these documented semantics. Approval signal is SHA-256 of root ID, agent ENS, mission ID, action type, payload hash, nonce and expiry. Backend verification checks exact signal hash, action, nonce, environment, issuer/schema, proof expiry, normalized same-human nullifier and official endpoint success. Root/approval challenge consumption and approval state mutation remain transactional. Removing nullifier equality was correctly rejected.

This closes the local protocol mismatch; it does **not** demonstrate event-portal repeat-verification settings or a real Proof of Human flow. Credentialed root plus sensitive approval must still be exercised with the actual app. The official [HITL integration](https://docs.world.org/agents/human-in-the-loop/integrate.md) documents the World HITL package with Workflow/Vercel AI SDK; this repository integrates the underlying IDKit/RP protocol through Flue. Organizer acceptance and Agents prize eligibility remain unverified. [Session proofs](https://docs.world.org/world-id/idkit/session-proofs.md) provide a separate official continuity mechanism, but this implementation does not claim to implement them.

## ENS and durable-write assessment

The registrar composes official factory-deployed UserRegistry/PermissionedRegistry, PermissionedResolver and EAC primitives. It builds the hierarchy, restricts transfer/redirection/escalation powers, bounds expiry by ancestors, prevents capability broadening and label reuse, and revokes status/receipt setter rights. Dedicated per-agent resolvers make key-scoped setter grants effective for that identity. Status text is not authorization. Raw resolver grants do not themselves expire automatically; HumanOS authorization and public resolution reject expired names.

The final reader independently verifies hierarchy, resolver, protected records and both scoped grants at finalized/latest snapshots. It narrows capabilities, rejects local/chain expiry, stale/future latest heads and detectable head advancement. Two pre-effect reads reduce races but cannot atomically serialize an unrelated chain transaction with a later remote HTTP effect. Do not claim an absolute cross-system race guarantee beyond that boundary.

Registration retries compare exact requested commitments and live state; API serializes mission registration before the chain call. Deterministic mission labels/keys and exact retry checks prevent a changed capability/expiry request from silently adopting another identity. Server now wires the real adapter and receipt publisher, rather than leaving integration hooks unused.

The transaction journal uses a per-chain/signer PostgreSQL advisory transaction lock, unique operation identity and unique signer nonce. The operation key binds chain/signer/target/calldata; funding additionally binds target/threshold. It prepares and signs while reserving, commits raw bytes/hash/nonce before broadcasting, and preserves pending/reverted intent across restarts. Receipt errors or missing receipts do not authorize a fresh nonce for the same operation. Funding is an initial logical operation, so spending a completed transfer does not turn a retry into another top-up. Production environment construction rejects the test-only nondurable journal. Test source covers timeout/restart, broadcast failure/restart, separate journal instances racing funding, old completed record-write retry after a newer write, reverted intent and persistence failure.

All processes sharing a signer must share this durable journal; independent/manual writes using that key remain an operational coordination concern. A stuck or dropped pending transaction may block higher nonces and requires explicit reconciliation; the implementation prioritizes no duplicate operation over silently signing a replacement. Preserve journal data/backups with the application database.

Receipt publication occurs after durable external-effect success. It verifies receipt commitment and authority, maintains a bounded action-keyed ledger, rejects conflicts, and confirms only when the expected ledger is visible at finalized. Retrying publication does not repeat the original effect.

## Security conclusions

No confirmed anonymous authorization, cross-user access, payload substitution, proof-replay acceptance or model-to-privileged-executor bypass was found in the reviewed paths.

- Random session tokens are hashed server-side and sent via HttpOnly/SameSite cookies, Secure on HTTPS. Mission/action/conversation routes check persisted ownership. Conversation IDs alone confer no authority.
- Deterministic policy recomputes payload hashes; validates exact identity, capability intersection, lifecycle and expiry; requires matching Jev state hash/pinned versions/freshness; and cannot be broadened by model output. Unknown or malformed outputs fail closed.
- Mission/action locks serialize local execution, cancellation and revocation. Approval consumption is conditional. Stable action idempotency keys plus unique downstream rows prevent duplicate persisted external effects, including after a DB rollback or ambiguous response. Reconciliation is read-only with respect to the external submission.
- Signed effect envelopes bind payload hash, action/idempotency key and kind, enforce freshness, and authenticate receipt lookups. Production transport remains server-private; no shell tool or arbitrary URL/path execution is mounted.
- The agent prepares proposals using a fixed mission identity. It cannot approve or submit by producing favorable prose. Document gateway access is owner/mission/approved-document scoped and labels content untrusted.
- Reviewed audit additions persist redacted cancellation, expiry, denied proof and final assessment/policy decisions, including pre-effect checks. Tests assert proof/payload markers do not leak. No broad secret scan was rerun by this reviewer; final scan evidence belongs to the lead.

## Specification and qualification limits

**World:** real SDK/signing/verifier code exists; live root/approval/failure evidence and organizer confirmation of the Flue protocol integration remain absent.

**ENS:** official contract composition, pinned official deployment provenance, local contract behavior, real TypeScript adapter and resolver publisher exist. The manifest lists official infrastructure; it is not proof of a deployed HumanOS registrar. Funded Sepolia HumanOS deployment, public source verification and live resolver/revocation evidence remain required.

**Models:** `deepseek-flash` and pinned Jev adapter are implemented. Synthetic threshold regression results explicitly do not constitute live calibration. Actual provider output/latency/accuracy evidence is still needed.

**Flue:** real runtime and durable persistence are implemented. Local recovery tests establish storage/requeue behavior; they are not a recorded credentialed kill/restart/resume journey.

**Product scope:** actual agent prepares application/calendar proposals. Document/draft gateway functionality exists as a library but is not a demonstrated mounted document-upload workflow. Calendar effect is the owned development store, not a demonstrated external calendar provider. Current ENS root ownership defaults to the operator; human control is through World-authenticated application authorization, not user-held root-wallet signing. Describe these accurately.

**Deployment:** public URL, live services, live sponsor proof/transactions, recorded success/cancel/expiry/revoke/recovery journeys and measured integration debrief are not established by local tests. Credentials block these demonstrations; they do not excuse missing local logic. Reviewed local defects have been corrected, but the full definition of done and any prize-qualification claim remain conditional.

## Verification handoff

Do not rerun suites merely to reproduce this source review. Lead should attach the final tests/build/lint/format/scan results after the journal commit. Worker-reported cancellation checks were API 38/database 12/models 20; earlier whole-project results predated late ENS edits and must not be presented as verification of those edits. Final worker-reported evidence for e85caab: ENS 48 tests using real Postgres/Anvil and API 38 tests passed; ENS/API typechecks, ESLint and Prettier passed. Independently inspected the committed receipt-depth reconciliation change, separate ENS pool wiring, and explicit resolver readback proving an old completed write does not overwrite a later value. No unresolved critical/high source finding remains from this review. The lead's final whole-project gate still owns aggregate verification.
