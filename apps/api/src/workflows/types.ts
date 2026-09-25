import type {
  JsonValue,
  WorkflowNode,
  WorkflowRun,
  WorkflowVersion,
  StepRun,
  WorkflowReceipt,
} from "@humanos/schemas";
export interface WorkflowActor {
  accountId: string;
  rootId: string | null;
}
export interface StepExecutionContext {
  actor: WorkflowActor;
  run: WorkflowRun;
  version: WorkflowVersion;
  step: StepRun;
  node: WorkflowNode;
  input: Record<string, JsonValue>;
  idempotencyKey: string;
  signal: AbortSignal;
}
export interface StepExecutionResult {
  output: JsonValue;
  receipt?: WorkflowReceipt;
}
export interface WorkflowExecutor {
  execute(context: StepExecutionContext): Promise<StepExecutionResult>;
}
