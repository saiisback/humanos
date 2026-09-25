import { randomBytes, randomUUID } from "node:crypto";
import { Hono, type Context } from "hono";
import { getCookie, setCookie, deleteCookie } from "hono/cookie";
import { bodyLimit } from "hono/body-limit";
import * as v from "valibot";
import { parseSiweMessage } from "viem/siwe";
import { Database, type SessionRecord } from "@humanos/database";
import {
  hashCanonical,
  normalizeWalletAddress,
  VerifySiweRequestSchema,
  CreateMissionRequestSchema,
  AuthorizeMissionRequestSchema,
  VerifyWorldRequestSchema,
  type Mission,
  type ActionProposal,
  type Approval,
  type AuditEvent,
  type ExecutionReceipt,
  type JevAssessment,
  type PolicyDecision,
  type RootIdentity,
  type WorldProofRequest,
  type AgentAuthorization,
  type MissionProposal,
  type ActionProposalDraft,
  type WalletAccount,
  type JawPermissionReview,
  type JawPermissionGrant,
  type JawPermissionVerifier,
} from "@humanos/schemas";
import {
  authorize,
  transition,
  POLICY_VERSION,
  classifyStatic,
} from "@humanos/policy";
import {
  JEV_MODEL,
  JEV_QUESTION_VERSION,
  ModelUnavailableError,
} from "@humanos/models";
import {
  approvalBinding,
  WorldVerificationError,
  type createWorldVerifier,
} from "@humanos/world";
import {
  createExecutor,
  type ExecutionDependencies,
} from "./services/execute-sensitive-action.js";
import { isSiweVerificationError, type SiweVerifier } from "./services/siwe.js";
import { createWorkflowRoutes, type WorkflowApi } from "./workflows/routes.js";
import {
  createPermissionService,
  PermissionError,
} from "./services/jaw-permissions.js";
export interface EnsAdapter {
  register: (mission: Mission, rootOwner: string) => Promise<string>;
  revoke: (mission: Mission) => Promise<void>;
  readAuthorization: (name: string) => Promise<AgentAuthorization>;
}
export interface ApiConfig {
  db: Database;
  origin: string;
  siweVerifier?: SiweVerifier;
  jawPermissionVerifier?: JawPermissionVerifier;
  world?: ReturnType<typeof createWorldVerifier>;
  models?: {
    proposeMission: (input: unknown) => Promise<MissionProposal>;
    proposeNextAction: (input: unknown) => Promise<ActionProposalDraft>;
    evaluate: (input: {
      mission: Mission;
      action: ActionProposal;
    }) => Promise<JevAssessment>;
  };
  ens?: EnsAdapter;
  effect?: ExecutionDependencies["effect"];
  updateEnsReceipt?: ExecutionDependencies["updateEnsReceipt"];
  flueUrl?: string;
  internalSecret?: string;
  workflows?: WorkflowApi;
}
type Env = { Variables: { session: SessionRecord; root: RootIdentity } };
class HttpError extends Error {
  constructor(
    public status: 400 | 401 | 403 | 404 | 409 | 410 | 503,
    public code: string,
    message = code,
  ) {
    super(message);
  }
}
function requireService<T>(service: T | undefined): T {
  if (!service)
    throw new HttpError(
      503,
      "INTEGRATION_UNAVAILABLE",
      "This integration is not configured.",
    );
  return service;
}
export function createApi(config: ApiConfig) {
  const { db } = config;
  const webOrigin = new URL(config.origin);
  if (
    !["http:", "https:"].includes(webOrigin.protocol) ||
    webOrigin.pathname !== "/" ||
    webOrigin.search ||
    webOrigin.hash ||
    webOrigin.username ||
    webOrigin.password
  )
    throw new Error("INVALID_WEB_ORIGIN");
  const siweOrigin = webOrigin.origin;
  const app = new Hono<Env>();
  app.use("*", bodyLimit({ maxSize: 100000 }));
  app.use("*", async (c, next) => {
    c.header("Cache-Control", "no-store");
    c.header("X-Content-Type-Options", "nosniff");
    if (!["GET", "HEAD", "OPTIONS"].includes(c.req.method)) {
      const origin = c.req.header("origin");
      if (
        (origin && origin !== siweOrigin) ||
        c.req.header("sec-fetch-site") === "cross-site"
      )
        throw new HttpError(403, "FORBIDDEN");
    }
    await next();
  });
  const error = (
    c: Context,
    status: 400 | 401 | 403 | 404 | 409 | 410 | 503,
    code: string,
    message: string,
  ) => c.json({ error: { code, message } }, status);
  app.onError((e, c) => {
    if (e instanceof ModelUnavailableError) {
      const messages = {
        MODEL_CREDITS_REQUIRED:
          "The model provider needs credits. Top up the configured provider account, then retry.",
        MODEL_AUTH_FAILED:
          "The model provider rejected its API credentials. Check the server configuration.",
        MODEL_RATE_LIMITED:
          "The model provider is rate limiting requests. Please try again shortly.",
        MODEL_TIMEOUT:
          "The model response timed out. No task action was executed; please retry.",
        MODEL_UNAVAILABLE:
          "The model response could not be validated. No task action was executed; please retry.",
      };
      return error(c, 503, e.code, messages[e.code]);
    }
    if (e instanceof PermissionError)
      return error(c, e.status, e.code, e.message);
    if (e instanceof HttpError) return error(c, e.status, e.code, e.message);
    if (e instanceof v.ValiError || e instanceof SyntaxError)
      return error(c, 400, "INVALID_REQUEST", "Invalid request data.");
    return error(
      c,
      503,
      "INTEGRATION_UNAVAILABLE",
      "The operation could not be verified. No new authority was granted.",
    );
  });
  async function session(c: Context): Promise<SessionRecord | null> {
    const token = getCookie(c, "humanos_session");
    if (!token) return null;
    const s = await db.get<SessionRecord>("sessions", hashCanonical(token));
    return s && Date.parse(s.expiresAt) > Date.now() ? s : null;
  }
  async function linkedSession(
    c: Context,
  ): Promise<SessionRecord & { rootId: string }> {
    const s = await session(c);
    if (
      !s ||
      !s.accountId ||
      !(await db.get<WalletAccount>("accounts", s.accountId))
    )
      throw new HttpError(401, "UNAUTHENTICATED");
    if (!s.rootId) throw new HttpError(403, "HUMAN_VERIFICATION_REQUIRED");
    const binding = await db.query<{ data: { rootId: string } }>(
      "SELECT data FROM root_bindings WHERE account_id=$1",
      [s.accountId],
    );
    if (
      binding.rows[0]?.data.rootId !== s.rootId ||
      !(await db.get<RootIdentity>("roots", s.rootId))
    )
      throw new HttpError(403, "HUMAN_VERIFICATION_REQUIRED");
    return s as SessionRecord & { rootId: string };
  }
  const cookieOpts = {
    httpOnly: true,
    sameSite: "Strict" as const,
    secure: webOrigin.protocol === "https:",
    path: "/",
  };
  async function owner(c: Context, id: string): Promise<Mission> {
    const m = await db.get<Mission>("missions", id);
    const s = await linkedSession(c);
    if (!m || m.rootId !== s.rootId) throw new HttpError(404, "NOT_FOUND");
    return m;
  }
  async function ownedAction(c: Context) {
    const a = await db.get<ActionProposal>("actions", c.req.param("id") ?? "");
    if (!a) throw new HttpError(404, "NOT_FOUND");
    await owner(c, a.missionId);
    return a;
  }
  async function detail(m: Mission) {
    const actions = (await db.list<ActionProposal>("actions")).filter(
      (a) => a.missionId === m.id,
    );
    const ids = new Set(actions.map((a) => a.id));
    const evaluation = await db.get<{
      id: string;
      assessment: JevAssessment;
      decision: PolicyDecision;
    }>("agents", `evaluation:${m.id}`);
    return {
      mission: m,
      actions,
      approvals: (await db.list<Approval>("approvals")).filter((p) =>
        ids.has(p.actionId),
      ),
      receipts: (await db.list<ExecutionReceipt>("receipts")).filter(
        (r) => r.missionId === m.id,
      ),
      events: (await db.list<AuditEvent>("audit")).filter(
        (e) => e.missionId === m.id,
      ),
      assessment: evaluation?.assessment ?? null,
      decision: evaluation?.decision ?? null,
      permissionReviews: (
        await db.list<JawPermissionReview>("jaw_reviews")
      ).filter((review) => review.missionId === m.id),
      permissionGrants: (await db.list<JawPermissionGrant>("jaw_permissions"))
        .filter((grant) => grant.missionId === m.id)
        .map((grant) =>
          ["ACTIVE", "UNVERIFIED"].includes(grant.status) &&
          grant.end * 1000 <= Date.now()
            ? { ...grant, status: "EXPIRED" as const }
            : grant,
        ),
    };
  }
  async function audit(
    m: Mission,
    type: string,
    previousState: Mission["state"] | null,
    metadata: AuditEvent["metadata"] = {},
    writer: Pick<Database, "insert"> = db,
  ) {
    await writer.insert("audit", {
      id: randomUUID(),
      missionId: m.id,
      actionId:
        typeof metadata.actionId === "string" ? metadata.actionId : null,
      type,
      actor: m.rootId,
      previousState,
      nextState: m.state,
      policyVersion: POLICY_VERSION,
      modelVersions: { deepseek: "deepseek-flash", jev: JEV_MODEL },
      metadata,
      createdAt: new Date().toISOString(),
    } satisfies AuditEvent);
  }
  app.get("/api/health", (c) => c.json({ status: "ok" }));
  const permissions = createPermissionService(db, config.jawPermissionVerifier);
  app.get("/api/jaw/permissions", async (c) =>
    c.json({ grants: await permissions.list(await linkedSession(c)) }),
  );
  app.post("/api/jaw/permissions/record", async (c) => {
    const s = await linkedSession(c);
    return c.json({ grant: await permissions.record(s, await c.req.json()) });
  });
  app.post("/api/jaw/permissions/:id/revoke", async (c) => {
    const s = await linkedSession(c);
    return c.json({
      grant: await permissions.revoke(s, c.req.param("id"), await c.req.json()),
    });
  });
  app.get("/api/ready", (c) => {
    const services = [
      ["JAW SIWE", !!config.siweVerifier],
      ["World ID", !!config.world],
      ["DeepSeek and Jev", !!config.models],
      ["ENSv2 Sepolia", !!config.ens],
      ["Protected submission", !!config.effect],
      ["Flue runtime", !!config.flueUrl],
    ] as const;
    return c.json({
      ready: services.every(([, ready]) => ready),
      services: services.map(([name, ready]) => ({
        name,
        ready,
        reason: ready ? null : "Configuration or credentials required",
      })),
    });
  });
  app.get("/api/session", async (c) => {
    const s = await session(c);
    return c.json({
      root: s?.rootId ? await db.get<RootIdentity>("roots", s.rootId) : null,
    });
  });
  app.post("/api/auth/siwe/nonce", async (c) => {
    requireService(config.siweVerifier);
    const now = new Date();
    const nonce = randomBytes(16).toString("hex");
    const token = randomBytes(32).toString("hex");
    const challengeId = randomUUID();
    const expiresAt = new Date(now.getTime() + 300000).toISOString();
    await db.insert("challenges", {
      id: challengeId,
      kind: "siwe",
      nonce,
      ownerHash: hashCanonical(token),
      createdAt: now.toISOString(),
      expiresAt,
      consumedAt: null,
    });
    setCookie(c, "humanos_auth_challenge", token, {
      ...cookieOpts,
      maxAge: 300,
    });
    return c.json({
      challengeId,
      nonce,
      expiresAt,
      chainId: 11155111,
      domain: webOrigin.host,
      uri: siweOrigin,
    });
  });
  app.post("/api/auth/siwe/verify", async (c) => {
    const verifier = requireService(config.siweVerifier);
    const input = v.parse(VerifySiweRequestSchema, await c.req.json());
    const challenge = await db.get<{
      id: string;
      kind: string;
      nonce: string;
      ownerHash: string;
      createdAt: string;
      expiresAt: string;
      consumedAt: string | null;
    }>("challenges", input.challengeId);
    const token = getCookie(c, "humanos_auth_challenge");
    const now = new Date();
    if (
      !token ||
      !challenge ||
      challenge.kind !== "siwe" ||
      challenge.ownerHash !== hashCanonical(token) ||
      challenge.consumedAt ||
      Date.parse(challenge.expiresAt) <= now.getTime()
    )
      throw new HttpError(403, "INVALID_CHALLENGE");
    const parsed = parseSiweMessage(input.message);
    const issuedAt = parsed.issuedAt?.getTime();
    const expiration = parsed.expirationTime?.getTime();
    if (
      !parsed.address ||
      parsed.version !== "1" ||
      !issuedAt ||
      !expiration ||
      !Number.isFinite(issuedAt) ||
      !Number.isFinite(expiration) ||
      issuedAt > now.getTime() ||
      issuedAt < Date.parse(challenge.createdAt) - 60000 ||
      expiration <= now.getTime() ||
      expiration > Date.parse(challenge.expiresAt) ||
      (parsed.notBefore &&
        (!Number.isFinite(parsed.notBefore.getTime()) ||
          parsed.notBefore.getTime() > now.getTime()))
    )
      throw new HttpError(403, "INVALID_SIWE_MESSAGE");
    let verified: Awaited<ReturnType<SiweVerifier["verify"]>>;
    try {
      verified = await verifier.verify({
        message: input.message,
        signature: input.signature,
      });
    } catch (error) {
      if (
        isSiweVerificationError(error) &&
        error.reason === "invalid_signature"
      )
        throw new HttpError(403, "INVALID_SIGNATURE");
      throw new HttpError(
        503,
        "INTEGRATION_UNAVAILABLE",
        "Account verification is temporarily unavailable.",
      );
    }
    let address: string;
    try {
      address = normalizeWalletAddress(parsed.address);
      if (
        normalizeWalletAddress(verified.address) !== address ||
        verified.chainId !== parsed.chainId
      )
        throw new Error("VERIFIER_MISMATCH");
    } catch {
      throw new HttpError(403, "INVALID_SIGNATURE");
    }
    const validContext =
      parsed.domain === webOrigin.host &&
      parsed.uri === siweOrigin &&
      parsed.chainId === 11155111 &&
      parsed.nonce === challenge.nonce &&
      (!parsed.scheme || parsed.scheme === webOrigin.protocol.slice(0, -1));
    const stillValid = (at: Date) =>
      expiration > at.getTime() &&
      (!parsed.notBefore || parsed.notBefore.getTime() <= at.getTime());
    if (!stillValid(new Date()))
      throw new HttpError(403, "INVALID_SIWE_MESSAGE");
    if (!validContext) {
      try {
        await db.transaction((tx) =>
          tx.consumeChallenge(challenge.id, new Date()),
        );
      } catch {
        throw new HttpError(403, "INVALID_CHALLENGE");
      }
      throw new HttpError(403, "INVALID_SIWE_CONTEXT");
    }
    const accountId = `11155111:${address}`;
    const sessionToken = randomBytes(32).toString("hex");
    let account: WalletAccount;
    let root: RootIdentity | null = null;
    try {
      await db.transaction(async (tx) => {
        const issuedAt = new Date();
        if (!stillValid(issuedAt))
          throw new HttpError(403, "INVALID_SIWE_MESSAGE");
        await tx.consumeChallenge(challenge.id, issuedAt);
        const freshAccount: WalletAccount = {
          id: accountId,
          address,
          chainId: 11155111,
          createdAt: issuedAt.toISOString(),
        };
        await tx.query(
          "INSERT INTO accounts (id,data) VALUES ($1,$2::jsonb) ON CONFLICT(id) DO NOTHING",
          [accountId, JSON.stringify(freshAccount)],
        );
        const locked = await tx.query<{ data: WalletAccount }>(
          "SELECT data FROM accounts WHERE id=$1 FOR UPDATE",
          [accountId],
        );
        account = locked.rows[0]!.data;
        const binding = await tx.query<{ data: { rootId: string } }>(
          "SELECT data FROM root_bindings WHERE account_id=$1",
          [accountId],
        );
        const rootId = binding.rows[0]?.data.rootId ?? null;
        root = rootId ? await tx.get<RootIdentity>("roots", rootId) : null;
        if (rootId && !root) throw new Error("ROOT_NOT_FOUND");
        const sessionIssuedAt = new Date();
        if (
          !stillValid(sessionIssuedAt) ||
          Date.parse(challenge.expiresAt) <= sessionIssuedAt.getTime()
        )
          throw new HttpError(403, "INVALID_SIWE_MESSAGE");
        await tx.insert("sessions", {
          id: hashCanonical(sessionToken),
          accountId,
          rootId,
          expiresAt: new Date(
            sessionIssuedAt.getTime() + 8 * 3600000,
          ).toISOString(),
        });
      });
    } catch (error) {
      if (
        error instanceof Error &&
        error.message === "CHALLENGE_NOT_CONSUMABLE"
      )
        throw new HttpError(403, "INVALID_CHALLENGE");
      throw error;
    }
    setCookie(c, "humanos_session", sessionToken, {
      ...cookieOpts,
      maxAge: 8 * 3600,
    });
    deleteCookie(c, "humanos_auth_challenge", { path: "/" });
    return c.json({ account: account!, root, jawConfigured: true });
  });
  app.get("/api/auth/session", async (c) => {
    const s = await session(c);
    return c.json({
      account: s ? await db.get<WalletAccount>("accounts", s.accountId) : null,
      root: s?.rootId ? await db.get<RootIdentity>("roots", s.rootId) : null,
      jawConfigured: !!config.siweVerifier,
    });
  });
  app.post("/api/auth/logout", async (c) => {
    const token = getCookie(c, "humanos_session");
    if (token) await db.delete("sessions", hashCanonical(token));
    deleteCookie(c, "humanos_session", { path: "/" });
    return c.json({
      account: null,
      root: null,
      jawConfigured: !!config.siweVerifier,
    });
  });
  app.post("/api/session/logout", async (c) => {
    const token = getCookie(c, "humanos_session");
    if (token) await db.delete("sessions", hashCanonical(token));
    deleteCookie(c, "humanos_session", { path: "/" });
    return c.json({ root: null });
  });
  app.post("/api/world/root/request", async (c) => {
    const s = await session(c);
    if (
      !s ||
      !s.accountId ||
      !(await db.get<WalletAccount>("accounts", s.accountId))
    )
      throw new HttpError(401, "UNAUTHENTICATED");
    const world = requireService(config.world);
    const token = randomBytes(32).toString("hex");
    const request = world.createRequest("humanos-root", hashCanonical(token));
    await db.insert("challenges", {
      id: request.requestId,
      request,
      ownerHash: hashCanonical(token),
      sessionId: s.id,
      accountId: s.accountId,
      kind: "root",
      expiresAt: new Date(
        Number(request.rpContext.expires_at) * 1000,
      ).toISOString(),
      consumedAt: null,
    });
    setCookie(c, "humanos_challenge", token, { ...cookieOpts, maxAge: 300 });
    return c.json(request);
  });
  app.post("/api/world/root/verify", async (c) => {
    const s = await session(c);
    if (
      !s ||
      !s.accountId ||
      !(await db.get<WalletAccount>("accounts", s.accountId))
    )
      throw new HttpError(401, "UNAUTHENTICATED");
    const input = v.parse(VerifyWorldRequestSchema, await c.req.json());
    const challenge = await db.get<{
      id: string;
      request: WorldProofRequest;
      ownerHash: string;
      kind: string;
      sessionId: string;
      accountId: string;
      expiresAt: string;
      consumedAt: string | null;
    }>("challenges", input.requestId);
    const token = getCookie(c, "humanos_challenge");
    if (
      !token ||
      !challenge ||
      challenge.kind !== "root" ||
      challenge.ownerHash !== hashCanonical(token) ||
      challenge.sessionId !== s.id ||
      challenge.accountId !== s.accountId
    )
      throw new HttpError(403, "FORBIDDEN");
    if (challenge.consumedAt || Date.parse(challenge.expiresAt) <= Date.now())
      throw new HttpError(403, "INVALID_CHALLENGE");
    let verified: Awaited<
      ReturnType<NonNullable<ApiConfig["world"]>["verify"]>
    >;
    try {
      verified = await requireService(config.world).verify(
        challenge.request,
        input.proof,
      );
    } catch (error) {
      if (
        error instanceof WorldVerificationError &&
        error.reason === "invalid_proof"
      )
        throw new HttpError(403, "INVALID_PROOF");
      throw error;
    }
    const nullifierHash = verified.nullifierHash.toLowerCase();
    const freshRoot: RootIdentity = {
      id: randomUUID(),
      ensName: null,
      createdAt: new Date().toISOString(),
      verificationEnvironment: challenge.request.environment,
    };
    let root: RootIdentity;
    let account: WalletAccount;
    try {
      ({ root, account } = await db.transaction(async (tx) => {
        const lockedSession = await tx.query<{ data: SessionRecord }>(
          "SELECT data FROM sessions WHERE id=$1 FOR UPDATE",
          [s.id],
        );
        const currentSession = lockedSession.rows[0]?.data;
        if (
          !currentSession ||
          currentSession.accountId !== s.accountId ||
          Date.parse(currentSession.expiresAt) <= Date.now()
        )
          throw new HttpError(401, "UNAUTHENTICATED");
        const lockedAccount = await tx.query<{ data: WalletAccount }>(
          "SELECT data FROM accounts WHERE id=$1 FOR UPDATE",
          [s.accountId],
        );
        const account = lockedAccount.rows[0]?.data;
        if (!account) throw new HttpError(401, "UNAUTHENTICATED");
        const lockedChallenge = await tx.query<{ data: typeof challenge }>(
          "SELECT data FROM challenges WHERE id=$1 FOR UPDATE",
          [challenge.id],
        );
        const currentChallenge = lockedChallenge.rows[0]?.data;
        if (
          !currentChallenge ||
          currentChallenge.kind !== "root" ||
          currentChallenge.sessionId !== s.id ||
          currentChallenge.accountId !== s.accountId ||
          currentChallenge.ownerHash !== hashCanonical(token) ||
          currentChallenge.consumedAt ||
          Date.parse(currentChallenge.expiresAt) <= Date.now() ||
          hashCanonical(currentChallenge.request) !==
            hashCanonical(challenge.request)
        )
          throw new HttpError(403, "INVALID_CHALLENGE");
        await tx.query("SELECT pg_advisory_xact_lock(hashtextextended($1,0))", [
          `humanos:world:nullifier:${nullifierHash}`,
        ]);
        if (Date.parse(currentSession.expiresAt) <= Date.now())
          throw new HttpError(401, "UNAUTHENTICATED");
        if (Date.parse(currentChallenge.expiresAt) <= Date.now())
          throw new HttpError(403, "INVALID_CHALLENGE");
        const existing = await tx.get<{ id: string; rootId: string }>(
          "nullifiers",
          nullifierHash,
        );
        let root: RootIdentity;
        if (existing) {
          const known = await tx.get<RootIdentity>("roots", existing.rootId);
          if (!known) throw new HttpError(409, "ROOT_ACCOUNT_CONFLICT");
          root = known;
        } else {
          root = freshRoot;
          await tx.insert("roots", root);
          await tx.claimNullifier(nullifierHash, root.id);
        }
        if (currentSession.rootId && currentSession.rootId !== root.id)
          throw new HttpError(409, "ROOT_ACCOUNT_CONFLICT");
        await tx.bindRootAccount(root.id, s.accountId, new Date());
        const linkedAt = new Date();
        if (Date.parse(currentSession.expiresAt) <= linkedAt.getTime())
          throw new HttpError(401, "UNAUTHENTICATED");
        if (Date.parse(currentChallenge.expiresAt) <= linkedAt.getTime())
          throw new HttpError(403, "INVALID_CHALLENGE");
        await tx.consumeChallenge(challenge.id, linkedAt);
        await tx.put("sessions", { ...currentSession, rootId: root.id });
        return { root, account };
      }));
    } catch (error) {
      if (error instanceof Error && error.message === "ROOT_ACCOUNT_CONFLICT")
        throw new HttpError(409, "ROOT_ACCOUNT_CONFLICT");
      if (
        error instanceof Error &&
        error.message === "CHALLENGE_NOT_CONSUMABLE"
      )
        throw new HttpError(403, "INVALID_CHALLENGE");
      throw error;
    }
    deleteCookie(c, "humanos_challenge", { path: "/" });
    return c.json({
      account: account!,
      root: root!,
      jawConfigured: !!config.siweVerifier,
    });
  });
  app.use("/api/missions/*", async (c, next) => {
    const s = await linkedSession(c);
    c.set("session", s);
    await next();
  });
  app.use("/api/actions/*", async (c, next) => {
    const s = await linkedSession(c);
    c.set("session", s);
    await next();
  });
  app.get("/api/missions", async (c) => {
    const s = await linkedSession(c);
    return c.json({
      missions: (await db.list<Mission>("missions")).filter(
        (m) => m.rootId === s.rootId,
      ),
    });
  });
  app.post("/api/missions", async (c) => {
    const s = await linkedSession(c);
    const input = v.parse(CreateMissionRequestSchema, await c.req.json());
    // Authority duration comes from deterministic server policy, never model text.
    const requestedAt = Date.now();
    const expiresAt =
      input.expiresAt ?? new Date(requestedAt + 3600000).toISOString();
    if (
      Date.parse(expiresAt) <= requestedAt ||
      Date.parse(expiresAt) > requestedAt + 86400000
    )
      throw new HttpError(
        400,
        "INVALID_REQUEST",
        "Mission expiry must be within 24 hours.",
      );
    const proposed = await requireService(config.models).proposeMission({
      ...input,
      expiresAt,
      currentTime: new Date(requestedAt).toISOString(),
    });
    if (Date.parse(expiresAt) <= Date.now())
      throw new HttpError(
        400,
        "INVALID_REQUEST",
        "Mission expired while preparing the proposal. Choose a later deadline.",
      );
    const stamp = new Date().toISOString();
    const m: Mission = {
      ...proposed,
      goal: input.goal,
      expiresAt,
      id: randomUUID(),
      rootId: s.rootId,
      agentEns: null,
      state: "PROPOSED",
      approvedCapabilities: [],
      createdAt: stamp,
      updatedAt: stamp,
      policyVersion: POLICY_VERSION,
    };
    await db.insert("missions", m);
    await audit(m, "MISSION_PROPOSED", null);
    return c.json(await detail(m), 201);
  });
  app.get("/api/missions/:id", async (c) => {
    let m = await owner(c, c.req.param("id"));
    if (
      Date.parse(m.expiresAt) <= Date.now() &&
      !["COMPLETED", "REJECTED", "EXPIRED", "REVOKED", "FAILED"].includes(
        m.state,
      )
    ) {
      m = await db.transaction(async (tx) => {
        const fresh = await tx.lockMission(m.id);
        if (
          ["COMPLETED", "REJECTED", "EXPIRED", "REVOKED", "FAILED"].includes(
            fresh.state,
          ) ||
          Date.parse(fresh.expiresAt) > Date.now()
        )
          return fresh;
        const expired = {
          ...fresh,
          state: transition(fresh.state, "EXPIRE"),
          updatedAt: new Date().toISOString(),
        };
        await tx.put("missions", expired);
        await audit(expired, "MISSION_EXPIRED", fresh.state, {}, tx);
        return expired;
      });
    }
    return c.json(await detail(m));
  });
  app.post("/api/missions/:id/authorize", async (c) => {
    const m = await owner(c, c.req.param("id"));
    const s = await linkedSession(c);
    const input = v.parse(AuthorizeMissionRequestSchema, await c.req.json());
    const next = await db.transaction(async (tx) => {
      const fresh = await tx.lockMission(m.id);
      if (
        fresh.state !== "PROPOSED" ||
        Date.parse(fresh.expiresAt) <= Date.now() ||
        input.approvedCapabilities.some((x) => !fresh.capabilities.includes(x))
      )
        throw new HttpError(409, "CONFLICT");
      const liveSession = await tx.query<{ data: SessionRecord }>(
        "SELECT data FROM sessions WHERE id=$1 FOR UPDATE",
        [s.id],
      );
      const currentSession = liveSession.rows[0]?.data;
      if (
        !currentSession ||
        currentSession.accountId !== s.accountId ||
        currentSession.rootId !== fresh.rootId ||
        Date.parse(currentSession.expiresAt) <= Date.now()
      )
        throw new HttpError(401, "UNAUTHENTICATED");
      const accountRow = await tx.query<{ data: WalletAccount }>(
        "SELECT data FROM accounts WHERE id=$1 FOR UPDATE",
        [s.accountId],
      );
      const account = accountRow.rows[0]?.data;
      const binding = await tx.query<{
        data: { rootId: string; accountId: string };
      }>("SELECT data FROM root_bindings WHERE account_id=$1", [s.accountId]);
      let rootOwner: string;
      try {
        rootOwner = normalizeWalletAddress(account?.address ?? "");
      } catch {
        throw new HttpError(403, "HUMAN_VERIFICATION_REQUIRED");
      }
      if (
        !account ||
        account.chainId !== 11155111 ||
        account.address !== rootOwner ||
        account.id !== `${account.chainId}:${rootOwner}` ||
        /^0x0{40}$/.test(rootOwner) ||
        binding.rows[0]?.data.accountId !== account.id ||
        binding.rows[0]?.data.rootId !== fresh.rootId
      )
        throw new HttpError(403, "HUMAN_VERIFICATION_REQUIRED");
      const approved = {
        ...fresh,
        approvedCapabilities: [...input.approvedCapabilities],
      };
      // Serialize registration for this mission. The adapter must be idempotent across a DB rollback after chain submission.
      const registration = structuredClone(approved);
      Object.freeze(registration.capabilities);
      Object.freeze(registration.approvedCapabilities);
      Object.freeze(registration.steps);
      Object.freeze(registration);
      // Account-row contention can outlast the earlier checks while this transaction waits.
      if (Date.parse(currentSession.expiresAt) <= Date.now())
        throw new HttpError(401, "UNAUTHENTICATED");
      if (Date.parse(fresh.expiresAt) <= Date.now())
        throw new HttpError(409, "CONFLICT");
      const agentEns = await requireService(config.ens).register(
        registration,
        rootOwner,
      );
      const value = {
        ...approved,
        agentEns,
        state: transition(fresh.state, "AUTHORIZE"),
        updatedAt: new Date().toISOString(),
      };
      await tx.put("missions", value);
      const root = await tx.get<RootIdentity>("roots", value.rootId);
      if (root)
        await tx.put("roots", {
          ...root,
          ensName: agentEns.split(".").slice(1).join("."),
        });
      return value;
    });
    await audit(next, "MISSION_AUTHORIZED", m.state);
    return c.json(await detail(next));
  });
  app.post("/api/missions/:id/run", async (c) => {
    const m = await owner(c, c.req.param("id"));
    const url = requireService(config.flueUrl);
    const next = await db.transaction(async (tx) => {
      const fresh = await tx.lockMission(m.id);
      if (Date.parse(fresh.expiresAt) <= Date.now())
        throw new HttpError(410, "EXPIRED");
      const value = {
        ...fresh,
        state:
          fresh.state === "AUTHORIZED"
            ? transition(fresh.state, "START")
            : fresh.state,
        updatedAt: new Date().toISOString(),
      };
      if (value.state !== "RUNNING") throw new HttpError(409, "CONFLICT");
      await tx.put("missions", value);
      return value;
    });
    const response = await fetch(
      `${url}/agents/humanos/${encodeURIComponent(m.id)}`,
      {
        method: "POST",
        headers: {
          "content-type": "application/json",
          cookie: c.req.header("cookie") ?? "",
        },
        body: JSON.stringify({
          kind: "user",
          body: "Prepare the next application or calendar action within my approved mission. Call prepare_next_action.",
        }),
        signal: AbortSignal.timeout(10000),
      },
    );
    if (!response.ok)
      throw new HttpError(
        503,
        "INTEGRATION_UNAVAILABLE",
        "Flue did not accept the work. Retry to resume.",
      );
    return c.json(await detail(next));
  });
  app.post("/api/missions/:id/revoke", async (c) => {
    const m = await owner(c, c.req.param("id"));
    const next = await db.transaction(async (tx) => {
      const fresh = await tx.lockMission(m.id);
      const next = {
        ...fresh,
        state:
          fresh.state === "REVOKED"
            ? fresh.state
            : transition(fresh.state, "REVOKE"),
        updatedAt: new Date().toISOString(),
      };
      await tx.put("missions", next);
      return next;
    });
    if (m.state !== "REVOKED") await audit(next, "MISSION_REVOKED", m.state);
    if (next.agentEns) {
      await db.put("agents", { id: `revocation:${m.id}`, status: "PENDING" });
      await requireService(config.ens).revoke(next);
      await db.put("agents", { id: `revocation:${m.id}`, status: "CONFIRMED" });
      await audit(next, "ENS_REVOCATION_CONFIRMED", next.state);
    }
    return c.json(await detail(next));
  });
  app.post("/api/actions/:id/approval/request", async (c) => {
    const a = await ownedAction(c);
    const s = await session(c);
    if (!s) throw new HttpError(401, "UNAUTHENTICATED");
    const world = requireService(config.world);
    const result = await db.withLockedAction(a.id, async (tx, action) => {
      const currentSession = await tx.get<SessionRecord>("sessions", s.id);
      const m = await tx.get<Mission>("missions", action.missionId);
      const now = Date.now();
      if (
        !currentSession ||
        Date.parse(currentSession.expiresAt) <= now ||
        currentSession.rootId !== s.rootId
      )
        throw new HttpError(401, "UNAUTHENTICATED");
      if (!m || m.rootId !== s.rootId || action.rootId !== s.rootId)
        throw new HttpError(403, "FORBIDDEN");
      if (
        !["RUNNING", "AWAITING_APPROVAL"].includes(m.state) ||
        Date.parse(m.expiresAt) <= now ||
        Date.parse(action.expiresAt) <= now
      )
        throw new HttpError(409, "CONFLICT");
      if (hashCanonical(action.payload) !== action.payloadHash)
        throw new HttpError(409, "CONFLICT");
      const binding = approvalBinding(action),
        bindingHash = hashCanonical(binding);
      const old = (await tx.list<Approval>("approvals")).find(
        (p) => p.actionId === action.id,
      );
      let approval: Approval;
      if (old) {
        if (
          old.status !== "PENDING" ||
          old.kind !== "WORLD_FRESH" ||
          old.bindingHash !== bindingHash ||
          hashCanonical(old.binding) !== bindingHash
        )
          throw new HttpError(409, "CONFLICT");
        const challenges = (
          await tx.list<{
            id: string;
            approvalId?: string;
            sessionId?: string;
            rootId?: string;
            actionId?: string;
            request: WorldProofRequest;
            expiresAt: string;
            consumedAt: string | null;
          }>("challenges")
        ).filter((r) => r.approvalId === old.id);
        if (
          !challenges.length ||
          challenges.some(
            (r) =>
              r.sessionId !== s.id ||
              r.rootId !== s.rootId ||
              r.actionId !== action.id,
          )
        )
          throw new HttpError(403, "FORBIDDEN");
        const active = challenges.find(
          (r) =>
            !r.consumedAt &&
            Date.parse(r.expiresAt) > now &&
            r.request.action === "humanos-root" &&
            r.request.signal === bindingHash,
        );
        if (active) return { approval: old, request: active.request };
        // Invalidate expired or legacy-scope requests even if their proofs remain cryptographically valid.
        for (const previous of challenges)
          if (!previous.consumedAt)
            await tx.query(
              "UPDATE challenges SET data=jsonb_set(data,'{consumedAt}',to_jsonb($2::text)) WHERE id=$1 AND data->>'consumedAt' IS NULL",
              [previous.id, new Date(now).toISOString()],
            );
        approval = old;
      } else {
        approval = {
          id: randomUUID(),
          actionId: action.id,
          binding,
          bindingHash,
          kind: "WORLD_FRESH",
          status: "PENDING",
          createdAt: new Date(now).toISOString(),
          verifiedAt: null,
          consumedAt: null,
          nullifierHash: null,
        };
        await tx.insert("approvals", approval);
      }
      // World nullifiers are action-scoped. Keep the registered root action for same-human equality;
      // the exact operation is bound by this signal plus a fresh signed RP nonce and stored request ID.
      const request = world.createRequest("humanos-root", bindingHash);
      await tx.insert("challenges", {
        id: request.requestId,
        request,
        approvalId: approval.id,
        rootId: s.rootId,
        actionId: action.id,
        sessionId: s.id,
        kind: "approval",
        expiresAt: new Date(
          Math.min(
            Date.parse(action.expiresAt),
            Date.parse(m.expiresAt),
            Number(request.rpContext.expires_at) * 1000,
          ),
        ).toISOString(),
        consumedAt: null,
      });
      if (m.state === "RUNNING")
        await tx.put("missions", {
          ...m,
          state: transition(m.state, "REQUEST_APPROVAL"),
          updatedAt: new Date(now).toISOString(),
        });
      return { approval, request };
    });
    return c.json(result);
  });
  app.post("/api/actions/:id/approval/verify", async (c) => {
    const a = await ownedAction(c);
    const s = (await session(c))!;
    const input = v.parse(VerifyWorldRequestSchema, await c.req.json());
    const challenge = await db.get<{
      id: string;
      request: WorldProofRequest;
      approvalId: string;
      rootId: string;
      actionId: string;
      sessionId: string;
      kind: string;
    }>("challenges", input.requestId);
    if (
      !challenge ||
      challenge.kind !== "approval" ||
      challenge.actionId !== a.id ||
      challenge.rootId !== s.rootId ||
      challenge.sessionId !== s.id
    )
      throw new HttpError(403, "FORBIDDEN");
    let verified: Awaited<
      ReturnType<NonNullable<ApiConfig["world"]>["verify"]>
    >;
    try {
      verified = await requireService(config.world).verify(
        challenge.request,
        input.proof,
      );
    } catch (error) {
      // A denied attempt is not a terminal human cancellation. Never store proof bytes or provider errors.
      await db.withLockedAction(a.id, async (tx) => {
        const current = await tx.get<Mission>("missions", a.missionId);
        if (current)
          await audit(
            current,
            "WORLD_APPROVAL_DENIED",
            current.state,
            {
              actionId: a.id,
              approvalId: challenge.approvalId,
              reason: "PROOF_NOT_VERIFIED",
            },
            tx,
          );
      });
      if (
        error instanceof WorldVerificationError &&
        error.reason === "invalid_proof"
      )
        throw new HttpError(403, "INVALID_PROOF");
      throw error;
    }
    const next = await db.withLockedAction(a.id, async (tx) => {
      const live = await tx.query<{ data: SessionRecord }>(
        "SELECT data FROM sessions WHERE id=$1 FOR UPDATE",
        [s.id],
      );
      const currentSession = live.rows[0]?.data;
      if (
        !currentSession ||
        currentSession.accountId !== s.accountId ||
        currentSession.rootId !== s.rootId ||
        Date.parse(currentSession.expiresAt) <= Date.now()
      )
        throw new HttpError(401, "UNAUTHENTICATED");
      const binding = await tx.query<{ data: { rootId: string } }>(
        "SELECT data FROM root_bindings WHERE account_id=$1",
        [s.accountId],
      );
      if (binding.rows[0]?.data.rootId !== s.rootId)
        throw new HttpError(403, "HUMAN_VERIFICATION_REQUIRED");
      const m = await tx.get<Mission>("missions", a.missionId);
      const currentChallenge = await tx.get<typeof challenge>(
        "challenges",
        challenge.id,
      );
      if (
        !m ||
        !currentChallenge ||
        currentChallenge.kind !== "approval" ||
        currentChallenge.sessionId !== s.id ||
        currentChallenge.actionId !== a.id ||
        currentChallenge.rootId !== s.rootId ||
        hashCanonical(currentChallenge.request) !==
          hashCanonical(challenge.request) ||
        m.rootId !== s.rootId ||
        a.rootId !== s.rootId
      )
        throw new HttpError(403, "FORBIDDEN");
      const nullifier = await tx.get<{ rootId: string }>(
        "nullifiers",
        verified.nullifierHash.toLowerCase(),
      );
      if (!nullifier || nullifier.rootId !== s.rootId)
        throw new HttpError(403, "FORBIDDEN");
      await tx.consumeChallenge(challenge.id, new Date());
      await tx.updateApprovalStatus(challenge.approvalId, "VERIFIED", {
        verifiedAt: new Date().toISOString(),
        nullifierHash: verified.nullifierHash,
      });
      const next = {
        ...m,
        state: transition(m.state, "APPROVE"),
        updatedAt: new Date().toISOString(),
      };
      await tx.put("missions", next);
      return next;
    });
    await audit(next, "WORLD_APPROVAL_VERIFIED", "AWAITING_APPROVAL", {
      actionId: a.id,
    });
    return c.json(await detail(next));
  });
  app.post("/api/actions/:id/approval/cancel", async (c) => {
    const a = await ownedAction(c);
    const m = await db.withLockedAction(a.id, async (tx) => {
      const p = (await tx.list<Approval>("approvals")).find(
        (p) => p.actionId === a.id,
      );
      const m = await tx.get<Mission>("missions", a.missionId);
      if (!m) throw new HttpError(404, "NOT_FOUND");
      if (
        !["RUNNING", "AWAITING_APPROVAL"].includes(m.state) ||
        (p &&
          (!["PENDING", "VERIFIED"].includes(p.status) ||
            p.consumedAt !== null))
      )
        throw new HttpError(
          409,
          "CONFLICT",
          "This action can no longer be cancelled.",
        );
      if (p) await tx.updateApprovalStatus(p.id, "CANCELLED");
      const next = {
        ...m,
        state: transition(m.state, "REJECT"),
        updatedAt: new Date().toISOString(),
      };
      await tx.put("missions", next);
      await audit(
        next,
        "APPROVAL_CANCELLED",
        m.state,
        {
          actionId: a.id,
          approvalId: p?.id ?? null,
          reason: "HUMAN_CANCELLED",
        },
        tx,
      );
      return next;
    });
    return c.json(await detail(m));
  });
  app.post("/api/actions/:id/confirm", async (c) => {
    const a = await ownedAction(c);
    if (classifyStatic(a) !== "CONSEQUENTIAL")
      throw new HttpError(403, "FORBIDDEN");
    await db.withLockedAction(a.id, async (tx) => {
      const m = await tx.get<Mission>("missions", a.missionId);
      if (!m || m.state !== "RUNNING" || Date.parse(a.expiresAt) <= Date.now())
        throw new HttpError(409, "CONFLICT");
      const b = approvalBinding(a),
        stamp = new Date().toISOString();
      await tx.insert("approvals", {
        id: randomUUID(),
        actionId: a.id,
        binding: b,
        bindingHash: hashCanonical(b),
        kind: "CONSEQUENTIAL_CONFIRMATION",
        status: "VERIFIED",
        createdAt: stamp,
        verifiedAt: stamp,
        consumedAt: null,
        nullifierHash: null,
      } satisfies Approval);
    });
    return c.json(await detail(await owner(c, a.missionId)));
  });
  app.post("/api/actions/:id/execute", async (c) => {
    const a = await ownedAction(c);
    const executor = createExecutor({
      ...(config.jawPermissionVerifier
        ? { jawPermissionVerifier: config.jawPermissionVerifier }
        : {}),
      db,
      readAuthorization: requireService(config.ens).readAuthorization,
      evaluate: requireService(config.models).evaluate,
      effect: requireService(config.effect),
      ...(config.updateEnsReceipt
        ? { updateEnsReceipt: config.updateEnsReceipt }
        : {}),
    });
    return c.json(await executor(a.id));
  });
  app.get("/api/internal/conversations/:id", async (c) => {
    const m = await owner(c, c.req.param("id"));
    return c.json({ mission: m });
  });
  app.post("/api/internal/missions/:id/prepare", async (c) => {
    if (
      !config.internalSecret ||
      c.req.header("authorization") !== `Bearer ${config.internalSecret}`
    )
      throw new HttpError(401, "UNAUTHENTICATED");
    const m = await db.get<Mission>("missions", c.req.param("id"));
    if (!m || m.state !== "RUNNING" || !m.agentEns)
      throw new HttpError(409, "CONFLICT");
    const models = requireService(config.models);
    const receipts = (await db.list<ExecutionReceipt>("receipts")).filter(
      (r) => r.missionId === m.id,
    );
    const draft = await models.proposeNextAction({ mission: m, receipts });
    if (!["SUBMIT_APPLICATION", "CREATE_CALENDAR_EVENT"].includes(draft.type))
      throw new HttpError(
        400,
        "INVALID_REQUEST",
        "MVP supports application submission and calendar creation.",
      );
    const existing = (await db.list<ActionProposal>("actions")).find(
      (a) => a.missionId === m.id && a.type === draft.type,
    );
    if (existing) return c.json(await detail(m));
    if (
      draft.type === "CREATE_CALENDAR_EVENT" &&
      !receipts.some((r) => r.status === "SUCCEEDED")
    )
      throw new HttpError(
        409,
        "CONFLICT",
        "Application must succeed before calendar creation.",
      );
    const stamp = new Date().toISOString();
    const action: ActionProposal = {
      ...draft,
      id: randomUUID(),
      rootId: m.rootId,
      missionId: m.id,
      agentEns: m.agentEns,
      nonce: randomUUID(),
      payloadHash: hashCanonical(draft.payload),
      createdAt: stamp,
      expiresAt: new Date(
        Math.min(Date.parse(m.expiresAt), Date.now() + 15 * 60000),
      ).toISOString(),
    };
    const assessment = await models.evaluate({ mission: m, action });
    const authorization = await requireService(config.ens).readAuthorization(
      m.agentEns,
    );
    const decision = authorize({
      mission: m,
      action,
      authorization,
      assessment,
      now: new Date(),
      pinnedJevModelVersion: JEV_MODEL,
      questionVersion: JEV_QUESTION_VERSION,
    });
    if (
      !decision.allowed &&
      decision.reasons.some((reason) => reason !== "APPROVAL_REQUIRED")
    )
      throw new HttpError(403, "FORBIDDEN", decision.reasons.join(", "));
    await db.transaction(async (tx) => {
      const fresh = await tx.lockMission(m.id);
      if (hashCanonical(fresh) !== hashCanonical(m))
        throw new HttpError(409, "CONFLICT");
      const duplicate = (await tx.list<ActionProposal>("actions")).find(
        (a) => a.missionId === m.id && a.type === action.type,
      );
      if (!duplicate) await tx.insert("actions", action);
      await tx.put("agents", {
        id: `evaluation:${m.id}`,
        assessment,
        decision,
      });
    });
    await audit(m, "ACTION_PREPARED", m.state, {
      actionId: action.id,
      payloadHash: action.payloadHash,
    });
    return c.json(await detail(m));
  });
  if (config.workflows) app.route("/api", createWorkflowRoutes(config.workflows, async c => {
    const s = await session(c);
    if (!s?.accountId || !(await db.get<WalletAccount>("accounts", s.accountId))) throw new HttpError(401, "UNAUTHENTICATED");
    if (s.rootId) await linkedSession(c);
    return { accountId: s.accountId, rootId: s.rootId, sessionId: s.id };
  }));
  return app;
}
