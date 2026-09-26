import * as v from "valibot";
import { hashCanonical } from "@humanos/schemas";
import type { McpStore, McpConnection } from "@humanos/database";
import { ConnectorProviderError, type ConnectorAdapter, type ConnectorExecutionInput } from "../connectors.js";
import { openReviewedMcpSession } from "./client.js";
import { linearContracts } from "./linear-contracts.js";
import { linearInput, linearOperation } from "./operations.js";
import { validateReceiptUrl } from "./policy.js";
const short = v.pipe(v.string(), v.minLength(1), v.maxLength(256));
const workspaceSchema = v.object({ id: short, name: short });
const teamsSchema = v.object({ teams: v.array(v.object({ id: short, name: short })), hasNextPage: v.boolean() });
const issueSchema = v.object({ id: short, uuid: v.optional(short), title: short, description: v.string(), teamId: short, url: v.string() });
type Session = { call(name: string, args: Record<string, unknown>, signal: AbortSignal): Promise<unknown>; close(): Promise<void> };
export function createLinearService(config: { store: McpStore; token(account: string): string | null; session?: (token: string) => Promise<Session> }) {
  const session = config.session ?? (token => openReviewedMcpSession("linear", token, linearContracts));
  async function connected(account: string): Promise<McpConnection | null> {
    const token = config.token(account), c = await config.store.connection(account, "linear");
    return token && c?.status === "connected" && c.credentialHash === hashCanonical(token) ? c : null;
  }
  const publicBinding = (c: McpConnection) => ({ provider: "linear", workspaceId: c.workspaceId, workspace: c.workspaceName,
    destinationId: c.destinationId, team: c.destinationName, connectionVersion: c.version });
  async function destinations(account: string) {
    const token = config.token(account); if (!token) throw new Error("CONNECTION_REQUIRED");
    const s = await session(token);
    try {
      const signal = AbortSignal.timeout(30000);
      const workspace = v.parse(workspaceSchema, await s.call("get_workspace", {}, signal));
      const teams = v.parse(teamsSchema, await s.call("list_teams", { limit: 250 }, signal));
      // Bounded first release: do not silently omit destinations in large workspaces.
      if (teams.hasNextPage) throw new Error("MCP_TEAM_LIST_REQUIRES_PAGINATION");
      return { workspace, teams: teams.teams };
    } finally { await s.close(); }
  }
  async function execute(input: ConnectorExecutionInput) {
    const c = await connected(input.accountId);
    if (!c || hashCanonical(publicBinding(c)) !== hashCanonical(input.binding)) throw new ConnectorProviderError("CONFIRMATION");
    const args = v.parse(linearInput, input.input).arguments;
    const requestHash = hashCanonical({ input: input.input, binding: input.binding });
    const s = await session(config.token(input.accountId)!);
    try {
      // Session setup can take time; recheck revocation before claiming a dispatch.
      const latest = await connected(input.accountId);
      if (!latest || latest.version !== c.version || input.signal.aborted || !await input.authorize?.()) throw new ConnectorProviderError("AUTHORIZATION");
      const fresh = await config.store.claim(input.accountId, input.idempotencyKey, requestHash);
      if (fresh) {
        try {
          const created = v.parse(v.object({ id: short }), await s.call("save_issue", { team: c.destinationId, title: args.title, description: args.body }, input.signal));
          await config.store.recordId(input.accountId, input.idempotencyKey, created.id);
        } catch { throw new ConnectorProviderError("UNKNOWN_OUTCOME"); }
      }
      const dispatch = await config.store.get(input.accountId, input.idempotencyKey);
      if (!dispatch?.objectId) throw new ConnectorProviderError("UNKNOWN_OUTCOME");
      try {
        const result = v.parse(issueSchema, await s.call("get_issue", { id: dispatch.objectId }, input.signal));
        if (![result.id, result.uuid].includes(dispatch.objectId) || result.teamId !== c.destinationId || result.title !== args.title || result.description !== args.body) throw new Error("READBACK_MISMATCH");
        const url = validateReceiptUrl("linear", result.url);
        return { output: { provider: "linear", id: result.id, url, verified: true }, providerReference: result.id };
      } catch { throw new ConnectorProviderError("UNKNOWN_OUTCOME"); }
    } finally { await s.close().catch(() => {}); }
  }
  const adapter: ConnectorAdapter = {
    id: "linear", label: "Linear", operations: [linearOperation],
    connection: async account => ({ status: await connected(account) ? "connected" : "missing" }),
    binding: async account => { const c = await connected(account); return c ? publicBinding(c) : null; },
    execute,
    reconcile: async input => {
      const row = await config.store.get(input.accountId, input.idempotencyKey);
      return row?.objectId ? execute(input) : null;
    },
  };
  return { adapter, destinations,
    async select(account: string, destinationId: string) {
      const data = await destinations(account), team = data.teams.find(t => t.id === destinationId);
      if (!team) throw new Error("MCP_DESTINATION_NOT_ALLOWED");
      const token = config.token(account); if (!token) throw new Error("CONNECTION_REQUIRED");
      return publicBinding(await config.store.select(account, "linear", { workspaceId: data.workspace.id, workspaceName: data.workspace.name,
        destinationId: team.id, destinationName: team.name, credentialHash: hashCanonical(token) }));
    },
    disconnect: (account: string) => config.store.disconnect(account, "linear"),
  };
}
