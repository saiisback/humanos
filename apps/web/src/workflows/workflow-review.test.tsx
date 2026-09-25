import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { it, expect } from "vitest";
import { WorkflowReview, OutputView, ConfirmationPreview } from "./workflow-review";
it("shows destination, sender, and exact content in the final confirmation", () => {
  const html = renderToStaticMarkup(<ConfirmationPreview value={{ destination: "reader@example.org", binding: { sender: "sender@example.org" }, payload: { connectorId: "resend", operationId: "email.send", arguments: { to: "reader@example.org", subject: "Hello", body: "<b>Hi</b>" } } }} />);
  expect(html).toContain("sender@example.org");
  expect(html).toContain("reader@example.org");
  expect(html).toContain("Hello");
  expect(html).toContain("&lt;b&gt;Hi&lt;/b&gt;");
});
it("labels a draft plan as unexecuted and does not claim missing connectors work", () => {
  const html = renderToStaticMarkup(<WorkflowReview version={{ graph: { nodes: [{ id: "one", type: "content.generate" }, { id: "two", type: "connector.call" }] }, requiredCapabilities: ["email.send"], activatedAt: null } as any} busy={false} onRun={() => {}} />);
  expect(html).toContain("Plan ready for review");
  expect(html).toContain("No external action has been taken");
  expect(html).toContain("email.send");
  expect(html).toContain("Review &amp; run");
});
it("renders generated content as text, never as executable markup", () => {
  const html = renderToStaticMarkup(<OutputView value={{ outputSchema: "text", text: '<script>alert("x")</script>' }} />);
  expect(html).toContain("&lt;script&gt;");
  expect(html).not.toContain("<script>");
});
