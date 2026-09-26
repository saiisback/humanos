import {
  Pool,
  type PoolClient,
  type QueryResult,
  type QueryResultRow,
} from "pg";
import { readFile } from "node:fs/promises";
import type {
  ActionProposal,
  Approval,
  ExecutionReceipt,
  Mission,
  RootAccountBinding,
} from "@humanos/schemas";
import { hashCanonical } from "@humanos/schemas";
import { tableName, validateEntity, type Table } from "./schema.js";
export * from "./schema.js";
export { WorkflowStore, type WorkflowLease } from "./workflows.js";
export { WorkflowAgentStore, type WorkflowAgentEvidence } from "./workflow-agents.js";
interface Runner {
  query<T extends QueryResultRow = QueryResultRow>(
    sql: string,
    values?: unknown[],
  ): Promise<QueryResult<T>>;
}
class Repository {
  constructor(protected readonly runner: Runner) {}
  query<T extends QueryResultRow = QueryResultRow>(
    sql: string,
    values?: unknown[],
  ): Promise<QueryResult<T>> {
    return this.runner.query<T>(sql, values);
  }
  async get<T>(table: Table, id: string): Promise<T | null> {
    const r = await this.query<{ data: T }>(
      `SELECT data FROM ${tableName(table)} WHERE id=$1`,
      [id],
    );
    return r.rows[0]?.data ?? null;
  }
  async list<T>(table: Table): Promise<T[]> {
    return (
      await this.query<{ data: T }>(
        `SELECT data FROM ${tableName(table)} ORDER BY created_at,id`,
      )
    ).rows.map((r) => r.data);
  }
  async insert<T extends { id: string }>(table: Table, entity: T): Promise<T> {
    validateEntity(table, entity);
    await this.query(
      `INSERT INTO ${tableName(table)} (id,data) VALUES ($1,$2::jsonb)`,
      [entity.id, JSON.stringify(entity)],
    );
    return entity;
  }
  async put<T extends { id: string }>(table: Table, entity: T): Promise<T> {
    if (["approvals", "receipts", "audit", "nullifiers"].includes(table))
      throw new Error("IMMUTABLE_ENTITY");
    validateEntity(table, entity);
    await this.query(
      `INSERT INTO ${tableName(table)} (id,data) VALUES ($1,$2::jsonb) ON CONFLICT(id) DO UPDATE SET data=EXCLUDED.data`,
      [entity.id, JSON.stringify(entity)],
    );
    return entity;
  }
  async delete(table: Table, id: string): Promise<boolean> {
    if (["approvals", "receipts", "audit", "nullifiers"].includes(table))
      throw new Error("IMMUTABLE_ENTITY");
    return (
      (await this.query(`DELETE FROM ${tableName(table)} WHERE id=$1`, [id]))
        .rowCount === 1
    );
  }
}
export class Transaction extends Repository {
  constructor(client: PoolClient) {
    super(client);
  }
  async bindRootAccount(
    rootId: string,
    accountId: string,
    now: Date,
  ): Promise<RootAccountBinding> {
    const account = await this.query(
      "SELECT id FROM accounts WHERE id=$1 FOR UPDATE",
      [accountId],
    );
    if (!account.rows[0]) throw new Error("ACCOUNT_NOT_FOUND");
    const root = await this.query(
      "SELECT id FROM roots WHERE id=$1 FOR UPDATE",
      [rootId],
    );
    if (!root.rows[0]) throw new Error("ROOT_NOT_FOUND");
    const existing = await this.query<{ data: RootAccountBinding }>(
      "SELECT data FROM root_bindings WHERE root_id=$1 OR account_id=$2",
      [rootId, accountId],
    );
    const existingBinding = existing.rows[0]?.data;
    if (existingBinding) {
      if (
        existingBinding.rootId === rootId &&
        existingBinding.accountId === accountId
      )
        return existingBinding;
      throw new Error("ROOT_ACCOUNT_CONFLICT");
    }
    const binding: RootAccountBinding = {
      id: hashCanonical({ rootId, accountId }),
      rootId,
      accountId,
      createdAt: now.toISOString(),
    };
    return this.insert("root_bindings", binding);
  }
  async lockMission(id: string): Promise<Mission> {
    const r = await this.query<{ data: Mission }>(
      "SELECT data FROM missions WHERE id=$1 FOR UPDATE",
      [id],
    );
    if (!r.rows[0]) throw new Error("MISSION_NOT_FOUND");
    return r.rows[0].data;
  }
  async updateApprovalStatus(
    id: string,
    status: "VERIFIED" | "DENIED" | "CANCELLED",
    verification?: { verifiedAt: string; nullifierHash: string | null },
  ): Promise<Approval> {
    const selected = await this.query<{ data: Approval }>(
      "SELECT data FROM approvals WHERE id=$1 FOR UPDATE",
      [id],
    );
    const current = selected.rows[0]?.data;
    const now = Date.now();
    if (
      !current ||
      !(
        current.status === "PENDING" ||
        (status === "CANCELLED" && current.status === "VERIFIED")
      ) ||
      current.consumedAt !== null ||
      (status !== "CANCELLED" && Date.parse(current.binding.expiresAt) <= now)
    )
      throw new Error("APPROVAL_NOT_PENDING");
    if (
      status === "VERIFIED" &&
      (!verification ||
        Date.parse(verification.verifiedAt) > now ||
        Date.parse(verification.verifiedAt) < Date.parse(current.createdAt) ||
        !Number.isFinite(Date.parse(verification.verifiedAt)) ||
        (current.kind === "WORLD_FRESH" && !verification.nullifierHash))
    )
      throw new Error("VERIFICATION_REQUIRED");
    const next: Approval = {
      ...current,
      status,
      verifiedAt:
        status === "VERIFIED" ? verification!.verifiedAt : current.verifiedAt,
      nullifierHash:
        status === "VERIFIED"
          ? verification!.nullifierHash
          : current.nullifierHash,
    };
    validateEntity("approvals", next);
    await this.query("UPDATE approvals SET data=$2::jsonb WHERE id=$1", [
      id,
      JSON.stringify(next),
    ]);
    return next;
  }
  async consumeApproval(id: string, now: Date): Promise<Approval> {
    const r = await this.query<{ data: Approval }>(
      `UPDATE approvals SET data=jsonb_set(jsonb_set(data,'{status}','"CONSUMED"'::jsonb),'{consumedAt}',to_jsonb($2::text)) WHERE id=$1 AND data->>'status'='VERIFIED' AND data->>'consumedAt' IS NULL AND (data->'binding'->>'expiresAt')::timestamptz > $2::timestamptz RETURNING data`,
      [id, now.toISOString()],
    );
    if (!r.rows[0]) throw new Error("APPROVAL_NOT_CONSUMABLE");
    return r.rows[0].data;
  }
  async consumeChallenge<T>(id: string, now: Date): Promise<T> {
    const r = await this.query<{ data: T }>(
      `UPDATE challenges SET data=jsonb_set(data,'{consumedAt}',to_jsonb($2::text)) WHERE id=$1 AND data->>'consumedAt' IS NULL AND (data->>'expiresAt')::timestamptz > $2::timestamptz RETURNING data`,
      [id, now.toISOString()],
    );
    if (!r.rows[0]) throw new Error("CHALLENGE_NOT_CONSUMABLE");
    return r.rows[0].data;
  }
  async claimNullifier(id: string, rootId: string): Promise<void> {
    await this.insert("nullifiers", { id, rootId });
  }
  async getReceiptForAction(
    actionId: string,
  ): Promise<ExecutionReceipt | null> {
    const r = await this.query<{ data: ExecutionReceipt }>(
      "SELECT data FROM receipts WHERE action_id=$1",
      [actionId],
    );
    return r.rows[0]?.data ?? null;
  }
}
export class Database extends Repository {
  private readonly pool: Pool;
  private readonly schema: string;
  constructor(connectionString: string, options: { schema?: string } = {}) {
    const schema = options.schema ?? "public";
    if (!/^[a-z_][a-z0-9_]*$/.test(schema)) throw new Error("INVALID_SCHEMA");
    const pool = new Pool({
      connectionString,
      options: `-c search_path=${schema},public`,
      max: 10,
    });
    super(pool);
    this.pool = pool;
    this.schema = schema;
  }
  async migrate(): Promise<void> {
    await this.query(`CREATE SCHEMA IF NOT EXISTS "${this.schema}"`);
    await this.transaction(async (tx) => {
      await tx.query("SELECT pg_advisory_xact_lock(hashtext($1))", [
        this.schema + ":humanos:migrations",
      ]);
      for (const file of ["0001_initial.sql", "0002_workflows.sql", "0003_workflow_agents.sql", "0004_workflow_agent_jobs.sql"]) {
        await tx.query(
          await readFile(
            new URL(`../migrations/${file}`, import.meta.url),
            "utf8",
          ),
        );
      }
    });
  }
  async close(): Promise<void> {
    await this.pool.end();
  }
  async transaction<T>(callback: (tx: Transaction) => Promise<T>): Promise<T> {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      const result = await callback(new Transaction(client));
      await client.query("COMMIT");
      return result;
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  }
  async withLockedAction<T>(
    actionId: string,
    callback: (tx: Transaction, action: ActionProposal) => Promise<T>,
  ): Promise<T> {
    return this.transaction(async (tx) => {
      const initial = await tx.get<ActionProposal>("actions", actionId);
      if (!initial) throw new Error("ACTION_NOT_FOUND");
      await tx.lockMission(initial.missionId);
      const locked = await tx.query<{ data: ActionProposal }>(
        "SELECT data FROM actions WHERE id=$1 FOR UPDATE",
        [actionId],
      );
      const action = locked.rows[0]?.data;
      if (!action || action.missionId !== initial.missionId)
        throw new Error("ACTION_CHANGED");
      return callback(tx, action);
    });
  }
}
