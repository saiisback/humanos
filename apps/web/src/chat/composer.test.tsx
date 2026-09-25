import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { expect, it } from "vitest";
import { Composer } from "./composer";

it("announces preparation while preventing a second submission", () => {
  const html = renderToStaticMarkup(
    <Composer
      value="Plan an itinerary"
      onChange={() => {}}
      onSubmit={() => {}}
      disabled={false}
      canSubmit={true}
      providerNote="Configured"
      preparing={true}
    />,
  );
  expect(html).toContain("Preparing your task");
  expect(html).toContain('role="status"');
  expect(html).toMatch(/<button[^>]*disabled/);
});
