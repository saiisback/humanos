/** Test-only harness. Real API + PostgreSQL + policy; all external providers below are fixtures. */
import { createServer } from "node:http";
import { randomBytes, randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { resolve, extname } from "node:path";
import { Database } from "../../packages/database/src/index.js";
import { createApi, type ApiConfig } from "../../apps/api/src/app.js";
import { createWorldVerifier } from "../../packages/world/src/index.js";
import {
  hashCanonical,
  type Mission,
  type ActionProposal,
  type ActionProposalDraft,
  type WorldProofRequest,
} from "../../packages/schemas/src/index.js";
import {
  JEV_MODEL,
  JEV_QUESTION_VERSION,
} from "../../packages/models/src/index.js";
const worldRequire = createRequire(
  new URL("../../packages/world/package.json", import.meta.url),
);
const { hashSignal } = worldRequire("@worldcoin/idkit-core/hashing") as {
  hashSignal: (signal: string) => string;
};
export async function startBackendHarness() {
  const schema = "e2e_" + randomBytes(8).toString("hex");
  const db = new Database(
    process.env.TEST_DATABASE_URL ??
      "postgresql://saikarthik@127.0.0.1:55432/humanos",
    { schema },
  );
  await db.migrate();
  const effects = new Map<string, number>();
  const ambiguousActions = new Set<string>();
  const reconciliations = new Map<string, number>();
  const revoked = new Set<string>();
  const config: ApiConfig = {
    db,
    origin: "",
    internalSecret: "e2e-internal-only",
    world: createWorldVerifier({
      appId: "app_fixture",
      rpId: "rp_fixture",
      signingKey: "0x" + "11".repeat(32),
      environment: "staging",
      fetch: async () =>
        Response.json({
          success: true,
          environment: "staging",
          results: [{ identifier: "proof_of_human", success: true }],
        }),
    }),
    models: {
      async proposeMission(input) {
        return {
          goal: (input as { goal: string }).goal,
          title: "Backend-connected Tokyo mission",
          capabilities: ["application.submit", "calendar.create"],
          steps: [
            "Prepare the application",
            "Verify submission",
            "Create the calendar event",
          ],
          expiresAt: new Date(Date.now() + 3600000).toISOString(),
        };
      },
      async proposeNextAction(input): Promise<ActionProposalDraft> {
        const { receipts } = input as { receipts: unknown[] };
        return receipts.length
          ? {
              type: "CREATE_CALENDAR_EVENT",
              capability: "calendar.create",
              payload: {
                title: "Tokyo event",
                startsAt: "2026-10-01T09:00:00Z",
              },
              reason: "Add the approved trip to the calendar",
            }
          : {
              type: "SUBMIT_APPLICATION",
              capability: "application.submit",
              payload: { event: "Tokyo", participant: "Test human" },
              reason: "Submit the reviewed application",
            };
      },
      async evaluate({ mission, action }) {
        return {
          stateHash: hashCanonical({ mission, action }),
          questionVersion: JEV_QUESTION_VERSION,
          modelVersion: JEV_MODEL,
          evaluatedAt: new Date().toISOString(),
          risk:
            action.type === "SUBMIT_APPLICATION"
              ? "SENSITIVE"
              : "CONSEQUENTIAL",
          missionAligned: true,
          injectionDetected: false,
          requiresReview: false,
          confidence: 1,
          missionAlignmentScore: 1,
          injectionScore: 0,
          reason: "Explicit test fixture assessment; not live Jev evidence",
        };
      },
    },
    ens: {
      async register(m) {
        return `agent-${m.id}.fixture.eth`;
      },
      async revoke(m) {
        if (m.agentEns) revoked.add(m.agentEns);
      },
      async readAuthorization(name) {
        const m = (await db.list<Mission>("missions")).find(
          (m) => m.agentEns === name,
        );
        if (!m) throw new Error("UNKNOWN_AGENT");
        return {
          agentEns: name,
          rootId: m.rootId,
          capabilities: m.approvedCapabilities,
          active: !revoked.has(name),
          revoked: revoked.has(name),
          expiresAt: m.expiresAt,
          checkedAt: new Date().toISOString(),
          blockNumber: 1,
          finalized: true,
        };
      },
    },
    effect: {
      async execute(a) {
        effects.set(a.id, (effects.get(a.id) ?? 0) + 1);
        if (ambiguousActions.has(a.id))
          throw new Error("Fixture response lost after external effect");
        return {
          externalId: "fixture-" + a.id,
          payloadHash: a.payloadHash,
          kind: a.type === "SUBMIT_APPLICATION" ? "application" : "calendar",
        };
      },
      async reconcile(a) {
        if (!effects.has(a.id)) throw new Error("No prior external effect");
        reconciliations.set(a.id, (reconciliations.get(a.id) ?? 0) + 1);
        return {
          externalId: "fixture-" + a.id,
          payloadHash: a.payloadHash,
          kind: a.type === "SUBMIT_APPLICATION" ? "application" : "calendar",
        };
      },
    },
  };
  let app: ReturnType<typeof createApi> | null = null;
  const assets = resolve("apps/web/dist");
  const server = createServer(async (req, res) => {
    try {
      const url = new URL(req.url ?? "/", config.origin);
      let response: Response;
      if (url.pathname.startsWith("/agents/humanos/")) {
        const id = url.pathname.split("/").at(-1)!;
        response = await app!.request(`/api/internal/missions/${id}/prepare`, {
          method: "POST",
          headers: { authorization: "Bearer e2e-internal-only" },
        });
      } else if (url.pathname.startsWith("/api/")) {
        const chunks: Buffer[] = [];
        for await (const chunk of req) chunks.push(Buffer.from(chunk));
        const body = Buffer.concat(chunks);
        response = await app!.fetch(
          new Request(url, {
            method: req.method ?? "GET",
            headers: req.headers as Record<string, string>,
            ...(body.length ? { body } : {}),
          }),
        );
      } else {
        const path = url.pathname.startsWith("/assets/")
          ? resolve(assets, "." + url.pathname)
          : resolve(assets, "index.html");
        if (!path.startsWith(assets + "/")) throw new Error("INVALID_PATH");
        const content = await readFile(path);
        const type: Record<string, string> = {
          ".html": "text/html",
          ".js": "text/javascript",
          ".css": "text/css",
          ".wasm": "application/wasm",
          ".woff": "font/woff",
          ".woff2": "font/woff2",
        };
        response = new Response(content, {
          headers: {
            "content-type": type[extname(path)] ?? "application/octet-stream",
          },
        });
      }
      res.statusCode = response.status;
      response.headers.forEach((v, k) => res.setHeader(k, v));
      res.end(Buffer.from(await response.arrayBuffer()));
    } catch (e) {
      res.statusCode = 500;
      res.end(String(e));
    }
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("NO_ADDRESS");
  config.origin = `http://127.0.0.1:${address.port}`;
  config.flueUrl = config.origin;
  app = createApi(config);
  const nullifiers = new Map<string, string>();
  return {
    url: config.origin,
    db,
    effects,
    ambiguousActions,
    reconciliations,
    async seed() {
      const rootId = randomUUID(),
        token = randomBytes(32).toString("hex");
      const now = new Date().toISOString();
      const address = `0x${randomBytes(20).toString("hex")}`;
      const accountId = `11155111:${address}`;
      const nullifier = BigInt(
        `0x${randomBytes(16).toString("hex")}`,
      ).toString();
      nullifiers.set(rootId, nullifier);
      await db.insert("accounts", {
        id: accountId,
        address,
        chainId: 11155111,
        createdAt: now,
      });
      await db.insert("roots", {
        id: rootId,
        ensName: "test-human.fixture.eth",
        createdAt: now,
        verificationEnvironment: "staging",
      });
      await db.insert("root_bindings", {
        id: hashCanonical({ rootId, accountId }),
        rootId,
        accountId,
        createdAt: now,
      });
      await db.insert("nullifiers", {
        id: hashCanonical({
          rpId: "rp_fixture",
          environment: "staging",
          nullifier,
        }),
        rootId,
      });
      await db.insert("sessions", {
        id: hashCanonical(token),
        accountId,
        rootId,
        expiresAt: new Date(Date.now() + 3600000).toISOString(),
      });
      return token;
    },
    async proof(requestId: string) {
      const challenge = await db.get<{
        id: string;
        request: WorldProofRequest;
      }>("challenges", requestId);
      if (!challenge) throw new Error("NO_CHALLENGE");
      const q = challenge.request;
      const session = await db.get<{ rootId: string | null }>(
        "sessions",
        (challenge as { sessionId: string }).sessionId,
      );
      const nullifier = session?.rootId ? nullifiers.get(session.rootId) : null;
      if (!nullifier) throw new Error("NO_FIXTURE_NULLIFIER");
      return {
        protocol_version: "4.0",
        action: q.action,
        nonce: q.rpContext.nonce,
        environment: "staging",
        responses: [
          {
            identifier: "proof_of_human",
            issuer_schema_id: 1,
            proof: ["0x1", "0x2", "0x3", "0x4", "0x5"],
            signal_hash: hashSignal(q.signal),
            nullifier: `0x${BigInt(nullifier).toString(16)}`,
            expires_at_min: Math.ceil(Date.now() / 60000) + 5,
          },
        ],
      };
    },
    async expire(id: string) {
      const m = await db.get<Mission>("missions", id);
      if (!m) throw new Error("NO_MISSION");
      await db.put("missions", {
        ...m,
        expiresAt: new Date(Date.now() - 1000).toISOString(),
      });
    },
    async actions(id: string) {
      return (await db.list<ActionProposal>("actions")).filter(
        (a) => a.missionId === id,
      );
    },
    async close() {
      await new Promise<void>((resolve, reject) =>
        server.close((e) => (e ? reject(e) : resolve())),
      );
      await db.query(`DROP SCHEMA "${schema}" CASCADE`);
      await db.close();
    },
  };
}
