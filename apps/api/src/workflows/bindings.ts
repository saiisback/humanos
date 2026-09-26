import { hotelIntake, restaurantIntake, restaurantLabels, type BlockType } from "@humanos/schemas";
import type { AssemblyInput, WorkflowSelector } from "@humanos/workflows";
import type { BrowserRecipe, BrowserRecipeRegistry } from "./browser.js";
import type { BrowserUsePolicyRegistry } from "./browser-use-policy.js";
import { browserUseBookingPlan, parseBookingRequest, type BookingKey } from "./booking-request.js";
interface Intent {
  kind: "draft" | "research" | "email" | "booking" | "availability" | "clarify";
  blocks: BlockType[];
  recipient?: string;
  prompt?: string;
  recipeId?: string;
  /** Server-derived browser.submit destination for a Browser Use site policy. */
  destination?: string;
  fields?: Record<string, string>;
}
/** Server-side routing facts. Only audited recipes or inspected site policies in source can become booking targets. */
export interface GoalRoutingContext {
  recipes?: BrowserRecipeRegistry;
  browserEnabled?: boolean;
  browserUsePolicies?: BrowserUsePolicyRegistry;
  browserUseEnabled?: boolean;
}
const BOOKING_LABELS: Record<BookingKey, string> = {
  site: "site", restaurant: "restaurant", date: "date (YYYY-MM-DD)", time: "time (HH:MM)", timezone: "timezone (e.g. Asia/Tokyo)",
  partySize: "party size", reservationName: "name", contact: "email", budget: "budget",
};
/** Browser Use route: only when the request names an installed site policy with an explicit "site:" line. */
function routeBrowserUseBooking(goal: string, context: GoalRoutingContext): Intent | null {
  const policies = context.browserUsePolicies;
  if (!policies?.list().length) return null;
  const { request, missing, invalid } = parseBookingRequest(goal);
  const policy = request.site ? policies.get(request.site) : null;
  if (!policy) return null;
  if (!context.browserUseEnabled) return clarify(`The local Browser Use worker is off on this HumanOS server, so ${policy.label} can't be opened. Nothing was booked.`);
  if (missing.length || invalid.length) {
    const parts = [
      ...(missing.length ? [`add ${missing.map(key => `"${BOOKING_LABELS[key]}: …"`).join(", ")}`] : []),
      ...(invalid.length ? [`correct ${invalid.map(key => BOOKING_LABELS[key]).join(", ")} (check the format and give it only once)`] : []),
    ];
    return clarify(`To book with ${policy.label}, edit your request and ${parts.join(", and ")}, one per line. Nothing was booked; you'll confirm the exact details before anything is submitted.`);
  }
  const plan = browserUseBookingPlan(request, policies);
  if (plan.kind === "clarify") return clarify(plan.message);
  const { preferred_time: _hint, ...fields } = plan.payload;
  if (!policy.validateFields(fields).ok) return clarify(`These booking details are not accepted by ${policy.label}. Check the party size and email, then edit your request. Nothing was booked.`);
  return { kind: "booking", blocks: ["human.confirm", "browser.submit"], destination: plan.destination, fields: plan.payload };
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
  const hotel = hotelIntake(goal);
  // Hotel intake never borrows a restaurant policy or grants external capabilities.
  if (hotel.isHotel) return clarify(hotel.missing.length ? hotel.question
    : "Your hotel details are saved. No supported hotel booking service is installed, so HumanOS cannot check availability or book this stay yet. Nothing was booked or submitted.");
  if (goal.includes("\n\n[Restaurant details]\n")) {
    const intake = restaurantIntake(goal);
    if (intake.isRestaurant) {
      const required = [...intake.missing, ...intake.invalid];
      const policy = context.browserUsePolicies?.get("tablecheck-brooklyn-parlor");
      if (!required.length && context.browserUseEnabled && policy?.supportsSubmission === false) {
        const d = intake.details;
        return { kind: "availability", blocks: ["browser.availability"], destination: "browser-use:tablecheck-brooklyn-parlor",
          fields: { date: d.date!, time: d.time!, timezone: d.timezone!, adults: d.adults!, children: d.children!, offer_id: d.offerId! } };
      }
      return clarify(required.length
        ? `Complete these reservation details in HumanOS: ${required.map(key => restaurantLabels[key]).join(", ")}. Nothing was booked.`
        : "Your reservation details are saved. TableCheck submission is not integrated yet. Your booking must run through a registered ENS agent in HumanOS; nothing has been booked or submitted.");
    }
  }
  const browserUse = routeBrowserUseBooking(goal, context);
  if (browserUse) return browserUse;
  const recipes = context.recipes?.list() ?? [];
  if (!recipes.length) return clarify("To prepare a table booking, provide the restaurant or area/cuisine, booking site, date, time with timezone, party size, budget, and reservation name. No audited booking site is installed yet; that site must be integrated before HumanOS can check availability or submit. Nothing was booked or submitted.");
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
  const negatedBooking = /\b(do not|don't|dont|without) (book(?:ing)?|reserv(?:e|ing)|pay(?:ing)?|buy(?:ing)?)\b/.test(lower);
  // Restaurant preparation carries private guest data. It must not fall through
  // to either email sending or an unredacted public-search query.
  if (restaurantIntake(goal).isRestaurant) {
    const booking = routeBooking(goal, context);
    if (booking.kind === "clarify") return booking;
    // This reviewed integration is incapable of submission; the saved 'book' intent
    // prepares the requested reservation for later review, not a live write.
    if (booking.destination === "browser-use:tablecheck-brooklyn-parlor" && context.browserUsePolicies?.get("tablecheck-brooklyn-parlor")?.supportsSubmission === false)
      return booking;
    if (negatedBooking || /\b(?:availability|prepare)\b/.test(lower))
      return clarify("Your reservation details are saved. Availability-only preparation is not supported by this booking flow yet; nothing will be submitted.");
    return booking;
  }
  // Withholding booking approval is not a request to email the contact address.
  // Preserve the reservation intent and return its real setup/intake blocker;
  // never offer send-email or submission capabilities for preparation-only work.
  if (!draftOnly && negatedBooking && /\b(book|reserve|reservation)\b/.test(lower)) {
    if (/\b(research|search|find|itinerary|latest|current|compare)\b/.test(lower))
      return { kind: "research", blocks: ["research.web", "content.generate"] };
    const booking = routeBooking(goal, context);
    return booking.kind === "clarify" ? booking : clarify("Your reservation details are saved. You asked not to book yet. Availability-only preparation is not supported by this booking flow yet; no email will be sent and nothing will be submitted.");
  }
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
  if (intent.kind === "availability") return { completionSequence: intent.blocks, allowedCapabilities: ["web.search"], browserFallbackAllowed: true, unsupportedExternalEffect: true,
    inputs: { "browser.availability": { value: { destination: intent.destination!, payload: { ...intent.fields! } } } } };
  if (intent.kind === "booking") return {
    completionSequence: intent.blocks, allowedCapabilities: ["application.submit"],
    browserFallbackAllowed: true, unsupportedExternalEffect: true,
    inputs: {
      "human.confirm": { value: {} },
      "browser.submit": { value: { destination: intent.destination ?? `recipe:${intent.recipeId!}`, payload: { ...intent.fields! } } },
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
