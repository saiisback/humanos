import type { BlockType } from "@humanos/schemas";
import type { AssemblyInput, WorkflowSelector } from "@humanos/workflows";
import type { BrowserRecipe, BrowserRecipeRegistry } from "./browser.js";
interface Intent {
  kind: "draft" | "research" | "email" | "booking" | "clarify";
  blocks: BlockType[];
  recipient?: string;
  prompt?: string;
  recipeId?: string;
  fields?: Record<string, string>;
}
/** Server-side routing facts. Only audited recipes in source can become booking targets. */
export interface GoalRoutingContext {
  recipes?: BrowserRecipeRegistry;
  browserEnabled?: boolean;
}
const clarify = (prompt: string): Intent => ({ kind: "clarify", blocks: ["human.input"], prompt });
const escapeRegExp = (value: string) => value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/**
 * Reads only the recipe's own field keys ("Name: …" or "name = …", by field name or label).
 * Values end at a newline, a semicolon, or the next audited key. Other text is ignored and
 * can never add a field, a destination or a selector.
 */
function readFields(goal: string, recipe: BrowserRecipe): { fields: Record<string, string>; missing: string[]; invalid: string[] } {
  const keyFor = new Map<string, string>();
  for (const field of recipe.fields) for (const key of [field.name, field.label]) keyFor.set(key.toLowerCase(), field.name);
  const keys = [...keyFor.keys()].sort((a, b) => b.length - a.length).map(escapeRegExp).join("|");
  const pattern = new RegExp(`(?<![A-Za-z0-9_])(${keys})\\s*[:=]`, "gi");
  const found = [...goal.matchAll(pattern)];
  const values = new Map<string, Set<string>>();
  found.forEach((match, index) => {
    const start = match.index! + match[0].length;
    const end = found[index + 1]?.index ?? goal.length;
    const value = goal.slice(start, end).split(/[\n;]/)[0]!.trim().replace(/[\s,]+$/, "").replace(/\.$/, "").trim();
    const name = keyFor.get(match[1]!.toLowerCase())!;
    if (!values.has(name)) values.set(name, new Set());
    values.get(name)!.add(value);
  });
  const fields: Record<string, string> = {}, missing: string[] = [], invalid: string[] = [];
  for (const field of recipe.fields) {
    const given = values.get(field.name);
    if (!given || [...given].every(value => !value)) { missing.push(field.label); continue; }
    const [value] = [...given];
    if (given.size !== 1 || !value || value.length > field.maxLength || (field.pattern && !field.pattern.test(value))) { invalid.push(field.label); continue; }
    fields[field.name] = value;
  }
  return { fields, missing, invalid };
}
function routeBooking(goal: string, context: GoalRoutingContext): Intent {
  const recipes = context.recipes?.list() ?? [];
  if (!recipes.length) return clarify("No audited booking site is installed yet, so HumanOS can't book this. Nothing was booked or submitted.");
  const lower = goal.toLowerCase();
  const named = recipes.filter(recipe => lower.includes(recipe.id) || lower.includes(recipe.label.toLowerCase()));
  const labels = recipes.map(recipe => recipe.label).join(", ");
  if (!named.length) return clarify(`HumanOS can only book on audited sites: ${labels}. Name one of them in your request. Nothing was booked.`);
  if (named.length > 1) return clarify(`Your request names more than one audited site. Choose exactly one of: ${labels}. Nothing was booked.`);
  const recipe = named[0]!;
  if (!context.browserEnabled) return clarify(`The local browser driver is off on this HumanOS server, so ${recipe.label} can't be opened. Nothing was booked.`);
  const { fields, missing, invalid } = readFields(goal, recipe);
  if (missing.length || invalid.length) {
    const parts = [
      ...(missing.length ? [`add ${missing.map(label => `"${label}: …"`).join(", ")}`] : []),
      ...(invalid.length ? [`correct ${invalid.join(", ")} (check the allowed format and give it only once)`] : []),
    ];
    return clarify(`To book with ${recipe.label}, edit your request and ${parts.join(", and ")}, one per line. Nothing was booked; you'll confirm the exact details before anything is submitted.`);
  }
  return { kind: "booking", blocks: ["human.confirm", "browser.submit"], recipeId: recipe.id, fields };
}

/** Only audited intent bindings may turn prose into operational parameters.
 * Unknown work stays a saved clarification step; content generation is not execution. */
export function classifyWorkflowGoal(goal: string, context: GoalRoutingContext = {}): Intent {
  const lower = goal.toLowerCase();
  const draftOnly = /\b(draft only|do not send|don't send|without sending)\b/.test(lower) || /\bdraft\b/.test(lower) && !/\bsend\b/.test(lower);
  // In an explicit writing-only request, words inside the supplied brief
  // ("login works", "do not publish") do not grant external capabilities.
  if (draftOnly && /^(?:please\s+)?(?:draft|write|rewrite|compose|translate|summari[sz]e)\b/.test(lower.trim()))
    return { kind: "draft", blocks: ["content.generate"] };
  const negatedBooking = /\b(do not|don't|dont|without) (book|reserve|pay|buy)\b/.test(lower);
  if (!draftOnly && !negatedBooking && /\b(book|reserve|reservation)\b/.test(lower)) return routeBooking(goal, context);
  if (!draftOnly && /\b(send|email|mail)\b/.test(lower)) {
    const recipients = [...new Set(goal.match(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi) ?? [])];
    if (recipients.length !== 1) return clarify("Add exactly one recipient email address and describe what the email should say. HumanOS will draft it for your final confirmation.");
    return { kind: "email", blocks: ["content.generate", "human.confirm", "connector.call"], recipient: recipients[0]! };
  }
  if (/\b(buy|purchase|pay|transfer|delete|post|publish|login|sign in)\b/.test(lower) && !negatedBooking)
    return clarify("This action needs an approved service or browser connection and its exact destination. No booking, payment, or submission has been made. Connect the service before continuing.");
  if (/\b(research|search|find|itinerary|latest|current|compare)\b/.test(lower)) return { kind: "research", blocks: ["research.web", "content.generate"] };
  if (draftOnly || /\b(write|draft|summarize|summarise|rewrite|translate|explain|brainstorm|compose|greeting|poem|story|plan)\b/.test(lower)) return { kind: "draft", blocks: ["content.generate"] };
  return clarify("What output or action do you need? You can ask for a draft, sourced research, or an email to a specific recipient. Other actions need an approved connector or configured browser workflow.");
}
export function workflowInputs(goal: string, context: GoalRoutingContext = {}): Omit<AssemblyInput, "goal" | "draft"> {
  const intent = classifyWorkflowGoal(goal, context);
  if (intent.kind === "clarify") return { completionSequence: intent.blocks, allowedCapabilities: [], inputs: { "human.input": { value: { prompt: intent.prompt! } } } };
  if (intent.kind === "booking") return {
    completionSequence: intent.blocks, allowedCapabilities: ["application.submit"],
    browserFallbackAllowed: true, unsupportedExternalEffect: true,
    inputs: {
      "human.confirm": { value: {} },
      "browser.submit": { value: { destination: `recipe:${intent.recipeId!}`, payload: { ...intent.fields! } } },
    },
  };
  const content = { instruction: goal, context: intent.kind === "research" ? { sources: { $ref: "assembly_node_1.sources" } } : {}, outputSchema: intent.kind === "email" ? "email" : "text", maxCharacters: 8000 };
  return { completionSequence: intent.blocks, allowedCapabilities: intent.kind === "research" ? ["web.search"] : intent.kind === "email" ? ["email.send"] : [], browserFallbackAllowed: false,
    inputs: {
      "content.generate": { value: { brief: content } },
      ...(intent.kind === "research" ? { "research.web": { value: { query: goal } } } : {}),
      ...(intent.kind === "email" ? { "human.confirm": { value: {} }, "connector.call": { value: { connectorId: "resend", operationId: "email.send", arguments: { to: intent.recipient!, subject: { $ref: "assembly_node_1.subject" }, body: { $ref: "assembly_node_1.body" } } } } } : {}),
    },
  };
}
/** Restrict candidates using deterministic intent/precondition rules; Jev still
 * evaluates each offered transition and may reject/ask for review. */
export function boundedIntentSelector(selector: WorkflowSelector, context: GoalRoutingContext = {}): WorkflowSelector {
  return { async select(input) {
    const intent = classifyWorkflowGoal(input.goal, context);
    const target = intent.blocks[input.history?.length ?? 0] ?? "complete";
    const candidates = input.candidates.filter(c => c.type === target);
    if (!candidates.length) throw new Error("NO_CANDIDATES");
    return selector.select({ ...input, candidates });
  } };
}
