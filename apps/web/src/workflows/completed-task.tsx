import React from "react";
import type { JsonValue } from "@humanos/schemas";
import { OutputView } from "./workflow-review";

/** A past result and the authority for a future run are separate states. */
export function CompletedTask({ outputs, pending, canRun, busy, transactionHash, onRun, onIdentity, children }: {
  outputs: Array<{ stepRunId: string; output: JsonValue }>;
  pending: boolean; canRun: boolean; busy: boolean; transactionHash?: string | undefined;
  onRun(): void; onIdentity(): void; children?: React.ReactNode;
}) {
  const transaction = transactionHash && /^0x[0-9a-fA-F]{64}$/.test(transactionHash)
    ? `https://sepolia.etherscan.io/tx/${transactionHash}` : null;
  return <section className="completed-task" aria-label="Completed task">
    <h2>Done</h2>
    {outputs.map(output => <OutputView key={output.stepRunId} value={output.output} />)}
    {pending && <p className="task-update fine" role="status">Agent update confirming on Sepolia. Your result is saved. We’ll refresh this automatically; nothing will run again.</p>}
    {!pending && !canRun && <p className="fine" role="status">Your result is saved. Check agent permissions before running this task again.</p>}
    {canRun && !pending && <button className="secondary" disabled={busy} onClick={onRun}>Run again</button>}
    <details className="task-details">
      <summary>Task details &amp; options</summary>
      {transaction && <p><a href={transaction} target="_blank" rel="noopener noreferrer">View agent transaction</a></p>}
      <button className="agent-link" onClick={onIdentity}>Agent permissions</button>
      {children}
    </details>
  </section>;
}
