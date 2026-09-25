import * as v from "valibot";
import type { Database, SessionRecord, Transaction } from "@humanos/database";
import {
  jawGrantHash,
  matchesJawReview,
  validJawEvidence,
  RecordJawPermissionSchema,
  type JawPermissionGrant,
  type JawPermissionReview,
  type JawPermissionVerifier,
  type WalletAccount,
  type Mission,
} from "@humanos/schemas";

export class PermissionError extends Error {
  constructor(
    readonly status: 401 | 403 | 404 | 409,
    readonly code: string,
  ) {
    super(code);
  }
}
// Lock order: session -> account -> mission -> permission. Executor starts at
// mission -> action -> permission and never subsequently takes account/session.
async function lockOwner(tx: Transaction, expected: SessionRecord) {
  const session = (
    await tx.query<{ data: SessionRecord }>(
      "SELECT data FROM sessions WHERE id=$1 FOR UPDATE",
      [expected.id],
    )
  ).rows[0]?.data;
  if (
    !session ||
    session.accountId !== expected.accountId ||
    !session.rootId ||
    session.rootId !== expected.rootId ||
    Date.parse(session.expiresAt) <= Date.now()
  )
    throw new PermissionError(401, "UNAUTHENTICATED");
  const account = (
    await tx.query<{ data: WalletAccount }>(
      "SELECT data FROM accounts WHERE id=$1 FOR UPDATE",
      [session.accountId],
    )
  ).rows[0]?.data;
  const binding = (
    await tx.query<{ root_id: string }>(
      "SELECT root_id FROM root_bindings WHERE account_id=$1",
      [session.accountId],
    )
  ).rows[0];
  if (
    !account ||
    account.chainId !== 11155111 ||
    binding?.root_id !== session.rootId ||
    !(await tx.get("roots", session.rootId))
  )
    throw new PermissionError(403, "HUMAN_VERIFICATION_REQUIRED");
  return { session, account };
}
function live(session: SessionRecord, mission?: Mission) {
  if (Date.parse(session.expiresAt) <= Date.now())
    throw new PermissionError(401, "UNAUTHENTICATED");
  if (
    mission &&
    (Date.parse(mission.expiresAt) <= Date.now() ||
      !["AUTHORIZED", "RUNNING", "AWAITING_APPROVAL"].includes(mission.state))
  )
    throw new PermissionError(409, "MISSION_NOT_ACTIVE");
}
export function createPermissionService(
  db: Database,
  verifier?: JawPermissionVerifier,
) {
  return {
    list: (expected: SessionRecord) =>
      db.transaction(async (tx) => {
        const { session } = await lockOwner(tx, expected);
        const missions = new Set(
          (await tx.list<Mission>("missions"))
            .filter((m) => m.rootId === session.rootId)
            .map((m) => m.id),
        );
        const grants = (
          await tx.list<JawPermissionGrant>("jaw_permissions")
        ).filter(
          (g) => g.accountId === session.accountId && missions.has(g.missionId),
        );
        live(session);
        return grants.map((g) =>
          (g.status === "ACTIVE" || g.status === "UNVERIFIED") &&
          g.end * 1000 <= Date.now()
            ? { ...g, status: "EXPIRED" as const }
            : g,
        );
      }),
    record: async (expected: SessionRecord, body: unknown) => {
      const { grant } = v.parse(RecordJawPermissionSchema, body);
      if (grant.status !== "UNVERIFIED" || grant.revokedAt !== null)
        throw new PermissionError(409, "INVALID_GRANT_STATUS");
      return db.transaction(async (tx) => {
        const { session, account } = await lockOwner(tx, expected);
        if (!(await tx.get<Mission>("missions", grant.missionId)))
          throw new PermissionError(404, "NOT_FOUND");
        const mission = await tx.lockMission(grant.missionId);
        if (
          mission.rootId !== session.rootId ||
          grant.accountId !== session.accountId ||
          grant.account !== account.address
        )
          throw new PermissionError(404, "NOT_FOUND");
        // Serialize first inserts too, including accidental reuse across missions/accounts.
        await tx.query("SELECT pg_advisory_xact_lock(hashtext($1))", [
          `jaw:${grant.permissionId}`,
        ]);
        const existing = await tx.get<JawPermissionGrant>(
          "jaw_permissions",
          grant.id,
        );
        live(session, mission);
        if (existing) {
          if (jawGrantHash(existing) !== jawGrantHash(grant))
            throw new PermissionError(409, "PERMISSION_CONFLICT");
          live(session);
          return existing; // Never revive a revoked/uncertain grant on replay.
        }
        const review = await tx.get<JawPermissionReview>(
          "jaw_reviews",
          grant.reviewId,
        );
        if (
          !review ||
          !matchesJawReview(grant, review) ||
          grant.end * 1000 > Date.parse(mission.expiresAt) ||
          grant.start > Math.floor(Date.now() / 1000)
        )
          throw new PermissionError(409, "PERMISSION_REVIEW_MISMATCH");
        let status: JawPermissionGrant["status"] = "UNVERIFIED";
        if (verifier) {
          try {
            const evidence = await verifier.verify(grant);
            if (
              validJawEvidence(grant, evidence, Date.now()) &&
              evidence.state === "ACTIVE"
            )
              status = "ACTIVE";
          } catch {
            /* Persist metadata; unavailable evidence grants no authority. */
          }
        }
        live(session, mission);
        if (grant.end * 1000 <= Date.now())
          throw new PermissionError(409, "PERMISSION_EXPIRED");
        return tx.insert("jaw_permissions", {
          ...grant,
          status,
          createdAt: new Date().toISOString(),
        });
      });
    },
    revoke: async (expected: SessionRecord, id: string, body: unknown) => {
      v.parse(v.strictObject({ success: v.literal(true) }), body);
      return db.transaction(async (tx) => {
        const { session } = await lockOwner(tx, expected);
        const initial = await tx.get<JawPermissionGrant>("jaw_permissions", id);
        if (!initial || initial.accountId !== session.accountId)
          throw new PermissionError(404, "NOT_FOUND");
        const mission = await tx.lockMission(initial.missionId);
        if (mission.rootId !== session.rootId)
          throw new PermissionError(404, "NOT_FOUND");
        await tx.query("SELECT pg_advisory_xact_lock(hashtext($1))", [
          `jaw:${id}`,
        ]);
        const grant = (await tx.get<JawPermissionGrant>(
          "jaw_permissions",
          id,
        ))!;
        if (!["ACTIVE", "UNVERIFIED"].includes(grant.status)) {
          live(session);
          return grant;
        }
        let confirmed = false;
        if (verifier) {
          try {
            const evidence = await verifier.verify(grant);
            confirmed =
              validJawEvidence(grant, evidence, Date.now()) &&
              evidence.state === "REVOKED";
          } catch {
            /* Uncertain revocation still disables local authority. */
          }
        }
        live(session);
        const next: JawPermissionGrant = {
          ...grant,
          status: confirmed ? "REVOKED" : "RECONCILIATION_REQUIRED",
          revokedAt: confirmed ? new Date().toISOString() : null,
        };
        await tx.put("jaw_permissions", next);
        return next;
      });
    },
  };
}
