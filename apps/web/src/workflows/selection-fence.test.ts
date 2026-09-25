import { expect, it } from "vitest";
import { selectionStillCurrent, runSelectionAction } from "./selection-fence";

it("ignores a late run response after account or workflow selection changes", async () => {
  let deliver!: (value: string) => void;
  const pending = new Promise<string>(resolve => { deliver = resolve; });
  const current = { account: "alice", selected: "workflow-a", generation: 1 };
  const captured = { ...current };
  const installed: string[] = [];
  const request = pending.then(value => { if (selectionStillCurrent(captured, current)) installed.push(value); });
  current.account = "bob"; current.selected = "workflow-b"; current.generation++;
  deliver("old-account-run"); await request;
  expect(installed).toEqual([]);
  expect(selectionStillCurrent(captured, { account: "alice", selected: "workflow-a", generation: 2 })).toBe(false);
});

it.each(["account", "selected", "generation"] as const)("does not refresh an old run when %s changes during its action", async field => {
  let finish!: () => void;
  const pending = new Promise<void>(resolve => { finish = resolve; });
  const current = { account: "alice", selected: "workflow-a", generation: 1 };
  const displayed: string[] = [];
  const action = runSelectionAction({ ...current }, () => current, () => pending, async () => { displayed.push("old-run"); });
  if (field === "generation") current.generation++;
  else current[field] = "different";
  finish(); await action;
  expect(displayed).toEqual([]);
});

it("refreshes the run after an action only while its original selection remains current", async () => {
  const current = { account: "alice", selected: "workflow-a", generation: 1 };
  const events: string[] = [];
  await runSelectionAction({ ...current }, () => current, async () => { events.push("action"); }, async () => { events.push("refresh"); });
  expect(events).toEqual(["action", "refresh"]);
});

it("does not dispatch an action from a stale screen", async () => {
  const captured = { account: "alice", selected: "workflow-a", generation: 1 };
  const events: string[] = [];
  await runSelectionAction(captured, () => ({ ...captured, generation: 2 }), async () => { events.push("action"); }, async () => { events.push("refresh"); });
  expect(events).toEqual([]);
});
