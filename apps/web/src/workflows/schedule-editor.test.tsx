import { it, expect } from "vitest";
import { scheduleDefinition } from "./schedule-editor";
it("sends explicit timezone-aware daily and weekday schedules", () => {
  expect(scheduleDefinition("recurring", "09:30", "Asia/Tokyo", true)).toEqual({ kind: "recurring", expression: "30 9 * * 1-5", timezone: "Asia/Tokyo" });
  expect(() => scheduleDefinition("recurring", "25:90", "Asia/Tokyo", false)).toThrow();
  expect(() => scheduleDefinition("once", "invalid", "UTC", false)).toThrow();
});
