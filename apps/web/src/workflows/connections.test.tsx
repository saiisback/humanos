import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { expect, it } from "vitest";
import { WorkflowConnections } from "./connections";

it("shows setup requirements and sender identity without claiming unconfigured services work", () => {
  const html = renderToStaticMarkup(<WorkflowConnections connections={[
    { id: "resend", label: "Resend Email", kind: "connector", capabilities: ["email.send"], status: "connected", detail: "Sends email.", setup: null, publicIdentity: "sender@example.org" },
    { id: "brave", label: "Brave Search", kind: "connector", capabilities: ["web.search"], status: "setup_required", detail: "Search.", setup: "Set BRAVE_SEARCH_API_KEY on the server.", publicIdentity: null },
    { id: "browser", label: "Local browser", kind: "browser", capabilities: [], status: "disabled", detail: "Off.", setup: "Enable the driver.", publicIdentity: null },
  ]} />);
  expect(html).toContain("Connected for your account");
  expect(html).toContain("sender@example.org");
  expect(html).toContain("Setup required");
  expect(html).toContain("BRAVE_SEARCH_API_KEY");
  expect(html).toContain("Off");
  expect(html).not.toContain("Configured");
});
it("never falls back to a connected state when status is unavailable", () => {
  const html = renderToStaticMarkup(<WorkflowConnections connections={null} unavailable />);
  expect(html).toContain("No service is assumed connected");
});
