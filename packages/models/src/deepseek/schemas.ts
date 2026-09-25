import * as v from "valibot";
export {
  MissionProposalSchema,
  ActionProposalDraftSchema,
} from "@humanos/schemas";
export const CompletionSchema = v.object({
  model: v.literal("deepseek-flash"),
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
