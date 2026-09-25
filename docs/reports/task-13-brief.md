### Task 13: Deployment, security validation, and submission package

**Files:**

- Create: `docker-compose.yml`, deployment configs, `docs/architecture.md`, `docs/threat-model.md`, `docs/demo-script.md`, `docs/deployment.md`, `docs/integration-debrief.md`
- Modify: `README.md`, `.env.example`

**Interfaces:**

- Produces the public demo, reproducible setup, evidence, and hackathon submission material.

- [ ] Deploy Postgres, API, Flue runtime, demo service, and web application with secrets in platform secret storage.
- [ ] Run dependency, secret, authorization, SSRF, path traversal, replay, and prompt-injection reviews.
- [ ] Run `pnpm format:check`, `pnpm lint`, `pnpm typecheck`, `pnpm test`, `forge test -vvv`, and `pnpm test:e2e`.
- [ ] Execute and screen-record the success, cancellation, expiry, revocation, and runtime-recovery journeys.
- [ ] Verify every public URL, Sepolia transaction, contract address, and repository link.
- [ ] Complete the World integration debrief with measured time-to-first-success, friction, missing capability, and one highest-impact improvement.
- [ ] Remove fake values, dead code, debug routes, exposed data, and unresolved placeholders.
- [ ] Commit `docs: finalize humanos deployment and hackathon submission`.
