import * as v from "valibot";
import type { ConnectorOperation } from "../connectors.js";
const short = v.pipe(v.string(), v.minLength(1), v.maxLength(256));
export const linearInput = v.strictObject({ connectorId: v.literal("linear"), operationId: v.literal("linear.issue.create"),
  arguments: v.strictObject({ title: short, body: v.pipe(v.string(), v.minLength(1), v.maxLength(8000)) }) });
export const linearOutput = v.strictObject({ provider: v.literal("linear"), id: short, url: v.pipe(v.string(), v.url()), verified: v.literal(true) });
export const linearOperation: ConnectorOperation = Object.freeze({
  id: "linear.issue.create", blockType: "connector.call", capability: "linear.issue.create", effect: "irreversible_write",
  scopes: Object.freeze(["linear.issue.create"]), input: linearInput, output: linearOutput,
  destination: () => "linear:selected-team", summary: "Create a Linear issue",
});
