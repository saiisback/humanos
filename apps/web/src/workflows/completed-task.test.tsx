import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { expect, it } from "vitest";
import { CompletedTask } from "./completed-task";

it("keeps the saved result ahead of a pending agent update without offering another run", () => {
  const html = renderToStaticMarkup(<CompletedTask pending canRun={false} busy={false}
    outputs={[{ stepRunId: "step", output: { text: "Your saved welcome draft." } }]}
    transactionHash={`0x${"ab".repeat(32)}`} onRun={() => {}} onIdentity={() => {}} />);
  expect(html.indexOf("Your saved welcome draft.")).toBeLessThan(html.indexOf("Agent update confirming"));
  expect(html).toContain("Your result is saved");
  expect(html).toContain("sepolia.etherscan.io/tx/");
  expect(html).not.toContain("Run again");
  expect(html).not.toContain("disabled");
  expect(html).not.toContain("Plan ready");
});

it("offers an explicit rerun only when authority is ready", () => {
  const props = { outputs: [], busy: false, pending: false, onRun() {}, onIdentity() {} };
  expect(renderToStaticMarkup(<CompletedTask {...props} canRun />)).toContain("Run again");
  expect(renderToStaticMarkup(<CompletedTask {...props} canRun={false} />)).not.toContain("Run again");
});
