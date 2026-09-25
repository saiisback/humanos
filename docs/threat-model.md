# Threat model and residual boundaries

Protected assets: root ownership, mission capabilities, proof challenges, approval bindings, agent role state, submissions and calendar records, provider and signing secrets.

| Attack                                    | Control                                                                                                                                 |
| ----------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------- |
| Prompt injection in source content        | Closed action schemas; separate typed assessments; deterministic tool authorization; no model-selected destinations or filesystem paths |
| Cross-user conversation access            | Session cookie lookup + mission ownership for all Flue surfaces                                                                         |
| Proof replay                              | Server-generated challenge, atomic consumption, normalized root nullifier uniqueness                                                    |
| Approval payload replacement              | Recompute complete canonical payload + binding hashes at execution                                                                      |
| Approval reuse                            | Database status transition and action lock; unique binding and receipt constraints                                                      |
| Concurrent execution                      | Mission/action lock order and stable downstream idempotency key                                                                         |
| Timeout following a committed side effect | Persist ambiguous receipt; reconcile by key before retry                                                                                |
| Revoked or expired agent                  | Current authorization checks immediately before transport, intersected with mission state and expiry                                    |
| Secret exposure                           | Backend-only environment values; redacted provider errors; no client authorization data                                                 |
| Cross-origin requests                     | Strict same-site HttpOnly cookies and origin rejection                                                                                  |
| Endpoint/path injection                   | Fixed provider/downstream origins, bounded request bodies, no model-supplied URL                                                        |

No off-chain system can atomically lock a public blockchain and an unrelated HTTP service. ENS checks narrow the race window but cannot prevent revocation mined after the final read and before the downstream commit. A stricter guarantee needs an on-chain execution gate or a downstream service verifying an on-chain commitment at commit time. This residual is not presented as solved by a mock race test.

Tests using synthetic proofs establish local validation and transaction behavior, not World cryptographic validity. Jev thresholds are conservative provisional thresholds checked against synthetic fixtures; measured live calibration remains required. Real deployment keys, account provisioning, organizer qualification, and public hosting remain external steps.
