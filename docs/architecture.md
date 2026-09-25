# Architecture

The React client contains UI and IDKit, never provider keys or authorization decisions. Same-origin HttpOnly sessions are validated by Hono against PostgreSQL. Root proofs use backend-created challenges bound to an unpredictable browser challenge cookie. Challenges and root nullifiers are consumed atomically. Returning humans reuse their existing root; fresh proofs can create a new authenticated session without a second root.

Flue owns durable conversations and accepted submissions. Its routes verify session ownership with the API on every read, prompt, abort, and attachment access. The model has no shell or filesystem sandbox. The sole model tool asks the backend to prepare an action for the authenticated conversation mission. The backend loads the current mission, validates a DeepSeek proposal, obtains a typed Jev assessment, and invokes policy. Frozen schemas reject unknown capabilities and model fields.

Authorization intersects the mission allowlist, explicit human grant, current ENS capabilities, lifecycle and expiry. Jev can block or raise risk, never expand this intersection. Static action risk is a lower bound. Both provider version and exact normalized mission/action state hash are checked.

Sensitive execution locks the mission and action, checks any existing receipt, reevaluates current state, checks ENS, consumes approval, checks ENS again, and calls the protected service with a stable action idempotency key. The service verifies a short-lived HMAC of the entire body and stores one durable result per key. Unknown results become RECONCILIATION_REQUIRED; retries reconcile before any repeated effect. A database rollback cannot undo an external effect, so downstream idempotency is mandatory.

World approvals bind root, agent, mission, action type, complete payload hash, server nonce and expiry. Canonical SHA-256 hashes use the documented HumanOS canonical JSON algorithm. World signing and signals use official SDK hashing. Root and approval use the same `humanos-root` action; a fresh signed RP nonce and the canonical approval binding signal distinguish each approval. This preserves action-scoped nullifier identity. The same human must prove approval; a client-side success callback has no authority.

The official World HITL package currently wraps Vercel Workflow SDK. HumanOS implements its documented RP-signature/action-bound-IDKit/v4-verification protocol directly so Flue remains the only agent framework. Organizer acceptance and live proof success are not established by local tests.

The repository-owned submission/calendar service persists development application and calendar records. It does not submit an external event organizer's official application or create a third-party calendar event.

ENS receipt publication stores a canonical action-ID-to-receipt-hash map through the task account’s scoped resolver role. A mined write stays pending until a finalized snapshot contains it. Retrying publication never repeats the protected side effect. The registrar uses server-held operator ownership in this MVP; connecting a browser wallet does not silently transfer root ownership.

ENS transaction intents are journaled in PostgreSQL: the signed raw transaction, hash and reserved nonce commit before broadcasting. Retries reconcile that hash or resend identical bytes. Funding uses a stable initial-funding identity. The ENS journal/read pool is separate from the API transaction pool, preventing nested pool exhaustion. All processes using a signer must share the journal; an uncertain transaction is never replaced with a new nonce merely to make progress.
