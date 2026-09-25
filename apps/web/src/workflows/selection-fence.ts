export interface SelectionSnapshot { account: string | undefined; selected: string | null; generation: number }
export function selectionStillCurrent(captured: SelectionSnapshot, current: SelectionSnapshot): boolean {
  return captured.account === current.account && captured.selected === current.selected && captured.generation === current.generation;
}

/** Keep the original selection across both the action and its follow-up read. */
export async function runSelectionAction(
  captured: SelectionSnapshot,
  current: () => SelectionSnapshot,
  action: () => Promise<unknown>,
  refresh: () => Promise<void>,
): Promise<void> {
  if (!selectionStillCurrent(captured, current())) return;
  await action();
  if (selectionStillCurrent(captured, current())) await refresh();
}
