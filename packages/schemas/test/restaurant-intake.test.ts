import { describe, expect, it } from "vitest";
import * as intake from "../src/index.js";

const now = new Date("2026-09-27T00:00:00Z");
const goal = "Prepare a table reservation at Brooklyn Parlor Shinjuku using https://www.tablecheck.com/shops/brooklynparlor-shinjuku/reserve. Do not book yet.";
const answers = {
  siteId: "tablecheck-brooklyn-parlor", venueId: "brooklynparlor-shinjuku", date: "2026-09-28", time: "19:00", timezone: "Asia/Tokyo",
  adults: "2", children: "0", guestFirstName: "Ada", guestLastName: "Lovelace", phone: "+919999999999", email: "ada@example.com", allergies: "none",
  offerId: "66c4d4411c588898fe3bb84b", intent: "prepare",
} as const;

describe("restaurant intake", () => {
  it("recognizes preparing a table without requiring the word booking", () => {
    expect(intake.restaurantIntake("Prepare a table at Brooklyn Parlor", now).isRestaurant).toBe(true);
  });
  it("retains explicit labeled original details before the form is saved", () => {
    const result = intake.restaurantIntake("Prepare a table reservation\nDate: 2026-09-28\nTime: 19:00\nTimezone: Asia/Tokyo\nAdults: 2\nChildren: 0\nFirst name: Ada\nLast name: Lovelace\nPhone: +919999999999\nContact email: ada@example.com\nAllergies: none", now);
    expect(result.details).toMatchObject({ date: "2026-09-28", time: "19:00", timezone: "Asia/Tokyo", adults: "2", children: "0", guestFirstName: "Ada", guestLastName: "Lovelace", phone: "+919999999999", email: "ada@example.com", allergies: "none" });
    expect(result.missing).not.toContain("email");
  });
  it("asks about conflicting labeled values and accepts a deliberate form correction", () => {
    const original = "Prepare a table reservation\nDate: 2026-09-28\nDate: 2026-09-29";
    const result = intake.restaurantIntake(original, now);
    expect(result.invalid).toContain("date");
    expect(result.details.date).toBeUndefined();
    const fixed = intake.restaurantIntake(intake.updateRestaurantDetails(original, { date: "2026-09-30" }), now);
    expect(fixed.details.date).toBe("2026-09-30");
    expect(fixed.invalid).not.toContain("date");
  });
  it("rejects same-day online booking even when the requested hour is still ahead", () => {
    const result = intake.restaurantIntake(intake.updateRestaurantDetails(goal, { ...answers, date: "2026-09-27" }), now);
    expect(result.invalid).toContain("date");
  });
  it("round-trips explicit details without authorizing booking", () => {
    const saved = intake.updateRestaurantDetails(goal, answers);
    const result = intake.restaurantIntake(saved, now);
    expect(result.isRestaurant).toBe(true);
    expect(result.details).toEqual(answers);
    expect(result.missing).toEqual([]);
    expect(result.invalid).toEqual([]);
    expect(saved).toContain(goal);
  });
  it.each(["phone", "allergies", "guestLastName"] as const)("asks for %s rather than inventing it", key => {
    const result = intake.restaurantIntake(intake.updateRestaurantDetails(goal, { ...answers, [key]: "" }), now);
    expect(result.missing).toContain(key);
    expect(result.details[key]).toBeUndefined();
  });
  it.each([
    ["phone", "9999999999"], ["date", "2026-02-30"], ["date", "2026-09-26"], ["time", "25:00"],
    ["adults", "0"], ["timezone", "America/New_York"], ["email", "bad"], ["intent", "submit-now"],
  ])("rejects invalid %s", (key, value) => {
    const result = intake.restaurantIntake(intake.updateRestaurantDetails(goal, { ...answers, [key]: value }), now);
    expect(result.invalid).toContain(key);
    expect(result.details).not.toHaveProperty(key);
  });
  it("does not silently pick an alternative provider or paid offer", () => {
    const result = intake.restaurantIntake(intake.updateRestaurantDetails(goal, { ...answers, venueId: "other-venue", offerId: "paid-course" }), now);
    expect(result.invalid).toEqual(expect.arrayContaining(["venueId", "offerId"]));
  });
  it("leaves ordinary email and hotel requests outside restaurant intake", () => {
    expect(intake.restaurantIntake("Send an email to ada@example.com", now).isRestaurant).toBe(false);
    expect(intake.restaurantIntake("Book a hotel in Tokyo", now).isRestaurant).toBe(false);
  });
});
