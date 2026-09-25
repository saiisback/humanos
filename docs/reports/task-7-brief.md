### Task 7: ENSv2 identity and permissions

**Files:**

- Create: `packages/contracts/src/HumanOSRegistrar.sol`, `script/Deploy.s.sol`
- Create: `packages/contracts/test/HumanOSRegistrar.t.sol`
- Create: `packages/ens/src/register.ts`, `roles.ts`, `resolve.ts`, `authorize.ts`
- Test: `packages/ens/test/authorize.test.ts`

**Interfaces:**

- Produces root/task subname registration, scoped resolver record grants, revocation, expiry queries, and `readAgentAuthorization(name)`.

- [ ] Read deployed ENSv2 Sepolia addresses and current ABIs from official docs; store verified deployment metadata.
- [ ] Write failing Foundry tests for hierarchy, expiry, non-transferability, unauthorized mutation, role escalation, revocation, and renewal restrictions.
- [ ] Implement the smallest registrar/controller necessary to compose official Permissioned Registry, Permissioned Resolver, and EAC primitives.
- [ ] Grant task agents only argument-scoped status/receipt record permissions.
- [ ] Implement viem clients and authorization reads with finality requirements.
- [ ] Run `forge test -vvv` and package tests.
- [ ] Deploy to Sepolia, record addresses/transactions, verify source where supported, and commit `feat: add ensv2 humanos agent identities`.
