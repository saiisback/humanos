import { isIP } from "node:net";
import type { BrowserCandidate, BrowserHandoffReason, BrowserSubmissionPermit, Hex } from "@humanos/schemas";

/**
 * Runner-side half of the Browser Use effect boundary. Site policies are server-authored
 * (never from a page or model); the worker enforces the same policy on the network. This
 * module decides which observed candidate may be acted on and issues the single-use
 * submission permit. No model output can widen either decision.
 */
export interface BrowserUsePolicyField { readonly name: string; readonly label: string; readonly maxLength: number; readonly pattern?: RegExp }
export interface BrowserUsePolicyDefinition {
  readonly id: string;
  readonly label: string;
  readonly origin: string;
  /** Typed reservation fields the user supplies; derived page state (e.g. slot) is read back by the worker. */
  readonly fields: readonly BrowserUsePolicyField[];
  /** Controlled local fixture; never offered as a production integration. */
  readonly fixtureOnly?: boolean;
  /** False means preparation may report availability, but must never yield a dispatch permit. */
  readonly supportsSubmission?: boolean;
  readonly requiresEns?: boolean;
}
export interface BrowserUsePolicy extends BrowserUsePolicyDefinition {
  validateFields(fields: Record<string, string>): { ok: true } | { ok: false; missing?: string[]; invalid?: string[] };
}

export class BrowserUsePolicyRegistry {
  private readonly policies = new Map<string, BrowserUsePolicy>();
  constructor(private readonly options: { allowFixtures?: boolean } = {}) {}
  register(definition: BrowserUsePolicyDefinition): void {
    if (!/^[a-z][a-z0-9-]{0,63}$/.test(definition.id) || !definition.label.trim()) throw new Error("INVALID_POLICY");
    if (this.policies.has(definition.id)) throw new Error("DUPLICATE_POLICY");
    if (definition.fixtureOnly && !this.options.allowFixtures) throw new Error("FIXTURE_POLICY");
    const url = new URL(definition.origin);
    const host = url.hostname.replace(/^\[|\]$/g, "");
    const scheme = definition.fixtureOnly ? /^https?:$/ : /^https:$/;
    if (url.origin !== definition.origin || !scheme.test(url.protocol) || isIP(host) || !host.includes(".") ||
        (!definition.fixtureOnly && /(^|\.)(localhost|local|internal|test|invalid)$/.test(host))) throw new Error("INVALID_ORIGIN");
    if (!definition.fields.length || definition.fields.length > 32 || new Set(definition.fields.map(f => f.name)).size !== definition.fields.length ||
        definition.fields.some(f => !/^[a-z][a-z0-9_]{0,63}$/.test(f.name) || !f.label.trim() || !Number.isInteger(f.maxLength) || f.maxLength < 1 || f.maxLength > 2000 ||
          (f.pattern && (f.pattern.global || f.pattern.sticky)))) throw new Error("INVALID_FIELDS");
    const fields = definition.fields.map(f => Object.freeze({ ...f }));
    this.policies.set(definition.id, Object.freeze({
      ...definition, fields,
      validateFields(values: Record<string, string>) {
        const missing = fields.filter(f => !values[f.name]?.trim()).map(f => f.name);
        const invalid = [
          ...Object.keys(values).filter(name => !fields.some(f => f.name === name)),
          ...fields.filter(f => values[f.name]?.trim() && (values[f.name]!.length > f.maxLength || (f.pattern && !f.pattern.test(values[f.name]!)))).map(f => f.name),
        ];
        return missing.length || invalid.length ? { ok: false as const, ...(missing.length ? { missing } : {}), ...(invalid.length ? { invalid } : {}) } : { ok: true as const };
      },
    }));
  }
  get(id: string): BrowserUsePolicy | null { return this.policies.get(id) ?? null; }
  list(): readonly BrowserUsePolicy[] { return [...this.policies.values()]; }
}

/** Inspected public availability only. The provider's creation/receipt contract is not enabled. */
export function createBrowserUsePolicyRegistry(): BrowserUsePolicyRegistry {
  const registry = new BrowserUsePolicyRegistry();
  registry.register({ id: "tablecheck-brooklyn-parlor", label: "Brooklyn Parlor · availability only", origin: "https://www.tablecheck.com",
    supportsSubmission: false, requiresEns: true, fields: [
      { name: "date", label: "Date", maxLength: 10, pattern: /^\d{4}-\d{2}-\d{2}$/ },
      { name: "time", label: "Time", maxLength: 5, pattern: /^(?:[01]\d|2[0-3]):[0-5]\d$/ },
      { name: "timezone", label: "Timezone", maxLength: 32, pattern: /^Asia\/Tokyo$/ },
      { name: "adults", label: "Adults", maxLength: 1, pattern: /^[1-5]$/ },
      { name: "children", label: "Children", maxLength: 1, pattern: /^[0-5]$/ },
      { name: "offer_id", label: "Offer", maxLength: 24, pattern: /^66c4d4411c588898fe3bb84b$/ },
    ] });
  return registry;
}

export interface BrowserUseScope {
  accountId: string;
  runId: string;
  sessionId: string;
  policyId: string;
  /** Latest revision the runner accepted from this worker session. */
  revision: number;
  actionsUsed: number;
  maxActions: number;
  deadline: Date;
}
export interface BrowserObservation {
  revision: number;
  sessionId: string;
  origin: string;
  loginRequired: boolean;
  candidates: readonly BrowserCandidate[];
}
export type GuardDecision = { kind: "allowed"; candidateId: string } | { kind: "handoff"; reason: BrowserHandoffReason; message: string };

const handoff = (reason: BrowserHandoffReason, message: string): GuardDecision => ({ kind: "handoff", reason, message });

/**
 * Preparation actions only: `permit` is absent before approval, and a submit candidate is
 * never allowed here. The approved submission travels only as a permit on the runner pipe.
 */
export function guardAction(scope: BrowserUseScope, observation: BrowserObservation, candidate: BrowserCandidate,
  permit: BrowserSubmissionPermit | undefined, now: Date = new Date()): GuardDecision {
  if (scope.actionsUsed >= scope.maxActions || now.getTime() >= scope.deadline.getTime())
    return handoff("TIMEOUT", "The preparation step budget was used up. Review the progress so far.");
  if (observation.loginRequired) return handoff("LOGIN_REQUIRED", "Sign in to the site in the HumanOS browser window.");
  if (candidate.policyId !== scope.policyId) return handoff("POLICY_BLOCKED", "That action belongs to a different site policy.");
  if (observation.sessionId !== scope.sessionId || observation.revision !== scope.revision || candidate.observationRevision !== observation.revision)
    return handoff("STALE_OBSERVATION", "The page changed since it was observed. Observe again.");
  const observed = observation.candidates.find(c => c.id === candidate.id);
  if (!observed || observed.kind !== candidate.kind || observed.targetId !== candidate.targetId || observed.policyId !== candidate.policyId)
    return handoff("STALE_OBSERVATION", "That choice is not on the current page.");
  if (permit !== undefined || candidate.kind !== "select")
    return handoff("UNSUPPORTED_EFFECT", "Only reviewed selections are automated; this action needs you.");
  return { kind: "allowed", candidateId: candidate.id };
}

export const MAX_PERMIT_TTL_MS = 5 * 60 * 1000;
/** Issues at most one permit per run step, whatever session asks, so a click cannot be re-authorized. */
export function createPermitLedger() {
  const issued = new Set<string>();
  return {
    issue(input: { runId: string; stepKey: string; sessionId: string; actionId: number; observationRevision: number; payloadHash: Hex; now: Date; ttlMs: number }): BrowserSubmissionPermit {
      if (input.ttlMs <= 0 || input.ttlMs > MAX_PERMIT_TTL_MS) throw new Error("PERMIT_TTL");
      const key = `${input.runId}\u0000${input.stepKey}`;
      if (issued.has(key)) throw new Error("PERMIT_ALREADY_ISSUED");
      issued.add(key);
      return { runId: input.runId, sessionId: input.sessionId, actionId: input.actionId, observationRevision: input.observationRevision,
        payloadHash: input.payloadHash, expiresAt: new Date(input.now.getTime() + input.ttlMs).toISOString() };
    },
  };
}
