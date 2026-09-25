# Independent review: World, tools, demo service and executor

**Verdict: changes required.** The snapshot has a sound core for signed provider verification, canonical approval bindings, transactional execution and authenticated idempotent effects, but two concrete reconciliation defects prevent approval. Task 10 also remains incomplete in this snapshot.

Scope: `/tmp/humanos-primary-review.diff`, task briefs 6/8/10/11, frozen interfaces and MVP design. Current policy/database implementations were read to understand called contracts. The concurrently implemented `apps/api/src/app.ts` was deliberately excluded. No production/test files were edited. Line numbers below reference the unformatted snapshot/current files at review time.

## Actionable findings

### P1 — Reconciliation succeeds without finishing mission state or recording its audit event

`apps/api/src/services/execute-sensitive-action.ts:12`

When an effect times out, lines 26–28 commit a RECONCILIATION_REQUIRED receipt and leave the mission EXECUTING. The next call enters the `prior` branch, confirms the effect, updates only the receipt to SUCCEEDED and returns. The mission remains EXECUTING permanently, even though an application should resume RUNNING and a calendar should complete the mission. The early SUCCEEDED return on subsequent calls cannot repair this state. A durable runtime waiting for mission progress cannot advance, and the audit timeline never records the reconciliation outcome.

Apply the same success transition and append an audit event atomically with reconciliation's receipt update. Preserve any intervening terminal revocation/expiry rather than resurrecting the mission. Extend the existing ambiguity test to assert mission state and the additional audit event, including calendar completion and revoked mission reconciliation.

### P2 — Reconciliation can accept a receipt for the wrong effect kind

`packages/tools/src/index.ts:9,13` and `apps/api/src/services/execute-sensitive-action.ts:12,25`

The initial POST validates `result.kind`, but its catch calls `reconcile`, which checks only the payload hash and the type of `externalId`. A response describing a calendar effect is therefore accepted as success for an application when the hash matches. This is especially problematic because the normal-path validation explicitly detects that mismatch and then undoes the rejection through its fallback. The executor likewise treats any same-hash result as successful.

Reproduced with the actual exported client and an injected HTTP boundary: both endpoints returned `{externalId:"wrong-operation",payloadHash:"same-hash",kind:"calendar"}` for `SUBMIT_APPLICATION`; `execute` resolved successfully with that calendar result. Use one strict result validator for execution and reconciliation, deriving the expected kind from the action and requiring a nonempty external ID. At the executor boundary, validate the entire result rather than trusting a structurally typed dependency.

## Spec compliance and remaining integration work

- **Task 6:** backend RP signing, full payload forwarding to the official v4 endpoint, local action/nonce/environment/signal checks, explicit Proof of Human identifier/schema, provider success requirement and nullifier normalization are implemented. Root establishment and atomic uniqueness storage are API/database responsibilities absent from the snapshot. Test fixtures are transport fixtures, not live proof evidence. Event app registration and live credentials are not evidenced.
- **Task 8:** approval binding commits to root, agent, mission, action type, payload hash, nonce and expiry. Verification helper checks the actual payload digest. Atomic challenge consumption, ownership/root binding, approval persistence, denied/cancelled outcomes and replay handling cannot be certified without the excluded API routes. The World verifier itself is intentionally stateless; callers must provide a server-stored expected request and consume its request ID atomically. Never accept `expected` from the browser.
- **Task 10:** the snapshot exports a low-level signed HTTP transport, not a policy-gated tool gateway. `EffectAction` contains no mission, root, capabilities, ENS authorization or approval, and `execute()` makes no policy call. This is acceptable only as an executor-private transport. Do not wire it directly into Flue/model-callable tools. The brief's independently reauthorizing gateway, approved document reads, document injection treatment and draft persistence are not present; application/calendar persistence is implemented. The API must route every effect through the executor and own the signing secret exclusively, or add the prescribed gateway. This is a spec gap, not a demonstrated anonymous network bypass.
- **Task 11:** mission/action locks, prior receipt lookup, payload/approval validation via policy, atomic consumption, two ENS reads, idempotency and ambiguous outcome persistence are present. The specified allowed ENS record update is absent from the dependency interface/implementation. Both defects above affect receipt reconciliation. Tests do not currently assert reconciliation mission state/audit or malformed effect results; the test named "stale ENS reads" changes only the payload and does not exercise stale ENS data.

## Security conclusions

No definite proof-acceptance bypass was found in the reviewed verifier. It never accepts the local payload as sufficient: an official endpoint must return overall success, correct environment and a successful Proof of Human result. The official v4 docs were consulted for the full-payload endpoint and proof structure. Do not infer live SDK compatibility from injected fixtures.

The database's `withLockedAction` locks the mission then action; `consumeApproval` conditionally consumes only VERIFIED, unconsumed, unexpired approval. Together with deterministic policy's identity/digest/version/freshness checks, this supports the tested concurrent-use defense. A DB failure after the external effect can roll back consumption/receipt, but the protected service's unique stable action idempotency key prevents duplicate persisted effects on retry. A prior RECONCILIATION_REQUIRED branch correctly performs a read-only reconciliation instead of another POST.

The demo service checks canonical HMAC, recent issuance, action/idempotency-key equality, allowed effect kind and payload hash; its primary-key insert plus hash/kind conflict check deduplicates concurrent delivery. HTTPS is required except loopback and redirects are disabled. Replay within the signature window yields the same stored effect; it does not duplicate it. HMAC authenticates the privileged sender, not end-user policy, so its signing authority must remain inaccessible to model-callable execution paths.

## Validation performed

- Read all snapshot additions, corresponding briefs/spec, and policy/database collaborators.
- Executed the wrong-kind reproduction through the real `createSideEffectClient`; confirmed the acceptance described above.
- Parent-reported baseline: World 9, tools 3, demo 2, executor 4 tests passed. Those suites were not rerun in this independent review, because the snapshot is being actively integrated and the findings are deterministic from the isolated branch/reproduction.
- No credentialed World proof, live ENS transaction or remote deployment was performed.
