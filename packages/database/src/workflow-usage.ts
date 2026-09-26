import type { Database } from "./index.js";
export interface UsageContext {
  accountId: string; workflowId: string; versionId: string;
  runId: string | null; stepId: string | null; phase: "planning" | "execution";
}
export interface UsageRow {
  context: UsageContext;
  event: Record<string, unknown>;
}
export function createWorkflowUsageStore(db: Database) {
  return {
    async upsertAttempt(context: UsageContext, event: { attemptId: string; status: string; [key: string]: unknown }) {
      const result = await db.query(
        `INSERT INTO workflow_usage(id,account_id,workflow_id,context,event) VALUES($1,$2,$3,$4,$5)
         ON CONFLICT(id) DO UPDATE SET event=EXCLUDED.event,updated_at=now()
         WHERE workflow_usage.context=EXCLUDED.context AND (workflow_usage.event->>'status'='started' OR workflow_usage.event=EXCLUDED.event)`,
        [event.attemptId, context.accountId, context.workflowId, JSON.stringify(context), JSON.stringify(event)],
      );
      if (result.rowCount !== 1) throw new Error("USAGE_ATTEMPT_CONFLICT");
    },
    async listForWorkflow(accountId: string, workflowId: string): Promise<UsageRow[]> {
      return (await db.query<UsageRow>("SELECT context,event FROM workflow_usage WHERE account_id=$1 AND workflow_id=$2 ORDER BY created_at,id", [accountId, workflowId])).rows;
    },
  };
}
