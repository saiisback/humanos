import { expect, it } from "vitest";
import type { WorkflowRun, StepRun } from "@humanos/schemas";
import { transitionRun, transitionStep, type ReconciliationResult } from "../src/index.js";

const now = "2026-09-26T00:00:00.000Z";
const run = { status: "QUEUED", revision: 0, startedAt: null, completedAt: null, cancelledAt: null } as WorkflowRun;
const step = { status: "PENDING", startedAt: null, completedAt: null } as StepRun;
it("moves a queued run to running and timestamps start", () => expect(transitionRun(run, "RUNNING", now)).toMatchObject({ status: "RUNNING", revision: 1, startedAt: now }));
it("rejects terminal run resurrection", () => expect(() => transitionRun({ ...run, status: "COMPLETED" }, "RUNNING", now)).toThrow("INVALID_RUN_TRANSITION"));
it("moves a step through ready and running", () => expect(transitionStep(transitionStep(step, "READY", now), "RUNNING", now)).toMatchObject({ status: "RUNNING", startedAt: now }));
it("rejects skipping directly to completion", () => expect(() => transitionStep(step, "COMPLETED", now)).toThrow("INVALID_STEP_TRANSITION"));

const evidenceHash = `0x${"a".repeat(64)}` as const;
const reconcilingRun = { ...run, status: "RECONCILIATION_REQUIRED" as const };
const reconcilingStep = { ...step, status: "RECONCILIATION_REQUIRED" as const };
it("rejects naked requeue and ready after an uncertain effect", () => {
  expect(() => transitionRun(reconcilingRun, "QUEUED", now)).toThrow("INVALID_RUN_TRANSITION");
  expect(() => transitionStep(reconcilingStep, "READY", now)).toThrow("INVALID_STEP_TRANSITION");
});
it("records provider-proven completion of an uncertain effect", () => {
  const result = { outcome: "already_completed" as const, evidenceHash };
  expect(transitionStep(reconcilingStep, "COMPLETED", now, result)).toMatchObject({ status: "COMPLETED", completedAt: now });
  expect(transitionRun(reconcilingRun, "QUEUED", now, result)).toMatchObject({ status: "QUEUED", revision: 1 });
});
it("permits retry only when provider evidence proves no effect occurred", () => {
  const result = { outcome: "not_performed" as const, evidenceHash };
  expect(transitionStep(reconcilingStep, "READY", now, result).status).toBe("READY");
  expect(transitionRun(reconcilingRun, "QUEUED", now, result).status).toBe("QUEUED");
  expect(() => transitionStep(reconcilingStep, "COMPLETED", now, result)).toThrow("INVALID_STEP_TRANSITION");
});
it("keeps unresolved outcomes blocked and permits proven failures to fail", () => {
  expect(() => transitionStep(reconcilingStep, "READY", now, { outcome: "unresolved", evidenceHash })).toThrow("INVALID_STEP_TRANSITION");
  expect(() => transitionRun(reconcilingRun, "QUEUED", now, { outcome: "unresolved", evidenceHash })).toThrow("INVALID_RUN_TRANSITION");
  expect(transitionStep(reconcilingStep, "FAILED", now, { outcome: "failed", evidenceHash }).status).toBe("FAILED");
  expect(transitionRun(reconcilingRun, "FAILED", now, { outcome: "failed", evidenceHash }).status).toBe("FAILED");
});
it("rejects a malformed provider-evidence envelope", () => {
  expect(() => transitionStep(reconcilingStep, "READY", now, null as unknown as ReconciliationResult)).toThrow("INVALID_STEP_TRANSITION");
  expect(() => transitionRun(reconcilingRun, "QUEUED", now, { outcome: "not_performed", evidenceHash: "bad" as `0x${string}` })).toThrow("INVALID_RUN_TRANSITION");
});
