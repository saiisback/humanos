### Task 1: Repository foundation and frozen contracts

**Files:**

- Create: `pnpm-workspace.yaml`, `package.json`, `tsconfig.base.json`, `.env.example`, `.gitignore`
- Create: `packages/schemas/src/domain.ts`, `packages/schemas/src/events.ts`, `packages/schemas/src/canonicalize.ts`
- Test: `packages/schemas/test/canonicalize.test.ts`

**Interfaces:**

- Produces `Mission`, `ActionProposal`, `Approval`, `ExecutionReceipt`, `AuditEvent`, `Capability`, `RiskLevel`, and `MissionState` schemas.
- Produces `canonicalize(value): string` and `hashCanonical(value): Hex`.

- [ ] Initialize Git and the pnpm workspace; pin Node and package-manager versions.
- [ ] Write failing tests proving object key order cannot change a canonical action hash and unsupported values are rejected.
- [ ] Implement schemas, canonical serialization, and SHA-256/Keccak helpers with one documented algorithm per use.
- [ ] Run `pnpm --filter @humanos/schemas test` and `pnpm typecheck`.
- [ ] Commit `chore: initialize humanos monorepo and domain contracts`.
