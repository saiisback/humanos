### Task 9: Flue durable HumanOS runtime

**Files:**

- Create: `apps/agent/src/agents/humanos.ts`, `hooks/use-mission.ts`, `hooks/use-capabilities.ts`, `app.ts`, `flue.config.ts`
- Test: `apps/agent/test/humanos.test.ts`, `recovery.test.ts`

**Interfaces:**

- Consumes model adapters, policy decisions, repositories, and tools.
- Exposes protected durable conversation routes and mission dispatch APIs.

- [ ] Initialize Flue 2.x using current official setup and `deepseek-flash` through a confirmed Pi/custom provider configuration.
- [ ] Write failing tests proving tools change with verified mission state and unauthorized conversations cannot be read or prompted.
- [ ] Implement the agent with schema-valid proposals, Jev assessment, policy authorization, and deterministic tool mounting.
- [ ] Add middleware for user authentication and conversation ownership.
- [ ] Write and pass restart/recovery tests with persisted mission state.
- [ ] Commit `feat: add durable flue humanos runtime`.
