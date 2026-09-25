# JAW + World Chat Workspace Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship one responsive HumanOS chat workspace in which a JAW passkey account authenticates with SIWE, World PoH binds one human root to that account, ENSv2 agents use the JAW address as root owner, and sensitive work remains protected by existing policy and World approval.

**Architecture:** Add a narrow server-side SIWE module and account/root-binding persistence before changing any existing authorization route. Wrap the JAW browser provider behind an application adapter, then replace the monolithic dashboard with semantic conversation objects that call the existing mission/action routes. Keep provider output advisory, server sessions authoritative, and all external integrations fail-closed.

**Tech Stack:** TypeScript 5.8, React 19, Vite 8, Hono 4, PostgreSQL 17, Valibot 1.5, viem 2.56.8, `@jaw.id/core` 1.1.4, World IDKit 4.3.0, Vitest 4, Playwright 1.63, Foundry/Solidity 0.8.25.

**Spec:** `docs/superpowers/specs/2026-09-25-jaw-world-chat-design.md`

## Global Constraints

- Build one responsive web application for desktop and phone; do not add Expo in this slice.
- JAW authenticates account control; PoH gates creation of one human-backed root and agent namespace.
- World, model, ENS signer and backend secrets remain server-only; only documented JAW client configuration may use a Vite public variable.
- Do not silently fall back to an injected wallet, synthetic provider result or fixture when an integration is unavailable.
- Existing roots and ENS identities are not automatically migrated or reinterpreted.
- JAW permissions constrain onchain calls only; email/calendar/application permissions remain HumanOS/provider policy.
- Every protected effect remains subject to current canonical binding, deterministic policy, current ENS authorization, approval consumption and idempotency behavior.
- Preserve the pre-existing untracked `docs/superpowers/specs/2026-09-25-humanos-native-design.md` file.
- Use TDD for production behavior: observe the focused test fail for the intended reason before implementation.

## Review Focus

- A SIWE message with a correct signature but wrong domain, URI or chain must fail without consuming a valid challenge; covered in Task 2 API tests.
- Two concurrent attempts to bind one World root to different accounts must yield one binding and one conflict; covered in Task 3 database/API tests.
- A returning account with no PoH or cancelled PoH must remain signed in but cannot create/authorize a mission; covered in Tasks 3 and 6.
- A JAW permission response whose account, chain, expiry or reviewed constraints differ from the request must not be recorded; covered in Task 7.
- The fixed composer and sheets must not hide content, trap focus or overflow at 320px and 200% zoom; covered in Task 8 Playwright/accessibility tests.

---

## File structure

### Shared contracts and persistence

- Modify `packages/schemas/src/domain.ts`: add wallet account, root binding and reviewed JAW permission schemas.
- Modify `packages/schemas/src/api.ts`: add auth/session, SIWE and permission request/response schemas.
- Modify `packages/schemas/src/index.ts`: export new contracts if not already re-exported.
- Modify `packages/database/src/schema.ts`: register new tables and nullable-root authenticated sessions.
- Modify `packages/database/src/index.ts`: add atomic root/account binding method.
- Modify `packages/database/migrations/0001_initial.sql`: create idempotent account, binding and permission tables/indexes.
- Add `packages/database/test/account-binding.test.ts`: persistence invariants and concurrency coverage.

### Backend authentication and identity

- Create `apps/api/src/services/siwe.ts`: SIWE challenge/message validation interface and viem adapter.
- Modify `apps/api/src/app.ts`: JAW auth routes, session shape, account middleware and PoH binding.
- Modify `apps/api/src/server.ts`: construct production SIWE verifier and expose JAW readiness.
- Modify `apps/api/package.json`: add pinned `viem` dependency.
- Add `apps/api/test/siwe-auth.test.ts`: success, replay, expiry, origin, chain and signature tests.
- Modify `apps/api/test/auth.test.ts`: authenticated-but-unverified and verified-root route expectations.

### ENS ownership

- Modify `apps/api/src/app.ts`: provide bound JAW owner to mission authorization.
- Modify `packages/ens/src/adapter.ts`: accept the mission/root owner through the adapter interface instead of silently defaulting it.
- Modify `packages/ens/test/authorize.test.ts`: prove the JAW address becomes root owner while registrar roles remain scoped.
- Modify `apps/api/test/auth.test.ts`: prove authorization passes the bound owner.

### Browser integration and UI

- Modify `apps/web/package.json`: add pinned `@jaw.id/core`.
- Create `apps/web/src/auth/jaw.ts`: JAW provider adapter for SIWE connect/disconnect.
- Create `apps/web/src/auth/use-auth.ts`: application auth state and backend round trip.
- Create `apps/web/src/identity/world-verification.tsx`: PoH widget wrapper.
- Create `apps/web/src/chat/types.ts`: semantic transcript item union.
- Create `apps/web/src/chat/transcript.tsx`: conversation renderers.
- Create `apps/web/src/chat/composer.tsx`: task composer.
- Create `apps/web/src/chat/mission-flow.ts`: map server mission detail to transcript objects.
- Create `apps/web/src/shell/app-shell.tsx`: responsive shell, rail and sheets.
- Create `apps/web/src/permissions/jaw-permissions.ts`: client grant/get/revoke adapter.
- Create `apps/web/src/permissions/permission-review.tsx`: reviewed grant UI.
- Rewrite `apps/web/src/main.tsx`: orchestration only.
- Rewrite `apps/web/src/style.css`: reference-driven responsive visual system.
- Modify `apps/web/DESIGN.md` and `apps/web/PRODUCT.md`: record final interaction rules.

### Verification

- Modify `tests/e2e/fixtures.ts`: new account/session transcript fixtures.
- Modify existing `tests/e2e/*.spec.ts`: chat selectors and behavior.
- Add `tests/e2e/auth-chat.spec.ts`: JAW, PoH and chat flow.
- Add `tests/e2e/responsive.spec.ts`: 320px, phone and desktop layout assertions.
- Modify `.env.example`, `README.md`, `docs/deployment.md`, `docs/demo-script.md` and `docs/verification.md`: exact configuration and evidence boundaries.

---

### Task 1: Account, binding and permission contracts

**Files:**

- Modify: `packages/schemas/src/domain.ts`
- Modify: `packages/schemas/src/api.ts`
- Modify: `packages/database/src/schema.ts`
- Modify: `packages/database/src/index.ts`
- Modify: `packages/database/migrations/0001_initial.sql`
- Create: `packages/database/test/account-binding.test.ts`

**Interfaces:**

- Produces: `WalletAccount`, `RootAccountBinding`, `JawPermissionGrant`, `AuthSessionResponse`, `CreateSiweChallengeResponse`, `VerifySiweRequest`.
- Produces: `Transaction.bindRootAccount(rootId: string, accountId: string, now: Date): Promise<RootAccountBinding>`.
- Changes: `SessionRecord.rootId` becomes nullable and adds non-null `accountId` for new JAW sessions; legacy test records are upgraded in their fixtures.

- [ ] **Step 1: Write failing schema and database tests**

Add tests that parse this exact authenticated session shape and reject malformed addresses/chains:

```ts
const account: WalletAccount = {
  id: "11155111:0x1111111111111111111111111111111111111111",
  address: "0x1111111111111111111111111111111111111111",
  chainId: 11155111,
  createdAt: stamp,
};
await db.insert("accounts", account);
await db.insert("sessions", {
  id: hashCanonical("token"),
  accountId: account.id,
  rootId: null,
  expiresAt: future,
});
```

Test `bindRootAccount` twice for the same pair (idempotent), then attempt a different account for the same root and a different root for the same account (both conflict). Use two concurrent database transactions and assert only one incompatible binding can commit.

- [ ] **Step 2: Run focused tests and verify RED**

Run: `pnpm --filter @humanos/database test -- account-binding.test.ts`

Expected: FAIL because the new tables/types and `bindRootAccount` do not exist.

- [ ] **Step 3: Add exact shared schemas**

Implement strict Valibot schemas with these fields:

```ts
WalletAccount = { id, address: /^0x[0-9a-f]{40}$/, chainId: positive integer, createdAt }
RootAccountBinding = { id, rootId, accountId, createdAt }
JawPermissionGrant = {
  id, accountId, chainId, permissionId, status: "ACTIVE" | "REVOKED" | "EXPIRED",
  targets: address[], functions: string[], spends: { token, allowance, period }[],
  expiresAt, createdAt, revokedAt
}
```

Add API contracts for nonce `{ challengeId, nonce, expiresAt, chainId, domain, uri }`, verification `{ challengeId, message, signature }`, and session `{ account, root, jawConfigured }`.

- [ ] **Step 4: Add idempotent persistence and atomic binding**

Create `accounts`, `root_bindings` and `jaw_permissions` JSON tables. Add generated `root_id` and `account_id` columns with unique indexes on both binding columns. Implement `bindRootAccount` with `SELECT ... FOR UPDATE` on root and account records, returning the existing exact binding and throwing `ROOT_ACCOUNT_CONFLICT` otherwise.

- [ ] **Step 5: Run focused and dependent tests**

Run: `pnpm --filter @humanos/schemas test && pnpm --filter @humanos/database test`

Expected: PASS with the new invariant tests and existing transaction tests.

- [ ] **Step 6: Commit**

```bash
git add packages/schemas packages/database
git commit -m "feat(auth): add wallet account and root binding records"
```

### Task 2: Server-side JAW SIWE authentication

**Files:**

- Create: `apps/api/src/services/siwe.ts`
- Create: `apps/api/test/siwe-auth.test.ts`
- Modify: `apps/api/src/app.ts`
- Modify: `apps/api/src/server.ts`
- Modify: `apps/api/package.json`
- Modify: `pnpm-lock.yaml`

**Interfaces:**

- Consumes: Task 1 auth schemas and account/session tables.
- Produces: `SiweVerifier.verify(input): Promise<{ address: Address; chainId: number }>`.
- Produces routes: `POST /api/auth/siwe/nonce`, `POST /api/auth/siwe/verify`, `POST /api/auth/logout`, `GET /api/auth/session`.

- [ ] **Step 1: Write failing route tests**

Inject a `SiweVerifier` fake that validates the message supplied by each test, not a boolean result. Cover:

```ts
await requestNonce();
await verify({ challengeId, message, signature }); // 200 + HttpOnly cookie
await verify({ challengeId, message, signature }); // 403 replay
```

Add separate wrong-domain, wrong-URI, wrong-chain, expired-message, expired-challenge and invalid-signature cases. Assert an invalid attempt does not consume a still-valid challenge unless it contains a correctly verified signature for the wrong required context; all failures issue no session.

- [ ] **Step 2: Run focused test and verify RED**

Run: `pnpm --filter @humanos/api test -- siwe-auth.test.ts`

Expected: FAIL with missing routes/module.

- [ ] **Step 3: Implement the SIWE module**

Expose a dependency-injected verifier that parses with `parseSiweMessage`, validates normalized domain, URI, nonce, chain ID, issued-at and expiration, then calls viem `verifySiweMessage` through a Sepolia public client so ERC-1271 smart-account signatures are supported. Never accept address/account data outside the verified message.

The configured allowlist is `[11155111]` for the ENSv2 beta flow. The production adapter reads `SEPOLIA_RPC_URL`; missing RPC makes JAW backend verification unavailable rather than switching chains.

- [ ] **Step 4: Implement nonce and session routes**

Generate a 16-byte URL-safe nonce and five-minute challenge bound to a random HttpOnly `humanos_auth_challenge` cookie. Verify origin/URI against `WEB_ORIGIN`, consume the challenge and create the wallet account/session in one transaction. Session tokens are 32 random bytes; only their canonical hash is stored.

- [ ] **Step 5: Run API tests**

Run: `pnpm --filter @humanos/api test`

Expected: PASS, including legacy authentication tests updated to create account-bound sessions.

- [ ] **Step 6: Commit**

```bash
git add apps/api package.json pnpm-lock.yaml
git commit -m "feat(auth): authenticate JAW accounts with SIWE"
```

### Task 3: Bind PoH roots to authenticated accounts

**Files:**

- Modify: `apps/api/src/app.ts`
- Modify: `apps/api/test/auth.test.ts`
- Create: `apps/api/test/root-binding.test.ts`
- Modify: `packages/world/test/verification.test.ts`

**Interfaces:**

- Consumes: account-bound `SessionRecord` and `bindRootAccount`.
- Changes: `/api/world/root/request` requires a valid JAW session and binds the challenge to `session.id` plus `accountId`.
- Changes: `/api/world/root/verify` returns `AuthSessionResponse` and upgrades the same session with `rootId`.

- [ ] **Step 1: Write failing root-link tests**

Test that an authenticated session with `rootId: null` can request PoH, while no session cannot. On verified proof, assert the root binding points to the session account and `GET /api/auth/session` returns both. Attempt the same nullifier from a second account and assert `409 ROOT_ACCOUNT_CONFLICT`. Run concurrent verification attempts against distinct accounts and assert exactly one binds.

Also assert World cancellation is a client action that leaves the JAW session intact and does not create a root/binding.

- [ ] **Step 2: Run focused tests and verify RED**

Run: `pnpm --filter @humanos/api test -- root-binding.test.ts`

Expected: FAIL because World routes do not require or bind an account.

- [ ] **Step 3: Implement account-bound World challenges**

Store `{ kind: "root", sessionId, accountId, ownerHash, request, expiresAt }`. During verification, lock/validate the live session, consume the challenge, claim/load the nullifier, call `bindRootAccount`, and update that session with the root ID in the same transaction.

Do not retain proof bytes or overwrite an incompatible binding. Preserve the current official v4 backend verification.

- [ ] **Step 4: Protect mission creation/authorization by linked root**

Session middleware distinguishes `UNAUTHENTICATED` from `HUMAN_VERIFICATION_REQUIRED`. Read-only session/readiness routes remain accessible; mission and action routes require a non-null root linked to the session account.

- [ ] **Step 5: Run World/API tests**

Run: `pnpm --filter @humanos/world test && pnpm --filter @humanos/api test`

Expected: PASS with no proof bytes in persisted/audit records.

- [ ] **Step 6: Commit**

```bash
git add apps/api packages/world
git commit -m "feat(identity): bind World roots to JAW accounts"
```

### Task 4: Make the JAW account the new ENS root owner

**Files:**

- Modify: `apps/api/src/app.ts`
- Modify: `apps/api/test/root-binding.test.ts`
- Modify: `packages/ens/src/adapter.ts`
- Modify: `packages/ens/test/authorize.test.ts`

**Interfaces:**

- Changes: `EnsAdapter.register(mission, rootOwner)` requires a checksummed/lowercase-normalized EVM address.
- Changes: `createHumanOSEnsAdapter.register` uses the passed `rootOwner`; no production call silently substitutes the operator.

- [ ] **Step 1: Write failing adapter/API tests**

Create a bound account, authorize a mission, capture `ens.register` arguments and expect the normalized JAW address. In the Anvil adapter test, register with a distinct JAW address and assert `HUMANOS_REGISTRY.getOwner(rootLabelId)` equals it while registrar root roles remain held only by the registrar contract.

- [ ] **Step 2: Run focused tests and verify RED**

Run: `pnpm --filter @humanos/ens test -- authorize.test.ts && pnpm --filter @humanos/api test -- root-binding.test.ts`

Expected: FAIL because `register` currently receives only the mission and defaults root ownership to operator.

- [ ] **Step 3: Require explicit root owner**

Change the adapter interface and all real/test adapters. Mission authorization loads the current session account binding and passes its address. Reject a missing/incompatible binding before the ENS call.

- [ ] **Step 4: Run ENS, API and contract tests**

Run: `pnpm --filter @humanos/ens test && pnpm --filter @humanos/api test && pnpm --filter @humanos/contracts test`

Expected: PASS; contract role tests still prove root owners cannot mutate locked registries/resolvers.

- [ ] **Step 5: Commit**

```bash
git add apps/api packages/ens
git commit -m "feat(ens): assign new roots to JAW accounts"
```

### Task 5: JAW browser adapter and sign-in experience

**Files:**

- Modify: `apps/web/package.json`
- Modify: `pnpm-lock.yaml`
- Create: `apps/web/src/auth/jaw.ts`
- Create: `apps/web/src/auth/use-auth.ts`
- Create: `apps/web/src/auth/jaw.test.ts`
- Modify: `apps/web/src/main.tsx`
- Modify: `.env.example`

**Interfaces:**

- Consumes: Task 2 auth routes/contracts.
- Produces: `JawAuthClient.connect(challenge): Promise<{ message; signature }>` and `disconnect(): Promise<void>`.
- Produces: `useAuth()` state `{ status, account, root, jawConfigured, signIn, signOut, refresh }`.

- [ ] **Step 1: Write failing adapter tests**

Inject an EIP-1193 provider and assert `connect` calls:

```ts
provider.request({
  method: "wallet_connect",
  params: [
    {
      capabilities: {
        signInWithEthereum: {
          nonce,
          chainId: "0xaa36a7",
          domain,
          uri,
          statement,
          expirationTime: expiresAt,
        },
      },
    },
  ],
});
```

Assert missing SIWE capability, rejected passkey and mismatched returned account produce typed failures and never call `/api/auth/siwe/verify`.

- [ ] **Step 2: Run focused test and verify RED**

Run: `pnpm --filter @humanos/web test -- jaw.test.ts`

Expected: FAIL because the adapter/test script does not exist.

- [ ] **Step 3: Add pinned JAW SDK and adapter**

Install `@jaw.id/core@1.1.4`, add `"test": "vitest run"` to the web package scripts, and use the workspace Vitest version for adapter tests. Create JAW only when `VITE_JAW_API_KEY` is present, with app name `HumanOS`, Sepolia default chain and configured public app origin/logo. Extract the SIWE response from the verified account capability exactly as documented. Keep SDK/provider payloads inside the adapter.

- [ ] **Step 4: Implement the auth hook and temporary minimal UI**

The hook requests a nonce, opens JAW, posts message/signature, refreshes the server session and handles logout. Render a minimal sign-in state in `main.tsx` only until Task 6 replaces the shell. Do not restore generic `window.ethereum` behavior.

- [ ] **Step 5: Run web tests/typecheck**

Run: `pnpm --filter @humanos/web test && pnpm --filter @humanos/web typecheck`

Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add apps/web .env.example pnpm-lock.yaml
git commit -m "feat(web): sign in with JAW passkeys"
```

### Task 6: Generate and implement the responsive chat interface

**Files:**

- Create: generated mobile and desktop visual references through the image-generation workflow.
- Create: `apps/web/src/chat/types.ts`
- Create: `apps/web/src/chat/mission-flow.ts`
- Create: `apps/web/src/chat/transcript.tsx`
- Create: `apps/web/src/chat/composer.tsx`
- Create: `apps/web/src/identity/world-verification.tsx`
- Create: `apps/web/src/shell/app-shell.tsx`
- Rewrite: `apps/web/src/main.tsx`
- Rewrite: `apps/web/src/style.css`
- Modify: `apps/web/DESIGN.md`
- Modify: `apps/web/PRODUCT.md`
- Add: `apps/web/src/chat/mission-flow.test.ts`

**Interfaces:**

- Consumes: Tasks 2-5 session/auth flows and existing mission/action endpoints.
- Produces: `buildTranscript(detail, readiness): TranscriptItem[]` where the discriminated union covers human, agent, progress, identity, mandate, ENS, approval, denial and receipt items.

- [ ] **Step 1: Generate two implementation references before frontend code**

Using the supplied artwork as mood/layout input, generate one standalone mobile HumanOS chat screen and one standalone desktop HumanOS chat screen. Required visible states: warm-white shell, minimal top bar, HumanOS mark, conversational mission review, PoH prompt, sensitive approval block and bottom composer. Avoid dashboard card grids, gradients, glass effects and copied branding/text from the supplied image.

Inspect both images at original detail and record typography, spacing, component dimensions, breakpoints and signature interactions in `apps/web/DESIGN.md` before editing React/CSS.

- [ ] **Step 2: Write failing transcript mapping tests**

Given `PROPOSED`, expect a mandate review item. Given `AWAITING_APPROVAL`, expect an action-review item containing the exact payload hash and human-readable effect. Given `REJECTED`, `REVOKED` or a receipt, expect the corresponding terminal item. Assert unknown or absent provider data never becomes a success item.

- [ ] **Step 3: Run focused test and verify RED**

Run: `pnpm --filter @humanos/web test -- mission-flow.test.ts`

Expected: FAIL because transcript types/mapping do not exist.

- [ ] **Step 4: Implement semantic transcript modules**

Keep network calls in `main.tsx`/hooks and render-only behavior in transcript components. The composer creates a mission from the first task message; subsequent server state becomes transcript items. Mission authorization, run, approval request/cancel, execution and revocation remain explicit user actions using existing endpoints.

- [ ] **Step 5: Implement PoH as an inline trust gate**

Wrap `IDKitRequestWidget` in `world-verification.tsx`. Show it after JAW sign-in when root is absent, without replacing the entire shell. Closing the root widget does not log the user out. Closing an action-approval widget still calls the existing cancellation route when verification did not succeed.

- [ ] **Step 6: Implement responsive shell and visual system**

Use CSS custom properties for warm white, charcoal, muted surfaces, border and focus colors. Phone is one `100dvh` column with safe-area padding and 44px targets; sheets hold missions/identity/connections. Desktop centers a 760-880px conversation with a collapsible 260px rail above 1100px. The composer is sticky without covering the final message; reserve its measured block space in the scroller.

- [ ] **Step 7: Run web unit/type checks**

Run: `pnpm --filter @humanos/web test && pnpm --filter @humanos/web typecheck`

Expected: PASS with no React key, nesting or accessibility warnings.

- [ ] **Step 8: Commit**

```bash
git add apps/web
git commit -m "feat(web): replace dashboard with responsive agent chat"
```

### Task 7: JAW permission review, record and revoke

**Files:**

- Create: `apps/web/src/permissions/jaw-permissions.ts`
- Create: `apps/web/src/permissions/jaw-permissions.test.ts`
- Create: `apps/web/src/permissions/permission-review.tsx`
- Modify: `apps/web/src/chat/transcript.tsx`
- Modify: `apps/api/src/app.ts`
- Create: `apps/api/test/jaw-permissions.test.ts`

**Interfaces:**

- Produces client methods `grant(reviewed)`, `list()`, `revoke(permissionId)` wrapping `wallet_grantPermissions`, `wallet_getPermissions` and `wallet_revokePermissions`.
- Produces backend routes `GET /api/jaw/permissions`, `POST /api/jaw/permissions/record`, `POST /api/jaw/permissions/:id/revoke`.

- [ ] **Step 1: Write failing client and server tests**

Client tests assert the exact reviewed chain, account, calls, spends and expiry are sent to JAW. Server tests reject changed account/chain, unknown target/function, non-decimal or negative allowance, expiry beyond the mission, duplicate permission IDs with different constraints and revocation by another account.

- [ ] **Step 2: Run focused tests and verify RED**

Run: `pnpm --filter @humanos/web test -- jaw-permissions.test.ts && pnpm --filter @humanos/api test -- jaw-permissions.test.ts`

Expected: FAIL with missing adapters/routes.

- [ ] **Step 3: Implement client permission adapter**

Normalize all addresses to lowercase for comparison, preserve original permission IDs, and require returned account/chain/expiry to match the reviewed request before posting the record to the backend. A provider rejection returns `CANCELLED` and records nothing.

- [ ] **Step 4: Implement reviewed-grant persistence**

Parse strict shared schemas, require the authenticated account, and store normalized constraints. `record` is idempotent only for the exact same permission ID and canonical constraints. `revoke` changes only an active grant belonging to the session account after the wallet operation reports success.

- [ ] **Step 5: Render permission review in the transcript**

Show targets/functions, allowance/period and expiry in plain language with `Grant permission` and `Cancel`. Existing offchain mission capabilities never fabricate a JAW permission request; the block appears only for an actual onchain mandate.

- [ ] **Step 6: Run API/web tests and typecheck**

Run: `pnpm --filter @humanos/api test && pnpm --filter @humanos/web test && pnpm typecheck`

Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add apps/api apps/web packages/schemas packages/database
git commit -m "feat(permissions): review and track JAW grants"
```

### Task 8: Responsive browser journeys and final verification

**Files:**

- Modify: `tests/e2e/fixtures.ts`
- Modify: `tests/e2e/success.spec.ts`
- Modify: `tests/e2e/denied.spec.ts`
- Modify: `tests/e2e/revoked.spec.ts`
- Modify: `tests/e2e/recovery.spec.ts`
- Modify: `tests/e2e/accessibility.spec.ts`
- Create: `tests/e2e/auth-chat.spec.ts`
- Create: `tests/e2e/responsive.spec.ts`
- Modify: `.env.example`
- Modify: `README.md`
- Modify: `docs/deployment.md`
- Modify: `docs/demo-script.md`
- Modify: `docs/verification.md`

**Interfaces:**

- Consumes the completed application; produces evidence only.

- [ ] **Step 1: Update fixtures and write failing end-to-end assertions**

Fixture the new `/api/auth/session`, SIWE and account-bound World paths. Add journeys for sign-in rejection, authenticated/no-PoH exploration, PoH cancellation, mission authorization, sensitive cancellation, success receipt and revoked denial. Label every intercepted result synthetic.

For layout, assert at 320x700, iPhone 13 and Desktop Chrome:

```ts
expect(
  await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth),
).toBe(true);
await expect(
  page.getByRole("textbox", { name: /task|message/i }),
).toBeInViewport();
await expect(page.getByRole("main")).toBeVisible();
```

At 200% zoom-equivalent viewport, open/close each sheet using keyboard, assert focus returns to its trigger and run Axe without serious/critical violations.

- [ ] **Step 2: Run focused browser tests and verify RED**

Run: `pnpm test:e2e -- auth-chat.spec.ts responsive.spec.ts accessibility.spec.ts`

Expected: FAIL until selectors/fixtures and layout behavior match the new interface.

- [ ] **Step 3: Fix only application/fixture gaps exposed by the tests**

Do not weaken assertions to match broken layout. Ensure the scroller reserves composer space, long ENS names/hashes wrap, sheets trap/restore focus and all async states announce through `role=status` or `role=alert`.

- [ ] **Step 4: Document exact configuration**

Add `VITE_JAW_API_KEY` and explain that it is JAW's documented browser app configuration. Document `SEPOLIA_RPC_URL` as required for backend smart-account signature verification. State that an OpenCode/gateway key is not accepted until its endpoint, auth scheme and model mapping are known; existing `DEEPSEEK_API_KEY` and `JEV_API_KEY` remain the supported paths.

- [ ] **Step 5: Run full verification**

Run in order:

```bash
pnpm format:check
pnpm lint
pnpm typecheck
pnpm test
pnpm test:e2e
pnpm build
pnpm test:contracts
pnpm scan
pnpm audit
```

Expected: every command exits 0. If a credentialed provider is absent, readiness tests must show unavailable; they must not fail into fixtures.

- [ ] **Step 6: Inspect the rendered app**

Open desktop and mobile pages, compare against the generated references, inspect empty, active conversation, approval, denial and sheet states, and correct material visual deviations before completion.

- [ ] **Step 7: Commit**

```bash
git add tests .env.example README.md docs apps/web apps/api packages
git commit -m "test: verify JAW World chat journeys"
```

### Task 9: Credentialed trial-run handoff

**Files:**

- Modify after actual trials only: `docs/integration-debrief.md`
- Modify after actual trials only: `docs/verification.md`

**Interfaces:**

- Consumes real JAW, World, DeepSeek, Jev and Sepolia credentials supplied through local/deployment secret storage.
- Produces dated evidence and sponsor debrief; never commits credentials or raw proof payloads.

- [ ] **Step 1: Validate credential names without printing values**

Report only `SET`/`EMPTY` for required variables. The OpenCode/gateway credential is accepted only after documenting its official endpoint, authorization header, DeepSeek model ID and Jev compatibility; otherwise request separate supported provider keys.

- [ ] **Step 2: Run live journeys**

Exercise JAW passkey create/return, SIWE replay refusal, PoH success/cancel/unavailable, ENS agent create/revoke, live DeepSeek proposal, live Jev assessment, sensitive approval cancel/success and idempotent receipt retry.

- [ ] **Step 3: Record debrief and evidence**

Record time to first success, friction, missing documentation/capability and the single highest-impact improvement for World/JAW/ENS. Clearly distinguish staging, Sepolia and synthetic runs.

- [ ] **Step 4: Commit evidence without secrets**

```bash
git add docs/integration-debrief.md docs/verification.md
git commit -m "docs: record credentialed HumanOS trial runs"
```
