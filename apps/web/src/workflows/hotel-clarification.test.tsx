import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { expect, it } from "vitest";
import { updateHotelDetails } from "@humanos/schemas";
import { HotelClarification } from "./hotel-clarification";
it("asks only missing details and shows saved information without requesting it again", () => {
  const goal = updateHotelDetails("Book a hotel in Tokyo", { checkIn: "2030-10-02", checkOut: "2030-10-03", guests: "1", rooms: "1", email: "ada@example.com" });
  const html = renderToStaticMarkup(<HotelClarification goal={goal} busy={false} onAnswer={() => {}} />);
  expect(html).toContain("Nightly budget");
  expect(html).toContain("Guest’s full name");
  expect(html).toContain("ada@example.com");
  expect(html).not.toContain('name="email"');
  expect(html).not.toContain('name="checkIn"');
  expect(html).toContain("Continue this task");
  expect(html).not.toContain("[Hotel details]");
});
it("never presents a booking button when all details are collected but service is missing", () => {
  const goal = updateHotelDetails("Book a hotel", { city: "Tokyo", checkIn: "2030-10-02", checkOut: "2030-10-03", guests: "1", rooms: "1", budget: "JPY 15000", guestName: "Ada Lovelace", email: "ada@example.com" });
  const html = renderToStaticMarkup(<HotelClarification goal={goal} busy={false} onAnswer={() => {}} />);
  expect(html).toContain("supported hotel-booking service");
  expect(html).toContain("nothing has been booked");
  expect(html).not.toContain("Confirm this exact action");
  expect(html).toContain("Edit stay details");
});
