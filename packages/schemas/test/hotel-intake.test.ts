import { expect, it } from "vitest";
import { hotelIntake, updateHotelDetails } from "../src/hotel-intake.js";

const now = new Date("2026-09-26T16:00:00Z"); // September 27 in Tokyo.
it("extracts supplied details and resolves relative stay dates in Tokyo time", () => {
  const result = hotelIntake("Book a hotel in Tokyo, check in today, check out tomorrow, 1 adult, 1 room. Email ada@example.com", now);
  expect(result.details).toMatchObject({ city: "Tokyo", checkIn: "2026-09-27", checkOut: "2026-09-28", guests: "1", rooms: "1", email: "ada@example.com" });
  expect(result.missing).toEqual(["budget", "guestName"]);
  expect(result.question).toContain("budget");
  expect(result.question).not.toContain("email");
});
it("preserves answers and original request across turns and midnight", () => {
  const original = "Book a hotel in Tokyo, check in today, check out tomorrow, 1 adult, 1 room. Email ada@example.com";
  const saved = updateHotelDetails(original, {}, now);
  const answered = updateHotelDetails(saved, { budget: "JPY 15000", guestName: "Ada Lovelace" }, new Date("2026-09-29T00:00:00Z"));
  expect(answered).toContain(original);
  expect(hotelIntake(answered).missing).toEqual([]);
  expect(hotelIntake(answered).details.checkIn).toBe("2026-09-27");
});
it("replaces a corrected answer without retaining conflicting canonical values", () => {
  const first = updateHotelDetails("Book a hotel in Tokyo", { guests: "1", rooms: "1" }, now);
  const second = updateHotelDetails(first, { guests: "2" }, now);
  expect(hotelIntake(second, now).details.guests).toBe("2");
  expect(second.match(/\[Hotel details\]/g)).toHaveLength(1);
});
it("does not guess personal details, guest counts or unresolved same-email references", () => {
  const result = hotelIntake("Book a hotel in Tokyo today, same email", now);
  for (const key of ["email", "guestName", "guests", "rooms", "budget"]) expect(result.missing).toContain(key);
});
it("rejects invalid dates, checkout order, counts and email without losing valid fields", () => {
  const saved = updateHotelDetails("Book a hotel", { city: "Tokyo", checkIn: "2026-02-30", checkOut: "2026-02-20", guests: "0", rooms: "-1", email: "wrong" }, now);
  const result = hotelIntake(saved, now);
  for (const key of ["checkIn", "guests", "rooms", "email"]) expect(result.missing).toContain(key);
  const reversed = updateHotelDetails("Book a hotel in Tokyo", { checkIn: "2026-09-28", checkOut: "2026-09-27" }, now);
  expect(hotelIntake(reversed, now).missing).toContain("checkOut");
});
it("does not change non-hotel requests or assume a timezone for other cities", () => {
  expect(updateHotelDetails("Write a poem", {}, now)).toBe("Write a poem");
  expect(hotelIntake("Book a hotel in Paris, check in today, check out tomorrow", now).details.checkIn).toBeUndefined();
});
it("understands an explicit from/to stay range", () => {
  expect(hotelIntake("Book a hotel in Tokyo from today to tomorrow", now).details).toMatchObject({ checkIn: "2026-09-27", checkOut: "2026-09-28" });
});
it("reads explicitly labelled answers without a model", () => {
  expect(hotelIntake("Book a hotel\nCity: Kyoto\nCheck-in: 2030-10-02\nCheck-out: 2030-10-03\nGuests: 2\nRooms: 1\nBudget: JPY 20000 per night\nGuest name: Ada Lovelace\nEmail: ada@example.com", now).missing).toEqual([]);
});
it("pins labelled relative dates instead of overwriting them with unvalidated text", () => {
  const saved = updateHotelDetails("Book a hotel\nCity: Tokyo\nCheck-in: today\nCheck-out: tomorrow", {}, now);
  expect(hotelIntake(saved, new Date("2026-10-01T00:00:00Z")).details).toMatchObject({ checkIn: "2026-09-27", checkOut: "2026-09-28" });
});
