import { expect, it, vi } from "vitest";
import { mountApp } from "./mount";

it("reuses a React root when the entry module is refreshed", () => {
  const root = { render: vi.fn() };
  const create = vi.fn(() => root);
  const state = {};
  const container = {} as HTMLElement;
  mountApp(container, "first", state, create);
  mountApp(container, "second", state, create);
  expect(create).toHaveBeenCalledTimes(1);
  expect(root.render.mock.calls).toEqual([["first"], ["second"]]);
});
