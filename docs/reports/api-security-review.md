# API security review

**High/critical security verdict:** No actionable high or critical exploit was established in the reviewed snapshot. This is a source review of the stated boundaries, not a claim that live integrations or the full specification are complete.

**Spec verdict:** The core ownership, challenge consumption, exact-action approval and fail-closed policy design is implemented. Full acceptance remains conditional on live same-human World verification, the actual ENS adapter/configuration, durable on-chain revocation recovery, and integration of the optional receipt-record writer. The snapshot must not be described as a fully verified live deployment.

## Review basis

- Requested baseline: `b66783c` (database/policy implementation). No database/policy diff from that baseline was present during this review.
- Working tree HEAD at review start: `3b8c62df2279ebeb1daf252ad17c7d08ac6590c0`.
- Uncommitted API snapshot copied to `/tmp/humanos-api-security-app.ts`; complete addition diff captured at `/tmp/humanos-api-security-review.diff` because app.ts was untracked and ordinary `git diff` omits untracked files.
- Reviewed current `apps/api/src/app.ts`, `packages/world/src/index.ts`, database repository/schema/migration, policy decision/capability/risk/state code, relevant task briefs 3/6/8/11, frozen interfaces and the MVP spec. The current executor was read as a called boundary; its implementation was already reviewed/fixed separately and is not claimed as independently authored here.
- Official World IDKit integration documentation was checked for complete-payload v4 verification and proof shape. The v4 example calls the nullifier RP-scoped; the integration page also contains generic action-scoping language. Live cross-action same-human compatibility must therefore be demonstrated with the actual event configuration; a mismatch would fail closed at the explicit equality check, not silently approve another human.

## High/critical findings

None established. Consequently there is no supported exploit sequence to report at the requested severity threshold. Generic hypotheses requiring stolen backend secrets, arbitrary database writes, malicious trusted adapters or a compromised official verifier are not reported as application exploits.

## Boundary analysis

### Cross-user access and sessions

Mission routes use server session lookup and root ownership. Action routes resolve their mission and apply the same ownership check before approval, confirmation or execution. The internal conversation lookup also uses owner(), so knowing a conversation ID does not authenticate its owner. Session tokens are random, stored only under their canonical hash, expire server-side, and are deleted at logout. Cookies are HttpOnly, Strict SameSite and Secure for configured HTTPS origins. Mutating requests reject foreign Origin and cross-site fetch metadata.

Root reauthentication reuses the existing root only after a new verified challenge proves the same normalized nullifier hash. The client cannot select a root or supply its own session identity. The privileged internal preparation endpoint requires the backend bearer secret; its trust is service-level and must remain unavailable to browser/model inputs.

### World proof, challenge replay and same-human linkage

Root requests bind server-generated challenge state to a random browser challenge cookie. Root verification retrieves that state by request ID, checks cookie ownership, sends the entire proof to the official verifier, and atomically consumes the challenge with root/nullifier/session changes. Concurrent verification cannot consume the same challenge twice. Concurrent first registration with the same nullifier may cause one transaction to fail uniqueness; it does not create two roots.

Approval challenges additionally bind action, root and session IDs. The verifier checks protocol, action, nonce, environment, issuer, signal hash, proof expiry and exact normalized session nullifier, then requires official overall and Proof of Human success. Database mutation consumes the challenge and updates only a still-pending approval under locks. Cancelled or already-consumed approvals cannot be verified again. An altered payload or authority identity invalidates deterministic approval binding/hash checks before execution.

No browser-provided expected challenge, authorization object or model verdict is treated as sufficient authority.

### Lifecycle, policy and replay

Policy validates shared strict schemas, exact action/mission/root/agent identity, action and mission expiry, static action-to-capability pairing, intersection of mission/approved/current ENS capabilities, finalized/fresh ENS data and exact Jev state hash/version/confidence. Sensitive static risk cannot be downgraded by the model. It requires a fresh, verified, unconsumed World approval bound to the complete action context.

Database execution locks mission then action; approval consumption is conditional and receipt/idempotency uniqueness is enforced in PostgreSQL. The HTTP API does not expose arbitrary action-payload mutation, and internal preparation preserves existing actions rather than replacing the action behind an approval. Retrying an already executed action returns its persisted receipt; ambiguous outcomes reconcile instead of creating a new effect. Model preparation can persist an action awaiting approval, but it cannot execute it by returning a favorable assessment.

### Revocation and unresolved integration semantics

The revoke route persists local REVOKED before attempting the chain write. A failed chain call therefore leaves all later HumanOS policy checks locally denied; it does not fail open. However, a repeated revoke request attempts REVOKE on an already terminal mission and stops before retrying the chain call. This is incomplete on-chain recovery, not an established local authorization bypass. A durable pending-revocation record or idempotent retry branch is needed to fulfill the revocation journey reliably.

The source-level EnsAdapter is trusted configuration. This review does not establish that an actual connected adapter reads finalized current state or enforces root-to-agent ownership correctly. The server snapshot did not configure an ENS adapter, so relevant routes were unavailable rather than substituting a successful identity. The API execution route also did not pass the optional finalized receipt-update hook; no on-chain receipt confirmation may be claimed from that path.

## Validation scope

No code or tests were changed. No test reruns, live World proofs, ENS writes, external deployments or credentialed requests were performed. Source inspection, baseline diff inspection and official documentation retrieval formed this review. Existing unit-test success does not substitute for live event-environment proof compatibility or external authorization verification.
