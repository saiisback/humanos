import * as v from "valibot";
import type { BlockType, Capability, ExecutorKind } from "@humanos/schemas";
import { ContentBriefSchema, GeneratedContentSchema } from "@humanos/schemas";

export type EffectClass = "pure" | "read" | "reversible_write" | "irreversible_write";
export type BindingKind = "string" | "number" | "boolean" | "array" | "object";
export interface BlockDefinition {
  type: BlockType;
  version: `${number}.${number}.${number}`;
  executor: ExecutorKind;
  effect: EffectClass;
  input: v.GenericSchema;
  output: v.GenericSchema;
  capability: Capability | null;
  requiresConfirmation: boolean;
  outputVariants?: Readonly<Record<string, readonly string[]>>;
  inputBindingKinds?: Readonly<Record<string, BindingKind>>;
  outputBindingKinds?: Readonly<Record<string, BindingKind>>;
}

export class BlockRegistry {
  private readonly definitions = new Map<BlockType, BlockDefinition>();
  register(definition: BlockDefinition): void {
    if (this.definitions.has(definition.type)) throw new Error("DUPLICATE_BLOCK");
    this.definitions.set(definition.type, definition);
  }
  get(type: BlockType): BlockDefinition {
    const definition = this.definitions.get(type);
    if (!definition) throw new Error("UNKNOWN_BLOCK");
    return definition;
  }
  list(): readonly BlockDefinition[] { return [...this.definitions.values()]; }
}

const text = v.pipe(v.string(), v.minLength(1), v.maxLength(10000));
const short = v.pipe(v.string(), v.minLength(1), v.maxLength(256));
const fields = v.record(short, text);
const empty = v.strictObject({});
const receipt = v.strictObject({ receiptId: short });
const defs: BlockDefinition[] = [
  { type: "research.web", version: "1.0.0", executor: "connector", effect: "read", input: v.strictObject({ query: text }), output: v.strictObject({ sources: v.array(v.strictObject({ url: text, title: text, excerpt: text })) }), capability: "web.search", requiresConfirmation: false },
  { type: "extract.structured", version: "1.0.0", executor: "local", effect: "pure", input: v.strictObject({ sourceRef: short, fieldNames: v.array(short) }), output: v.strictObject({ fields }), capability: null, requiresConfirmation: false },
  { type: "browser.navigate", version: "1.0.0", executor: "browser", effect: "read", input: v.strictObject({ url: text }), output: v.strictObject({ pageId: short, finalUrl: text }), capability: null, requiresConfirmation: false },
  { type: "browser.extract", version: "1.0.0", executor: "browser", effect: "read", input: v.strictObject({ pageId: short, fieldNames: v.array(short) }), output: v.strictObject({ fields }), capability: null, requiresConfirmation: false },
  { type: "browser.fill", version: "1.0.0", executor: "browser", effect: "reversible_write", input: v.strictObject({ pageId: short, fields }), output: v.strictObject({ previewHash: short }), capability: "form.save", requiresConfirmation: false },
  { type: "browser.submit", version: "1.0.0", executor: "browser", effect: "irreversible_write", input: v.strictObject({ destination: text, payload: v.record(short, text) }), output: receipt, capability: "application.submit", requiresConfirmation: true },
  { type: "connector.call", version: "1.0.0", executor: "connector", effect: "irreversible_write", input: v.strictObject({ connectorId: short, operationId: short, arguments: v.record(short, text) }), output: receipt, capability: null, requiresConfirmation: true },
  { type: "content.generate", version: "1.0.0", executor: "content", effect: "pure", input: v.strictObject({ brief: ContentBriefSchema }), output: GeneratedContentSchema, capability: null, requiresConfirmation: false, outputVariants: { text: ["outputSchema", "text"], email: ["outputSchema", "subject", "body"], form_fields: ["outputSchema", "fields"] } },
  { type: "content.transform", version: "1.0.0", executor: "content", effect: "pure", input: v.strictObject({ brief: ContentBriefSchema, sourceRef: short }), output: GeneratedContentSchema, capability: null, requiresConfirmation: false, outputVariants: { text: ["outputSchema", "text"], email: ["outputSchema", "subject", "body"], form_fields: ["outputSchema", "fields"] } },
  { type: "control.wait", version: "1.0.0", executor: "timer", effect: "pure", input: v.strictObject({ until: v.pipe(v.string(), v.isoTimestamp()) }), output: empty, capability: null, requiresConfirmation: false },
  { type: "control.branch", version: "1.0.0", executor: "local", effect: "pure", input: v.strictObject({ valueRef: short, equals: text }), output: v.strictObject({ selected: v.boolean() }), capability: null, requiresConfirmation: false },
  { type: "control.join", version: "1.0.0", executor: "local", effect: "pure", input: empty, output: empty, capability: null, requiresConfirmation: false },
  { type: "human.connect", version: "1.0.0", executor: "human", effect: "pure", input: v.strictObject({ connectorId: short }), output: v.strictObject({ connected: v.boolean() }), capability: null, requiresConfirmation: false },
  { type: "human.confirm", version: "1.0.0", executor: "human", effect: "pure", input: empty, output: v.strictObject({ confirmed: v.boolean() }), capability: null, requiresConfirmation: false },
  { type: "human.input", version: "1.0.0", executor: "human", effect: "pure", input: v.strictObject({ prompt: text }), output: v.strictObject({ value: text }), capability: null, requiresConfirmation: false },
  { type: "schedule.once", version: "1.0.0", executor: "timer", effect: "pure", input: v.strictObject({ fireAt: v.pipe(v.string(), v.isoTimestamp()), timezone: short }), output: v.strictObject({ occurrenceId: short }), capability: null, requiresConfirmation: false },
  { type: "schedule.recurring", version: "1.0.0", executor: "timer", effect: "pure", input: v.strictObject({ expression: short, timezone: short }), output: v.strictObject({ occurrenceId: short }), capability: null, requiresConfirmation: false },
  { type: "application.submit", version: "1.0.0", executor: "connector", effect: "irreversible_write", input: v.strictObject({ applicationId: short, payload: v.record(short, text) }), output: receipt, capability: "application.submit", requiresConfirmation: true },
  { type: "calendar.create", version: "1.0.0", executor: "connector", effect: "reversible_write", input: v.strictObject({ title: text, startsAt: v.pipe(v.string(), v.isoTimestamp()), endsAt: v.pipe(v.string(), v.isoTimestamp()) }), output: v.strictObject({ eventId: short }), capability: "calendar.create", requiresConfirmation: true },
];

// Public binding metadata describes whole top-level fields. The graph validator
// checks field existence and ancestry; the assembler checks kind compatibility.
const bindingKinds: Readonly<Record<BlockType, {
  input: Readonly<Record<string, BindingKind>>;
  output: Readonly<Record<string, BindingKind>>;
}>> = {
  "research.web": { input: { query: "string" }, output: { sources: "array" } },
  "extract.structured": { input: { sourceRef: "string", fieldNames: "array" }, output: { fields: "object" } },
  "browser.navigate": { input: { url: "string" }, output: { pageId: "string", finalUrl: "string" } },
  "browser.extract": { input: { pageId: "string", fieldNames: "array" }, output: { fields: "object" } },
  "browser.fill": { input: { pageId: "string", fields: "object" }, output: { previewHash: "string" } },
  "browser.submit": { input: { destination: "string", payload: "object" }, output: { receiptId: "string" } },
  "connector.call": { input: { connectorId: "string", operationId: "string", arguments: "object" }, output: { receiptId: "string" } },
  "content.generate": { input: { brief: "object" }, output: { outputSchema: "string", text: "string", subject: "string", body: "string", fields: "object" } },
  "content.transform": { input: { brief: "object", sourceRef: "string" }, output: { outputSchema: "string", text: "string", subject: "string", body: "string", fields: "object" } },
  "control.wait": { input: { until: "string" }, output: {} },
  "control.branch": { input: { valueRef: "string", equals: "string" }, output: { selected: "boolean" } },
  "control.join": { input: {}, output: {} },
  "human.connect": { input: { connectorId: "string" }, output: { connected: "boolean" } },
  "human.confirm": { input: {}, output: { confirmed: "boolean" } },
  "human.input": { input: { prompt: "string" }, output: { value: "string" } },
  "schedule.once": { input: { fireAt: "string", timezone: "string" }, output: { occurrenceId: "string" } },
  "schedule.recurring": { input: { expression: "string", timezone: "string" }, output: { occurrenceId: "string" } },
  "application.submit": { input: { applicationId: "string", payload: "object" }, output: { receiptId: "string" } },
  "calendar.create": { input: { title: "string", startsAt: "string", endsAt: "string" }, output: { eventId: "string" } },
};

export function createDefaultCatalog(): BlockRegistry {
  const catalog = new BlockRegistry();
  for (const definition of defs) {
    const kinds = bindingKinds[definition.type];
    catalog.register({ ...definition, inputBindingKinds: kinds.input, outputBindingKinds: kinds.output });
  }
  return catalog;
}
