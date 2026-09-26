import { describe, expect, it } from "vitest";
import type { BrowserCandidate } from "@humanos/schemas";
import {
  BrowserUsePolicyRegistry, createPermitLedger, guardAction, type BrowserUseScope, type BrowserObservation,
} from "../src/workflows/browser-use-policy.js";

const fixture = {
  id: "fixture-restaurant", label: "Controlled fixture restaurant (test only)", origin: "http://fixture.humanos.test:8123",
  fields: [
    { name: "name", label: "Reservation name", maxLength: 80 },
    { name: "party_size", label: "Party size", maxLength: 2, pattern: /^[1-9][0-9]?$/ },
    { name: "email", label: "Contact email", maxLength: 120 },
  ],
  fixtureOnly: true,
} as const;
const now = new Date("2026-09-26T12:00:00.000Z");
const scope = (overrides: Partial<BrowserUseScope> = {}): BrowserUseScope => ({
  accountId: "11155111:0x1111111111111111111111111111111111111111", runId: "run-1", sessionId: "bus-a",
  policyId: "fixture-restaurant", revision: 3, actionsUsed: 2, maxActions: 40, deadline: new Date(now.getTime() + 600000), ...overrides,
});
const candidate = (overrides: Partial<BrowserCandidate> = {}): BrowserCandidate => ({
  id: "select:slot-1900", kind: "select", label: "19:00", targetId: "slot-1900", policyId: "fixture-restaurant", observationRevision: 3, ...overrides,
});
const observation = (overrides: Partial<BrowserObservation> = {}): BrowserObservation => ({
  revision: 3, sessionId: "bus-a", origin: fixture.origin, loginRequired: false, candidates: [candidate()], ...overrides,
});

describe("Browser Use policy registry", () => {
  it("accepts only server-authored policies with safe origins and typed fields", () => {
    const registry = new BrowserUsePolicyRegistry({ allowFixtures: true });
    registry.register(fixture);
    expect(registry.get("fixture-restaurant")?.label).toContain("test only");
    expect(() => registry.register(fixture)).toThrow("DUPLICATE_POLICY");
    const production = new BrowserUsePolicyRegistry();
    expect(() => production.register(fixture)).toThrow("FIXTURE_POLICY");
    for (const origin of ["http://book.example.com", "https://127.0.0.1", "https://localhost", "https://a.example.com/path"])
      expect(() => production.register({ ...fixture, id: "x", origin, fixtureOnly: false })).toThrow("INVALID_ORIGIN");
    expect(() => production.register({ ...fixture, id: "x", origin: "https://book.example.com", fixtureOnly: false, fields: [{ name: "Card Number", label: "x", maxLength: 1 }] })).toThrow("INVALID_FIELDS");
  });

  it("validates typed booking fields exactly", () => {
    const registry = new BrowserUsePolicyRegistry({ allowFixtures: true });
    registry.register(fixture);
    const policy = registry.get("fixture-restaurant")!;
    expect(policy.validateFields({ name: "Ada", party_size: "2", email: "ada@example.com" })).toEqual({ ok: true });
    expect(policy.validateFields({ name: "Ada", party_size: "2" })).toEqual({ ok: false, missing: ["email"] });
    expect(policy.validateFields({ name: "Ada", party_size: "200", email: "a@b.co" }).ok).toBe(false);
    expect(policy.validateFields({ name: "Ada", party_size: "2", email: "a@b.co", card: "4111" }).ok).toBe(false);
  });
});

describe("guardAction", () => {
  it("allows only a candidate observed in this session at the current revision", () => {
    expect(guardAction(scope(), observation(), candidate(), undefined, now)).toEqual({ kind: "allowed", candidateId: "select:slot-1900" });
  });

  it.each([
    ["stale candidate revision", {}, {}, { observationRevision: 2 }, "STALE_OBSERVATION"],
    ["stale observation", { revision: 4 }, {}, {}, "STALE_OBSERVATION"],
    ["other session's observation", {}, { sessionId: "bus-b" }, {}, "STALE_OBSERVATION"],
    ["fabricated candidate id", {}, {}, { id: "select:slot-0300", targetId: "slot-0300" }, "STALE_OBSERVATION"],
    ["candidate with altered target", {}, {}, { targetId: "slot-2000" }, "STALE_OBSERVATION"],
    ["another site's policy", {}, {}, { policyId: "other-site" }, "POLICY_BLOCKED"],
    ["submit without a permit", {}, { candidates: [candidate({ id: "submit:reserve", kind: "submit", targetId: "reserve" })] }, { id: "submit:reserve", kind: "submit", targetId: "reserve" }, "UNSUPPORTED_EFFECT"],
    ["navigation kind not enabled", {}, { candidates: [candidate({ id: "navigate:home", kind: "navigate", targetId: "home" })] }, { id: "navigate:home", kind: "navigate", targetId: "home" }, "UNSUPPORTED_EFFECT"],
    ["login wall", {}, { loginRequired: true }, {}, "LOGIN_REQUIRED"],
    ["action budget exhausted", { actionsUsed: 40 }, {}, {}, "TIMEOUT"],
    ["time budget exhausted", { deadline: new Date(now.getTime() - 1) }, {}, {}, "TIMEOUT"],
  ] as const)("hands off on %s", (_name, scopeOverride, observationOverride, candidateOverride, reason) => {
    const decision = guardAction(scope(scopeOverride), observation(observationOverride), candidate(candidateOverride), undefined, now);
    expect(decision).toMatchObject({ kind: "handoff", reason });
  });
});

describe("submission permits", () => {
  const hash = `0x${"a".repeat(64)}` as const;
  it("issues one permit per run step and session, bound to the exact reviewed material", () => {
    const ledger = createPermitLedger();
    const permit = ledger.issue({ runId: "run-1", stepKey: "step-1", sessionId: "bus-a", actionId: 7, observationRevision: 5, payloadHash: hash, now, ttlMs: 60000 });
    expect(permit).toEqual({ runId: "run-1", sessionId: "bus-a", actionId: 7, observationRevision: 5, payloadHash: hash, expiresAt: "2026-09-26T12:01:00.000Z" });
    expect(() => ledger.issue({ runId: "run-1", stepKey: "step-1", sessionId: "bus-b", actionId: 9, observationRevision: 5, payloadHash: hash, now, ttlMs: 60000 })).toThrow("PERMIT_ALREADY_ISSUED");
    expect(() => ledger.issue({ runId: "run-1", stepKey: "step-2", sessionId: "bus-a", actionId: 8, observationRevision: 5, payloadHash: hash, now, ttlMs: 10 * 60000 })).toThrow("PERMIT_TTL");
  });
});
