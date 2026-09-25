import * as v from "valibot";
import { hashCanonical, WorkflowReceiptSchema, type JsonValue } from "@humanos/schemas";
import { BrowserExecutionError, type BrowserExecutor, type BrowserRecipe, type BrowserRecipeRegistry } from "./browser.js";
import type { BrowserSubmission, PreparedAction, createWorkflowConfirmations } from "./confirmations.js";
import { WorkflowExecutionError, WorkflowPause } from "./runner.js";
import type { StepExecutionContext, StepExecutionResult, WorkflowExecutor } from "./types.js";

/** `browser.submit` destinations name an audited recipe; they are never URLs. */
const recipeDestination = /^recipe:([a-z][a-z0-9-]{0,63})$/;

export interface BrowserStepDependencies {
  /** Null when the local driver is not enabled for this deployment. */
  executor: BrowserExecutor | null;
  recipes: BrowserRecipeRegistry;
  authorize(context: StepExecutionContext): Promise<boolean>;
  confirmations: Pick<ReturnType<typeof createWorkflowConfirmations>, "dispatchConfirmed">;
  clock?: () => Date;
}

export function createBrowserStep(deps: BrowserStepDependencies) {
  const clock = deps.clock ?? (() => new Date());
  function target(context: StepExecutionContext): { executor: BrowserExecutor; recipe: BrowserRecipe; fields: Record<string, string> } {
    if (!context.version.browserFallbackAllowed)
      throw new WorkflowPause("CONNECTION_REQUIRED", "Browser fallback is off for this workflow. No page was opened.");
    if (!deps.executor)
      throw new WorkflowPause("CONNECTION_REQUIRED", "The local browser driver is not enabled on this HumanOS server. No page was opened.");
    const id = recipeDestination.exec(String(context.input.destination))?.[1];
    const recipe = id ? deps.recipes.get(id) : null;
    if (!recipe) throw new WorkflowPause("CONNECTION_REQUIRED", "No audited site recipe is installed for this destination. No page was opened.");
    const fields = context.input.payload;
    if (!fields || typeof fields !== "object" || Array.isArray(fields) || Object.values(fields).some(value => typeof value !== "string"))
      throw new WorkflowExecutionError("VALIDATION");
    return { executor: deps.executor, recipe, fields: { ...fields } as Record<string, string> };
  }
  function toPrepared(recipe: BrowserRecipe, submission: BrowserSubmission): PreparedAction {
    return {
      destination: submission.destination,
      payload: {
        fields: submission.fields, attachments: submission.attachments as unknown as JsonValue,
        value: submission.value, pageFingerprint: submission.pageFingerprint,
      },
      binding: { recipeId: recipe.id, site: recipe.label, origin: recipe.origin },
    };
  }
  const classify = (error: unknown): unknown =>
    error instanceof BrowserExecutionError ? Object.assign(new WorkflowExecutionError(error.errorClass), { message: error.message }) : error;

  return {
    /** Read-only preparation: navigate, fill, read back. Never clicks. */
    async prepare(context: StepExecutionContext): Promise<PreparedAction> {
      const { executor, recipe, fields } = target(context);
      if (!(await deps.authorize(context))) throw new WorkflowExecutionError("AUTHORIZATION");
      try { return toPrepared(recipe, await executor.prepare({ recipeId: recipe.id, fields })); }
      catch (error) {
        if (error instanceof BrowserExecutionError) throw classify(error);
        throw new WorkflowExecutionError("TRANSIENT");
      }
    },
    executor: {
      async execute(context: StepExecutionContext): Promise<StepExecutionResult> {
        const { executor, recipe, fields } = target(context);
        if (!(await deps.authorize(context))) throw new WorkflowExecutionError("AUTHORIZATION");
        let claimed = false;
        let receipt;
        try {
          receipt = await executor.submit({ recipeId: recipe.id, fields, approve: async submission => {
            // Claim the single final dispatch for exactly the material on the open page.
            await deps.confirmations.dispatchConfirmed(context, async () => ({ output: {} }), undefined, toPrepared(recipe, submission));
            claimed = true;
            if (context.signal.aborted || !(await deps.authorize(context))) throw new WorkflowExecutionError("AUTHORIZATION");
          } });
        } catch (error) {
          if (error instanceof WorkflowPause || error instanceof WorkflowExecutionError) throw error;
          if (error instanceof BrowserExecutionError) throw classify(error);
          // Before the claim nothing was submitted; after it, stay conservative.
          throw new WorkflowExecutionError(claimed ? "UNKNOWN_OUTCOME" : "TRANSIENT");
        }
        const output = { receiptId: receipt.providerReference };
        return {
          output,
          receipt: v.parse(WorkflowReceiptSchema, {
            id: hashCanonical([context.run.id, context.step.id, context.idempotencyKey]),
            runId: context.run.id, stepRunId: context.step.id, executor: "browser",
            destination: `${recipe.origin}${recipe.entryPath}`, summary: recipe.label,
            requestHash: hashCanonical(context.input), outputHash: hashCanonical(output),
            executedAt: clock().toISOString(), idempotencyKey: context.idempotencyKey,
            providerReference: receipt.providerReference, finalUrl: receipt.finalUrl,
            successEvidence: receipt.successEvidence, metadata: { recipeId: recipe.id },
          }),
        };
      },
    } satisfies WorkflowExecutor,
  };
}
