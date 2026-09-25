# Final verification — 24 September 2026

**Local gate passed.** The final code run has335 unique TypeScript tests,26 Foundry tests and40 browser tests passing with no skips. Live sponsor qualification and full-stack public deployment are not established. No HumanOS Sepolia address or transaction exists to report; the official ENS addresses in the vendor manifest are not HumanOS deployments.

Environment: Node22.12.0, pnpm10.12.4, PostgreSQL17.11, Foundry1.8.3, Chromium/Playwright1.63.0. Local PostgreSQL listens on55432. `.env` is ignored and contains only task-local service credentials.

## Captured commands

| Command                                                                                                                                     | Result                                                                                                                       |
| ------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------- |
| `pnpm install --frozen-lockfile`                                                                                                            | PASS                                                                                                                         |
| `pnpm format:check`                                                                                                                         | PASS                                                                                                                         |
| `packages/contracts/script/forge.sh fmt --check` (from contracts directory: `./script/forge.sh fmt --check`)                                | PASS                                                                                                                         |
| `pnpm lint`                                                                                                                                 | PASS                                                                                                                         |
| `pnpm typecheck`                                                                                                                            | PASS across workspace                                                                                                        |
| `pnpm test`                                                                                                                                 | PASS:335 TypeScript tests plus26 Foundry tests; unit and integration suites                                                  |
| `pnpm test:contracts` → `forge test -vvv`                                                                                                   | PASS:26 tests,0 failed,0 skipped                                                                                             |
| `HUMANOS_LIVE_API=1 HUMANOS_RECORD=1 HUMANOS_RECORD_DIR=/Users/saikarthik/.codex/artifacts/humanos-final-acceptance-20260924 pnpm test:e2e` | PASS:40 tests in1.4minutes,0 skipped                                                                                         |
| `pnpm build`                                                                                                                                | PASS: contracts, library compilation, React/Flue bundles and API/service type validation; API/service run TypeScript via tsx |
| `pnpm calibrate`                                                                                                                            | PASS:9/9 synthetic threshold regressions; **not live calibration**                                                           |
| `pnpm audit --json`                                                                                                                         | PASS:0 known vulnerabilities at all severities                                                                               |
| `pnpm scan`                                                                                                                                 | PASS: repository credential-pattern and unfinished-implementation scan                                                       |
| `pnpm db:migrate`                                                                                                                           | PASS against the prepared PostgreSQL instance                                                                                |
| Browser bundle search for backend credential variable names                                                                                 | PASS:no matches                                                                                                              |
| API/Flue/protected-service health requests                                                                                                  | PASS:all returned200 with status ok                                                                                          |

TypeScript counts: schemas20, policy163, database12, models20, World9, ENS48, tools8, Flue15, API38 and protected service2. Test discovery excludes generated `dist` copies; schemas/models builds now exclude test sources. Earlier duplicate compiled-suite counts are not included.

Raw local logs: `/tmp/humanos-format-final.log`, `/tmp/humanos-forge-format.log`, `/tmp/humanos-lint-final.log`, `/tmp/humanos-typecheck-final.log`, `/tmp/humanos-tests-final.log`, `/tmp/humanos-foundry-final.log`, `/tmp/humanos-e2e-final.log`, `/tmp/humanos-build-final.log`, `/tmp/humanos-audit-final.json`, `/tmp/humanos-calibration-final.json`, `/tmp/humanos-scan-final.log`, `/tmp/humanos-migrate-final.log` and `/tmp/humanos-install-final.log`. They are local temporary evidence, not portable CI artifacts. Source is published at [saiisback/humanos](https://github.com/saiisback/humanos).

## Browser and required journeys

See [browser verification](reports/browser-verification.md) for recording commands, individual WebM links, screenshots and fixture boundaries. The final post-journal acceptance rerun is in `/Users/saikarthik/.codex/artifacts/humanos-final-acceptance-20260924`. Prior recordings remain preserved separately.

| Journey                             | Local evidence                                                                                                                                            |
| ----------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Successful application and calendar | Built React UI → actual API/policy/executor/PostgreSQL; receipts and idempotent replay; desktop and mobile                                                |
| Denied/cancelled approval           | Wrong proof rejection in API/World tests; pending and already-verified cancellation in browser; no side effect                                            |
| Expired agent/approval              | Policy and real-Anvil hierarchy expiry tests; expired approval denied in browser                                                                          |
| Revoked agent                       | Actual ENSv2 role/hierarchy revocation tests and mid-read race regression; browser refusal and safe reconciliation of prior effects                       |
| Restart/recovery                    | Actual Flue runtime stop/recreation with PostgreSQL and fixture model; database/client restart of pending ENS transactions; browser session/action reload |
| ENS receipt publication             | Canonical append-preserving commitments, finalized inclusion required, pending/retry browser states; no repeated application effect                       |

The browser suite comprises18 actual-API/PostgreSQL checks,2 untouched local API readiness checks and20 intercepted-HTTP UI/accessibility checks, across desktop/mobile. External World, ENS, model, Flue-dispatch and side-effect transports in the backend browser harness are explicit fixtures. The World device ceremony is not live. Real ENSv2 contracts and PostgreSQL journal recovery are exercised separately by ENS integration tests. Neither a fixture proof nor an Anvil deployment qualifies as a live sponsor integration.

Flue recovery uses the real runtime and PostgreSQL adapter around durable accepted work with a fixture model transport. The production Flue build also booted successfully and rejected unauthenticated conversation access. Browser reload is not presented as process recovery. A credentialed killed-process judge journey remains an acceptance step.

## Reviews, repairs and limitations

The [independent final review](reports/final-review.md) reports no unresolved actionable critical/high finding in reviewed paths through `e85caab`. See also [contract review](reports/contracts-review.md), [ENS/model review history](reports/ens-model-review.md), [API review](reports/api-security-review.md) and [threat model](threat-model.md).

Resolved findings include fixed-action/signal-bound same-human World verification, refreshable pending challenges, cancellation after verification, receipt reconciliation, final audit decisions, fresh pinned ENS head/role checks, exact registration retry matching, durable signed-transaction journaling before broadcast, stable funding intents and separate database pools. Ambiguous ENS retries use the same signed bytes/hash/nonce; pending transactions are not silently replaced.

The first concurrent recording attempt failed on timeouts and a watch-server restart. Those artifacts remain preserved; the final stable-server one-worker run passed. Early lint/type/format findings were repaired. Foundry26, ENS48 and all final aggregate checks passed after corrections.

The secret scan is pattern-based, not proof that every possible secret format is absent. Browser bundles contain no backend credential variable names. `.env` was never tracked in Git. Public deterministic Anvil test keys are fixtures. Builds emit Flue directive/bundle-size guidance and package installation reports a Babel peer-version warning; production boot and runtime tests passed. Docker was not installed, so Compose images were not built/launched. No CI run on a remote host is claimed.

Document/draft gateway primitives are tested library boundaries; the current Flue runtime mounts only the proposal-preparation tool, and there is no document-upload product flow. Application/calendar effects use the owned durable development service, not an external organizer or Google Calendar. ENS ownership is operator-custodied in this MVP. These scope limits are not concealed by test fixtures.

## Live acceptance still required

- World app/RP credentials and real Proof of Human: root, fresh same-human approval and denied/expired outcomes.
- Funded ENSv2 Sepolia parent/operator and HumanOS deployment: hierarchy, scoped writes, finality, revocation and receipts.
- DeepSeek/TypeSafe keys: live proposals/typed assessments and measured Jev calibration.
- Hosting, DNS/TLS and persistent infrastructure: public full-stack deployment and URL checks.
- Organizer acceptance of the documented World HITL protocol adaptation to Flue.

Exact variables, manual steps and resume commands are in [deployment](deployment.md). No missing integration is replaced by a successful fixture path in the running application.
