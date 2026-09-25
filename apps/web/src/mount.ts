import type { ReactNode } from "react";
import { createRoot } from "react-dom/client";

type RenderRoot = { render(children: ReactNode): void };
export function mountApp(
  container: HTMLElement,
  children: ReactNode,
  state: { root?: RenderRoot },
  create: (container: HTMLElement) => RenderRoot = createRoot,
) {
  state.root ??= create(container);
  state.root.render(children);
}
