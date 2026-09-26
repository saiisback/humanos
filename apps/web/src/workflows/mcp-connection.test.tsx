import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { expect, it } from "vitest";
import { LinearConnection } from "./mcp-connection";
import { ConfirmationPreview, OutputView } from "./workflow-review";
it("offers an explicit connection without claiming success", () => {
  const html = renderToStaticMarkup(<LinearConnection connected={false} onChanged={() => {}} />);
  expect(html).toContain("Choose Linear team"); expect(html).not.toContain("Issue created");
});
it("shows the bound team and workspace before a write", () => {
  const html = renderToStaticMarkup(<ConfirmationPreview value={{ destination: "linear:selected-team", binding: { workspace: "Fintrix", team: "Engineering" }, payload: { arguments: { title: "Demo", body: "Body" } } }} />);
  expect(html).toContain("Fintrix"); expect(html).toContain("Engineering"); expect(html).toContain("Demo");
});
it("links only verified Linear results on its exact domain", () => {
  const good = renderToStaticMarkup(<OutputView value={{ provider: "linear", verified: true, id: "F-1", url: "https://linear.app/team/issue/F-1" }} />);
  expect(good).toContain('href="https://linear.app/team/issue/F-1"');
  const bad = renderToStaticMarkup(<OutputView value={{ provider: "linear", verified: true, id: "F-1", url: "https://evil.example" }} />);
  expect(bad).not.toContain("href=");
});
