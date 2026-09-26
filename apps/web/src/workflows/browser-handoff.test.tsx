import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { expect, it } from "vitest";
import { BrowserHandoff, type BrowserBookingPreview } from "./browser-handoff";

const preview: BrowserBookingPreview = {
  venue: "Sakura Kitchen — a very long venue name that must wrap without hiding the price on mobile screens",
  origin: "https://book.example.com", date: "2026-10-02", time: "19:00", timezone: "Asia/Tokyo", guests: "2",
  name: "Ada Lovelace", contact: "ada@example.com", offer: "Counter seats", price: "JPY 1,000 deposit",
  terms: "Refundable until 24 hours before. After that the deposit is kept. ".repeat(5),
};
const render = (props: Partial<React.ComponentProps<typeof BrowserHandoff>>) =>
  renderToStaticMarkup(<BrowserHandoff state="preparing" accountLabel="0x1111…1111" {...props} />);

it("shows every material booking detail before final confirmation", () => {
  const html = render({ state: "awaiting_confirmation", preview });
  for (const value of ["Sakura Kitchen", "https://book.example.com", "2026-10-02", "19:00 (Asia/Tokyo)", "Ada Lovelace", "ada@example.com", "Counter seats", "JPY 1,000 deposit", "Refundable until"])
    expect(html).toContain(value);
  expect(html).toContain("overflow-wrap:anywhere");
  expect(render({ state: "awaiting_confirmation", preview: null })).toContain("can&#x27;t be confirmed");
});

it("an uncertain outcome never says booked", () => {
  const html = render({ state: "uncertain", reference: "R-ABC123" });
  expect(html).toContain("may or may not");
  expect(html).not.toMatch(/>Booked</);
  expect(html).not.toContain("R-ABC123");
});

it("unavailable runtime and missing sites never look connected", () => {
  expect(render({ state: "unavailable" })).toContain("Nothing was opened or booked");
  expect(render({ state: "disconnected" })).toContain("No inspected booking site");
});

it("asks for missing details and scopes handoff to the account without secrets", () => {
  expect(render({ state: "needs_details", missing: ["Party size", "Contact email"] })).toContain("<li>Contact email</li>");
  const handoff = render({ state: "needs_login" });
  expect(handoff).toContain("For 0x1111…1111 only");
  expect(handoff).toContain("never sees your password");
  expect(render({ state: "confirmed", reference: "R-ABC123" })).toContain("R-ABC123");
});
