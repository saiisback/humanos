# HumanOS Linear and Notion MCP Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Create a real Linear issue and Notion page from HumanOS, with scoped authorization, one exact confirmation and verified provider receipts.

**Architecture:** A fixed, audited MCP boundary feeds the existing ConnectorRegistry and durable workflow runner. Ship Linear first; reuse the same boundary for Notion after account-bound OAuth. Provider uncertainty is reconciled without replaying writes.

**Tech Stack:** TypeScript, official MCP TypeScript SDK (pin the compatible stable release at implementation), Hono, Valibot, PostgreSQL, React, Vitest, existing ENS authorization.

**Spec:** `docs/superpowers/specs/2026-09-27-linear-notion-mcp-design.md` (approved September 27, 2026).

## Global Constraints

- First release supports one issue or one page per execution. Batch creation, arbitrary MCP servers, deletion, sharing, assignment, comments, and database modifications are excluded.
- Only `https://mcp.linear.app/mcp` and `https://mcp.notion.com/mcp` are allowed.
- No Codex connector may execute on HumanOS's behalf.
- Existing agents must not silently gain these grants.
- A timeout or crash after dispatch becomes RECONCILIATION_REQUIRED and does not auto-create a second object.
- Provider creation without successful read-back is pending verification, not a confirmed success.
- Credentials from Codex, browser storage or another HumanOS account are never copied.
- No live success claim before this evidence exists. User must authorize the new service connections; no secrets in chat.
- Preserve existing email/JAW/browser changes and untracked `.claude/`; no unrelated cleanup or automatic push.

## Review Focus

- Concurrent confirmation requests must dispatch only once (Task 3).
- Revocation or reconnect between review and submit invalidates the old confirmation (Tasks 2–3).
- Provider tool/schema drift must stop execution instead of broadening authority (Task 1).
- OAuth callback replay, wrong account or refresh races must not cross account boundaries (Task 5).
- Malicious provider links/content must remain inert and bounded in receipts (Tasks 1 and 6).

## Shared interfaces and file boundaries

New `apps/api/src/workflows/mcp/` modules separate transport, credential handling and provider mapping. Existing adapters retain `ConnectorAdapter` and `ConnectorExecutionInput` contracts.

- `types.ts`: `McpProvider = 'linear' | 'notion'`; `CreatedObject = { id: string; url: string; destinationId: string; title: string; body: string }`; `ConnectionBinding = { connectionId: string; version: number; workspaceId: string; destinationId: string }`.
- `client.ts`: `createMcpClient(provider: McpProvider, getToken: () => Promise<string>): AuditedMcpClient`; methods `listDestinations(signal): Promise<Array<{id: string; label: string}>>`, `create(input: {destinationId: string; title: string; body: string}, signal): Promise<{id: string}>`, `read(id: string, signal): Promise<CreatedObject>`, `close(): Promise<void>`.
- `operations.ts`: fixed Valibot input/output schemas and audited definitions; `linear.issue.create` and `notion.page.create` only.
- `linear.ts`, `notion.ts`: provider-specific tool/schema mapping and `createLinearConnector` / `createNotionConnector`, returning existing `ConnectorAdapter`.
- `credentials.ts`, `oauth.ts`, `connection-routes.ts`: encrypted credentials, OAuth and authenticated connection management; never frontend credentials.
- `packages/database/src/mcp-connections.ts`: connection versioning and single-use OAuth state.
- `packages/database/src/mcp-dispatches.ts`: account-scoped dispatch journal and known-ID verification recovery.
- `apps/web/src/workflows/mcp-connection.tsx`: connection/destination controls, not a second workflow engine.

### Task 1: Audited transport and operation boundary

**Files:** Create `apps/api/src/workflows/mcp/{types,client,operations,linear}.ts`, `apps/api/test/mcp-client.test.ts`; modify `apps/api/src/workflows/connectors.ts`, `apps/api/package.json`, `pnpm-lock.yaml`.

**Interfaces:** Produces `AuditedMcpClient` and the fixed operations above; adapters continue consuming `ConnectorExecutionInput`.

- [ ] Read current official Linear MCP documentation and SDK transport guidance. Inspect documented/discovered tool contracts through HumanOS credentials only; check sanitized schema fixtures into `apps/api/test/fixtures/mcp/`. If exact contracts cannot be verified, mark that provider setup-required rather than inventing tool names.
- [ ] Write failing tests `rejectsUnknownEndpoint`, `rejectsChangedToolSchema`, `rejectsToolErrorAndOversizedResponse`, `rejectsUntrustedResultUrl`, `preservesResendAudit`. Assert unknown tools never call transport; bound results to 1 MiB; reject non-HTTPS or provider-unrelated receipt URLs.
- [ ] Run `pnpm --filter @humanos/api exec vitest run test/mcp-client.test.ts test/workflow-connectors.test.ts`; expect new tests to fail before implementation.
- [ ] Implement `createMcpClient` with official Streamable HTTP, timeout/cancellation and cleanup. Pin approved tool names and reviewed schemas; discovery does not grant rights. Replace email-only checks with immutable audited operation lookup, preserving exact schema identity and existing Resend behavior.
- [ ] Run the same tests; require PASS, then commit only Task 1 files: `feat: add audited MCP connector boundary`.

### Task 2: Persistent account-bound Linear connection

**Files:** Create `packages/database/migrations/0006_mcp_connections.sql`, `packages/database/src/mcp-connections.ts`, `packages/database/test/mcp-connections.test.ts`, `apps/api/src/workflows/mcp/connection-routes.ts`, `apps/api/test/mcp-connections.test.ts`; modify database exports/migration registration, `apps/api/src/workflows/{runtime,connection-status}.ts` and authenticated route mounting in `apps/api/src/app.ts`.

**Interfaces:** `McpConnectionStore.get(accountId, provider)`, `setDestination(accountId, provider, destinationId)`, `disconnect(accountId, provider)` return a versioned public binding or null; mutation increments version. Credentials remain private.

- [ ] Write failing tests for wrong-account access, inaccessible destination, absent key, disconnect/reconnect incrementing version, and destination changes invalidating old bindings. Assert another account cannot use the configured Linear key.
- [ ] Run database and API `mcp-connections.test.ts` through each package's Vitest command; require initial failures.
- [ ] Bind `LINEAR_API_KEY` to existing `CONNECTOR_ACCOUNT_ID`; verify workspace/team by provider reads. Add authenticated GET connections/destinations, POST destination and DELETE connection routes under `/api/workflows/mcp/:provider`; protect mutations using existing session/CSRF conventions. Return only public connection state.
- [ ] Run focused tests and existing connection-status tests; require PASS. Commit `feat: connect account-scoped Linear MCP`.

### Task 3: Durable writes and honest recovery

**Files:** Create `packages/database/migrations/0007_mcp_dispatches.sql`, `packages/database/src/mcp-dispatches.ts`, `packages/database/test/mcp-dispatches.test.ts`, `apps/api/test/mcp-dispatch.test.ts`; modify database exports/migration registration, provider adapters and `apps/api/src/workflows/{confirmations,runner}.ts` only where existing hooks need extension.

**Interfaces:** `McpDispatchStore.begin(accountId, idempotencyKey, requestHash, binding)` atomically claims once; `recordCreatedId(accountId, idempotencyKey, id)`, `recordVerified(accountId, idempotencyKey, object)` and `get(accountId, idempotencyKey)` persist recovery state. Same key/different hash is rejected.

- [ ] Write failing tests: simultaneous dispatch calls produce one create; timeout after dispatch produces zero automatic retries; crash after ID persistence permits read only; missing ID remains unresolved; read-back error is not success; changed binding or expired approval prevents dispatch.
- [ ] Run `pnpm --filter @humanos/api exec vitest run test/mcp-dispatch.test.ts` and database journal tests; expect failures.
- [ ] Implement transactional claim before network write and known-ID read-back recovery. Map uncertain outcomes to existing `UNKNOWN_OUTCOME` and a user-facing reconciliation-required state; do not introduce an error value unsupported by schemas. Match returned destination and sanitized fields before producing verified receipts. Recheck authorization immediately before dispatch.
- [ ] Run focused tests and existing workflow connector/confirmation tests; require PASS. Commit `feat: persist MCP write intent and verification receipts`.

### Task 4: Linear workflow routing and ENS scope

**Files:** Modify `packages/schemas/src/domain.ts`, `apps/api/src/workflows/{bindings,agents,agent-authorizer,runtime}.ts`, `packages/ens/src/workflow-agent.ts` where capability mapping requires it; add `apps/api/test/mcp-workflow.test.ts` and extend existing binding/agent tests. Locate all exhaustive capability mappings with `rg` and update them together.

**Interfaces:** Produces connector.call steps with `connectorId: 'linear'`, `operationId: 'linear.issue.create'`, exact destination/title/body arguments; capability is `linear.issue.create`, never `email.send`.

- [ ] Write failing tests: supplied issue notes select only issue creation; missing team asks a question; existing email-only agent is rejected; expired/revoked agent cannot dispatch; DeepSeek-generated content cannot choose tools or destinations.
- [ ] Run `pnpm --filter @humanos/api exec vitest run test/mcp-workflow.test.ts test/workflow-bindings.test.ts test/workflow-agent-runtime.test.ts`; expect new failures.
- [ ] Add deterministic bindings and finite Jev candidates; DeepSeek drafts content only. Existing ENS registration receives explicit new requested scope; no automatic grant expansion. Bind confirmation to account, connection version, workflow version, run, step and payload using existing confirmation machinery.
- [ ] Run focused tests plus schemas/ENS typechecks; require PASS. Commit `feat: route Linear tasks through ENS-scoped workflows`.

### Task 5: Notion OAuth and page adapter

**Files:** Create `apps/api/src/workflows/mcp/{credentials,oauth,notion}.ts`, `apps/api/test/{mcp-oauth,notion-mcp}.test.ts`; extend connection store/routes, runtime and Task 4 capability/binding mappings; document `MCP_TOKEN_ENCRYPTION_KEY` and callback configuration in `.env.example` without real values.

**Interfaces:** `beginNotionOAuth(accountId): Promise<{authorizationUrl: string}>`, `finishNotionOAuth(accountId, callback: URL): Promise<void>`; `createNotionConnector` returns ConnectorAdapter. Public routes POST `/api/workflows/mcp/notion/oauth/start` and authenticated GET `/api/workflows/mcp/notion/oauth/callback`.

- [ ] Read Notion's linked custom MCP-client documentation and official OAuth discovery/registration requirements. Record exact allowed authorization/token metadata endpoints and callback requirements before constructing requests; fail setup if the environment cannot satisfy them.
- [ ] Write failing tests for state replay/expiry/wrong account, PKCE mismatch, metadata redirect to private hosts, encrypted storage with no plaintext logs, concurrent refresh/disconnect, inaccessible parent and changed schema. Assert disconnect invalidates refresh and pending confirmations.
- [ ] Run `pnpm --filter @humanos/api exec vitest run test/mcp-oauth.test.ts test/notion-mcp.test.ts`; expect failures.
- [ ] Implement single-use 10-minute OAuth state, PKCE and encrypted tokens (AES-256-GCM with account/provider-bound associated data and independent configured key). Restrict discovery/token requests to reviewed provider endpoints; serialize refresh using stored version. Implement fixed page-create/read tools with `notion.page.create` capability and selected accessible parent. Do not use REST integration tokens as hosted MCP credentials.
- [ ] Run new tests and shared transport/dispatch tests; require PASS. Commit `feat: add account-bound Notion MCP OAuth and page creation`.

### Task 6: HumanOS connection, clarification and result UI

**Files:** Create `apps/web/src/workflows/mcp-connection.tsx`, `apps/web/src/workflows/mcp-connection.test.tsx`; modify `apps/web/src/workflows/{connections,workspace,workflow-review,completed-task}.tsx` and their tests; extend existing web API client/types as required by authenticated routes.

**Interfaces:** Consumes public connection status/destination routes and existing workflow confirmation endpoints; no direct browser-to-MCP calls.

- [ ] Write failing UI tests for disconnected/expired/revoked states, missing destination question, exact review showing provider/workspace/destination/title/body, one confirmation, pending read-back, and malicious Markdown/URL rendered safely. Assert no Done or clickable unvalidated link for uncertain outcomes.
- [ ] Run `pnpm --filter @humanos/web exec vitest run src/workflows/mcp-connection.test.tsx src/workflows/workflow-review.test.tsx`; expect failures.
- [ ] Implement Linear setup and Notion Connect controls, accessible destination selection, one exact confirmation and verified receipt links. Collapse technical details; keep existing usage reporting with provider fees unavailable. Use existing styling and responsive layout; no unrelated redesign.
- [ ] Run focused tests, then inspect desktop/mobile states without performing writes. Require no overflow and readable error/recovery actions. Commit `feat: expose Linear and Notion actions in HumanOS`.

### Task 7: Combined verification and live acceptance

**Files:** Create `docs/linear-notion-mcp.md`; update README connection instructions and retain sanitized acceptance evidence there.

- [ ] Run `pnpm test`, `pnpm typecheck`, `pnpm build`, and `git diff --check`. Record failures honestly: prior baseline has a Browser Use client lifecycle timeout; do not label it fixed without evidence.
- [ ] Review the complete diff for credential leakage, account boundaries, write replay, ENS expiry/revocation and preserved Brave/Resend behavior. Fix important findings with targeted regression tests before live writes.
- [ ] Ask user to configure the Linear key privately and complete Notion OAuth in HumanOS. Select destinations in-app. Do not copy this chat's credentials or invent connectivity.
- [ ] Through HumanOS, prepare a clearly labelled demo issue and demo page. User confirms each exact payload once. Execute and retrieve each through HumanOS; record actual IDs, URLs and verification timestamps, or the concrete blocker. No success based only on fixtures.
- [ ] Commit documentation/evidence without tokens or private content: `docs: record HumanOS MCP setup and acceptance`. Do not push or merge until requested.

## Execution recommendation

Native execution is recommended: these seven tasks share tight interfaces and one write-safety boundary, so a single implementer avoids coordination overhead. Perform an independent whole-branch review before live acceptance. The plan requires user review before implementation.
