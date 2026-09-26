import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { expect, it } from "vitest";
import type { WorkflowVersion } from "@humanos/schemas";
import { RefineCard, planStatus } from "./refine-card";
import { updateHotelDetails, updateRestaurantDetails } from "@humanos/schemas";

const version = (overrides: Partial<WorkflowVersion>) => ({ id: "v", goal: "Research a Japan itinerary", graph: { nodes: [] }, normalizedIntent: {}, activatedAt: null, ...overrides }) as WorkflowVersion;
const noop = () => {};
it("shows saved restaurant details without leaking the internal intake JSON into an editor", () => {
  const goal = updateRestaurantDetails("Prepare a dinner reservation at Brooklyn Parlor", { email: "ada@example.com" });
  const html = renderToStaticMarkup(<RefineCard version={version({ goal })} busy={false} onRefine={noop} onRetry={noop} />);
  expect(html).not.toContain("[Restaurant details]");
  expect(html).toContain("ada@example.com");
  expect(html).toContain("Restaurant details");
});
it("does not expose internal saved hotel data in planner-failure or unprepared editors", () => {
  const goal = updateHotelDetails("Book a hotel in Tokyo", { email: "ada@example.com" });
  for (const normalizedIntent of [{}, { assembly: { outcome: "REVIEW_REQUIRED", failedChecks: ["confidence"] } }, { assembly: { outcome: "NO_CANDIDATES" } }]) {
    const html = renderToStaticMarkup(<RefineCard version={version({ goal, normalizedIntent })} busy={false} onRefine={noop} onRetry={noop} />);
    expect(html).not.toContain("[Hotel details]");
    expect(html).toContain("ada@example.com");
  }
});

it("explains a Jev review stop, keeps the request editable, and states nothing ran", () => {
  const html = renderToStaticMarkup(<RefineCard version={version({ normalizedIntent: { assembly: { outcome: "REVIEW_REQUIRED", failedChecks: ["confidence", "unknown_check"], reasonCodes: ["<b>bold</b>"] } } })} busy={false} onRefine={noop} onRetry={noop} />);
  expect(html).toContain("Jev asked for a clearer request");
  expect(html).toContain("nothing has run");
  expect(html).toContain("wasn’t confident");
  expect(html).not.toContain("unknown_check");
  expect(html).toContain("&lt;b&gt;bold&lt;/b&gt;");
  expect(html).toContain("<textarea");
  expect(html).toContain("Research a Japan itinerary");
  expect(html).toContain("none is installed yet");
});
it("turns a clarification plan into an edit prompt instead of a run button", () => {
  const clarify = version({ graph: { nodes: [{ id: "n", type: "human.input", blockVersion: "1.0.0", dependsOn: [], input: { prompt: "Add exactly one recipient email address." }, capability: null, timeoutMs: 30000, maxAttempts: 3 }] } });
  expect(planStatus(clarify)?.kind).toBe("clarify");
  const html = renderToStaticMarkup(<RefineCard version={clarify} busy={false} onRefine={noop} onRetry={noop} />);
  expect(html).toContain("Add exactly one recipient email address.");
  expect(html).not.toContain("Try again as is");
});
it("does not interfere with an executable plan", () => {
  const ready = version({ graph: { nodes: [{ id: "n", type: "content.generate", blockVersion: "1.0.0", dependsOn: [], input: {}, capability: null, timeoutMs: 30000, maxAttempts: 3 }] } });
  expect(planStatus(ready)).toBeNull();
});
