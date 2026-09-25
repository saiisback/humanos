### Task 6: World IDKit root establishment

**Files:**

- Create: `packages/world/src/idkit/sign-request.ts`, `verify-proof.ts`, `nullifier.ts`
- Create: `apps/api/src/routes/world/idkit-sign.ts`, `idkit-verify.ts`
- Test: `packages/world/test/idkit.test.ts`

**Interfaces:**

- Produces `createSignedProofRequest(action, signal)` and `verifyRootProof(payload)`.

- [ ] Register the event app and record non-secret IDs in typed configuration.
- [ ] Write failing tests for valid proof, invalid proof, wrong environment, signal mismatch, duplicate nullifier, cancellation, and upstream failure.
- [ ] Implement backend RP signing and complete-payload verification following current IDKit 4.x docs.
- [ ] Store nullifiers atomically and create a root only after successful verification.
- [ ] Run tests and commit `feat: establish humanos roots with idkit`.
