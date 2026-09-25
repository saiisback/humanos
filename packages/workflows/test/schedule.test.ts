import { describe, expect, it } from "vitest";
import type { WorkflowSchedule } from "@humanos/schemas";
import { nextOccurrence } from "../src/schedule.js";

const schedule = (expression: string, timezone = "America/New_York"): WorkflowSchedule => ({
  id: "schedule", workflowId: "workflow", workflowVersionId: "version",
  definition: { kind: "recurring", expression, timezone },
  nextFireAt: null, lastFireAt: null, status: "ACTIVE", overlapPolicy: "skip",
  createdAt: "2026-01-01T00:00:00.000Z", updatedAt: "2026-01-01T00:00:00.000Z",
});

describe("nextOccurrence", () => {
  it("chooses the first instant of an ambiguous fall-back minute, once", () => {
    const first = nextOccurrence(schedule("30 1 * * *"), new Date("2026-11-01T00:00:00.000Z"));
    expect(first?.at).toBe("2026-11-01T05:30:00.000Z");
    expect(first?.logicalId).toContain("2026-11-01T05:30:00.000Z");
    expect(nextOccurrence(schedule("30 1 * * *"), new Date(first!.at))?.at).toBe("2026-11-02T06:30:00.000Z");
  });
  it("advances a spring-forward gap to the next valid local minute", () => {
    expect(nextOccurrence(schedule("30 2 * * *"), new Date("2026-03-08T00:00:00.000Z"))?.at)
      .toBe("2026-03-08T07:00:00.000Z");
  });
  it("supports selected weekdays and skips weekends", () => {
    expect(nextOccurrence(schedule("15 9 * * 1-5"), new Date("2026-09-25T14:00:00.000Z"))?.at)
      .toBe("2026-09-28T13:15:00.000Z");
  });
  it("fires a once schedule exactly once", () => {
    const once = { ...schedule("0 0 * * *"), definition: { kind: "once" as const, fireAt: "2026-10-01T00:00:00.000Z", timezone: "Asia/Tokyo" } };
    expect(nextOccurrence(once, new Date("2026-09-30T00:00:00.000Z"))?.at).toBe("2026-10-01T00:00:00.000Z");
    expect(nextOccurrence(once, new Date("2026-10-01T00:00:00.000Z"))).toBeNull();
  });
  it("rejects unsupported cron syntax and invalid timezone", () => {
    expect(() => nextOccurrence(schedule("*/5 * * * *"), new Date())).toThrow("UNSUPPORTED_CRON");
    expect(() => nextOccurrence(schedule("0 9 * * *", "Not/AZone"), new Date())).toThrow("INVALID_TIMEZONE");
  });
});
