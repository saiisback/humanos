import type { ContentBrief, GeneratedContent, WorkflowSelection, WorkflowSelectionInput } from "@humanos/schemas";

export interface WorkflowSelector {
  select(input: WorkflowSelectionInput): Promise<WorkflowSelection>;
}

export interface ContentGenerator {
  generate(brief: ContentBrief): Promise<GeneratedContent>;
}
