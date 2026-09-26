import type { Database } from "./index.js";
export interface McpConnectionData {
  workspaceId: string; workspaceName: string; destinationId: string; destinationName: string; credentialHash: string;
}
export interface McpConnection extends McpConnectionData { version: number; status: "connected" | "revoked" }
export function createMcpStore(db: Database) {
  return {
    async connection(account: string, provider: string): Promise<McpConnection | null> {
      const row = (await db.query<{data: McpConnectionData; version: number; status: McpConnection["status"]}>("SELECT data,version,status FROM mcp_connections WHERE account_id=$1 AND provider=$2", [account, provider])).rows[0];
      return row ? { ...row.data, version: row.version, status: row.status } : null;
    },
    async select(account: string, provider: string, data: McpConnectionData): Promise<McpConnection> {
      const row = (await db.query<{version: number}>(`INSERT INTO mcp_connections(account_id,provider,version,status,data) VALUES($1,$2,1,'connected',$3)
        ON CONFLICT(account_id,provider) DO UPDATE SET version=mcp_connections.version+1,status='connected',data=EXCLUDED.data RETURNING version`, [account, provider, JSON.stringify(data)])).rows[0]!;
      return { ...data, version: row.version, status: "connected" };
    },
    async disconnect(account: string, provider: string) {
      await db.query("UPDATE mcp_connections SET status='revoked',version=version+1 WHERE account_id=$1 AND provider=$2", [account, provider]);
    },
    async claim(account: string, key: string, hash: string): Promise<boolean> {
      const result = await db.query("INSERT INTO mcp_dispatches(account_id,request_key,request_hash) VALUES($1,$2,$3) ON CONFLICT DO NOTHING", [account,key,hash]);
      if (result.rowCount === 1) return true;
      const existing = await this.get(account, key);
      if (!existing || existing.requestHash !== hash) throw new Error("IDEMPOTENCY_CONFLICT");
      return false;
    },
    async get(account: string, key: string): Promise<{requestHash: string; objectId: string | null} | null> {
      return (await db.query<{requestHash: string; objectId: string | null}>(`SELECT request_hash AS "requestHash",object_id AS "objectId" FROM mcp_dispatches WHERE account_id=$1 AND request_key=$2`, [account,key])).rows[0] ?? null;
    },
    async recordId(account: string, key: string, id: string) {
      const result = await db.query("UPDATE mcp_dispatches SET object_id=$3 WHERE account_id=$1 AND request_key=$2 AND (object_id IS NULL OR object_id=$3)", [account,key,id]);
      if (result.rowCount !== 1) throw new Error("MCP_OBJECT_CONFLICT");
    },
  };
}
export type McpStore = ReturnType<typeof createMcpStore>;
