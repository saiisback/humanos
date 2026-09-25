import { authorize, type AuthorizeInput } from "@humanos/policy";
import type { ExecutionReceipt } from "@humanos/schemas";
/** Supplied only by the backend: resolve fresh persisted state, never model parameters. */
export type ToolContext = Omit<
  AuthorizeInput,
  "now" | "pinnedJevModelVersion" | "questionVersion"
> & { approvedDocumentIds: readonly string[] };
export interface ToolGatewayDependencies {
  resolve: (actionId: string) => Promise<ToolContext>;
  pinnedJevModelVersion: string;
  questionVersion: string;
  /** Read from an owner/mission scoped data store, not a caller-selected file path or URL. */
  readDocument: (scope: {
    rootId: string;
    missionId: string;
    documentId: string;
  }) => Promise<string>;
  /** Persist idempotently by actionId in the owner's internal draft store. */
  saveDraft: (draft: {
    rootId: string;
    missionId: string;
    actionId: string;
    text: string;
  }) => Promise<void>;
  /** The atomic executor; it independently rechecks policy and consumes approvals. */
  executeApproved: (actionId: string) => Promise<ExecutionReceipt>;
  clock?: () => number;
}
export function createToolGateway(deps: ToolGatewayDependencies) {
  return {
    async invoke(actionId: string) {
      const context = await deps.resolve(actionId);
      if (context.action.id !== actionId)
        throw new Error("ACTION_IDENTITY_MISMATCH");
      const decision = authorize({
        ...context,
        now: new Date((deps.clock ?? Date.now)()),
        pinnedJevModelVersion: deps.pinnedJevModelVersion,
        questionVersion: deps.questionVersion,
      });
      if (!decision.allowed) throw new Error("TOOL_NOT_AUTHORIZED");
      const { action, mission } = context;
      if (
        action.type === "SUBMIT_APPLICATION" ||
        action.type === "CREATE_CALENDAR_EVENT"
      )
        return deps.executeApproved(action.id);
      // Escalated internal operations require the atomic approval flow, not this routine path.
      if (decision.requiresApproval)
        throw new Error("ATOMIC_APPROVAL_REQUIRED");
      const keys = Object.keys(action.payload).sort().join(",");
      if (action.type === "READ_DOCUMENT") {
        const documentId = action.payload.documentId;
        if (
          keys !== "documentId" ||
          typeof documentId !== "string" ||
          !context.approvedDocumentIds.includes(documentId)
        )
          throw new Error("DOCUMENT_NOT_APPROVED");
        const content = await deps.readDocument({
          rootId: mission.rootId,
          missionId: mission.id,
          documentId,
        });
        return {
          kind: "document" as const,
          documentId,
          trust: "UNTRUSTED_DATA" as const,
          content,
        };
      }
      if (action.type === "WRITE_DRAFT") {
        const text = action.payload.text;
        if (keys !== "text" || typeof text !== "string" || text.length > 100000)
          throw new Error("INVALID_DRAFT");
        await deps.saveDraft({
          rootId: mission.rootId,
          missionId: mission.id,
          actionId: action.id,
          text,
        });
        return { kind: "draft" as const, actionId: action.id };
      }
      throw new Error("UNSUPPORTED_TOOL");
    },
  };
}
