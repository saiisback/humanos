# HumanOS frozen interfaces — v1

`@humanos/schemas` exports Valibot strict schemas and inferred types. Source of truth: `packages/schemas/src/{domain,events,api}.ts`. Fields are required unless explicitly optional; nullable fields are serialized as null. Timestamps are ISO timestamps; compare parsed milliseconds. IDs are opaque server-issued strings. Domain states and risks are uppercase. Capabilities are closed lowercase dot-separated strings. Never accept a model-provided capability outside CapabilitySchema.

## Digest contracts

`canonicalize` accepts only JSON primitives, dense arrays, and plain own-data-property objects. Keys sort by JavaScript UTF-16 order recursively, array order remains significant, JSON number/string encoding applies, -0 becomes 0. Reject undefined, functions, symbols, bigint, nonfinite numbers, classes, accessor/hidden/symbol properties, sparse/decorated arrays and cycles. This is HumanOS canonical JSON v1; do not substitute ordinary JSON.stringify or call it RFC8785.

`hashCanonical` = lowercase 0x-prefixed SHA-256 of canonical UTF-8. Action.payloadHash hashes the complete `action.payload`. Approval.bindingHash hashes exactly `ApprovalBinding` (rootId, agentEns, missionId, actionType, payloadHash, nonce, expiresAt). Verify action identity, nonce, and binding as well as payload hash. `keccakCanonical` is only for explicitly designated EVM commitments, never interchangeable with SHA-256 approval hashing. ENS namehash uses the official ENS algorithm separately.

## Domain

Mission contains rootId, agentEns, title, goal, capabilities, approvedCapabilities, steps, state, expiry, timestamps and policyVersion. ActionProposalDraft is the model output; ActionProposal adds server-issued IDs, root/mission/agent identity, hash, nonce, timestamps. Models cannot grant authority. JevAssessment is normalized internal output, not a claim about the upstream wire format. The Jev adapter must map verified Choice/Noul/Score responses into it. Unknown/unpinned models and missing/low confidence must fail closed.

AgentAuthorization reports current finalized ENS state including capabilities, active/revoked, expiry, checkedAt and blockNumber. A client-supplied authorization is never trusted. Approval distinguishes consequential explicit confirmation from fresh World verification. ExecutionReceipt supports SUCCEEDED, FAILED, RECONCILIATION_REQUIRED; ambiguous upstream outcomes must reconcile. Audit metadata must contain redacted summaries only.

## HTTP v1 contract

All paths below use the API base URL and /api prefix, e.g. /api/missions. Protected routes use server-issued HttpOnly session cookies. Every mission/action route verifies root ownership server-side. Errors use ApiError `{error:{code,message,requestId?}}`. Expected codes: INVALID_REQUEST (400), UNAUTHENTICATED (401), FORBIDDEN (403), NOT_FOUND (404), CONFLICT (409), EXPIRED (410), INTEGRATION_UNAVAILABLE (503). Never return secret provider details.

| Method / path                      | Request                                                       | Response                                                |
| ---------------------------------- | ------------------------------------------------------------- | ------------------------------------------------------- |
| GET /health                        | —                                                             | `{status:'ok'}` liveness only                           |
| GET /ready                         | —                                                             | Readiness (service-specific configuration availability) |
| GET /session                       | —                                                             | SessionResponse                                         |
| POST /world/root/request           | `{}`                                                          | WorldProofRequest                                       |
| POST /world/root/verify            | VerifyWorldRequest                                            | SessionResponse + session cookie                        |
| GET /missions                      | —                                                             | MissionListResponse                                     |
| POST /missions                     | CreateMissionRequest                                          | MissionDetailResponse (201)                             |
| GET /missions/:id                  | —                                                             | MissionDetailResponse                                   |
| POST /missions/:id/authorize       | AuthorizeMissionRequest `{approvedCapabilities:Capability[]}` | MissionDetailResponse                                   |
| POST /missions/:id/run             | `{}`                                                          | MissionDetailResponse                                   |
| POST /missions/:id/revoke          | `{}`                                                          | MissionDetailResponse                                   |
| POST /actions/:id/approval/request | `{}`                                                          | ApprovalRequestResponse                                 |
| POST /actions/:id/approval/verify  | VerifyWorldRequest                                            | MissionDetailResponse                                   |
| POST /actions/:id/approval/cancel  | `{}`                                                          | MissionDetailResponse                                   |
| POST /actions/:id/confirm          | `{}`                                                          | MissionDetailResponse (consequential only)              |
| POST /actions/:id/execute          | `{}`                                                          | ExecutionReceipt                                        |

WorldProofRequest supplies requestId, action, signal, rpContext, appId and environment. Store request IDs/challenges server-side and bind them to the current session/action; the proof alone cannot select an action. Lead may add requestId/provider wire fields after verifying official SDK protocol. A provider not configured returns an honest unavailable state; UI never simulates successful verification. Poll mission details for timeline updates until runtime streaming is integrated. Browser code imports types and schemas only; never imports backend adapters or secrets.

## Package convention

ES modules, Node 22.12.0, pnpm 10.12.4. Package names `@humanos/<directory>`, source exports for workspace consumers, `workspace:*` dependency ranges. Extend root tsconfig; scripts `test: vitest run`, `typecheck: tsc --noEmit`, optional build/dev. Root commands recurse. Keep package tests beside source under test/. Tests inject upstream transport only at provider boundaries, never authorize production using fixtures.
