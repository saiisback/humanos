import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { expect, it } from "vitest";
import { updateRestaurantDetails } from "@humanos/schemas";
import { RestaurantClarification } from "./restaurant-clarification";

it("retains supplied contact details and asks for the missing ones without showing a booking action", () => {
  const goal = updateRestaurantDetails("Prepare a table at Brooklyn Parlor Shinjuku", { guestFirstName: "Ada", guestLastName: "Lovelace", phone: "+919999999999", email: "ada@example.com" });
  const html = renderToStaticMarkup(<RestaurantClarification goal={goal} busy={false} onAnswer={() => {}} />);
  expect(html).toContain("ada@example.com");
  expect(html).toContain("Allergies");
  expect(html).not.toContain('name="email"');
  expect(html).not.toContain("Confirm this exact action");
  expect(html).not.toContain("[Restaurant details]");
});

it("does not ask again for complete saved details when an older workflow has a stale clarification", () => {
  const goal = updateRestaurantDetails("Prepare a table reservation", {
    siteId: "tablecheck-brooklyn-parlor", venueId: "brooklynparlor-shinjuku", date: "2099-09-28", time: "19:00", timezone: "Asia/Tokyo",
    adults: "2", children: "0", guestFirstName: "Ada", guestLastName: "Lovelace", phone: "+919999999999", email: "ada@example.com",
    allergies: "none", offerId: "66c4d4411c588898fe3bb84b", intent: "book",
  });
  const html = renderToStaticMarkup(<RestaurantClarification goal={goal} busy={false} onAnswer={() => {}}
    blocker="Provide the restaurant, date, name and contact details." />);
  expect(html).not.toContain("Provide the restaurant");
  expect(html).toContain("not ready");
  expect(html).not.toContain("<form");
  expect(html).not.toContain("Confirm this exact action");
});
