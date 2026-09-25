import * as v from "valibot";
export {
  MissionProposalSchema,
  ActionProposalDraftSchema,
} from "@humanos/schemas";
export const completionSchema = (model: string) =>
  v.object({
    model: v.literal(model),
    choices: v.pipe(
      v.array(
        v.object({
          finish_reason: v.literal("stop"),
          message: v.object({ content: v.string() }),
        }),
      ),
      v.length(1),
    ),
  });
export const CompletionSchema = completionSchema("deepseek-flash");
