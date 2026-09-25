import { keccak256 } from "viem";
import type {
  JournalEntry,
  TransactionJournal,
} from "../../src/transaction-journal.js";

/** Explicit test fixture. Never permitted by the environment-based production adapter. */
export function createMemoryJournal(): TransactionJournal {
  const entries = new Map<string, JournalEntry>();
  let lock: Promise<unknown> = Promise.resolve();
  return {
    durable: false,
    reserve(identity, prepare) {
      const run = lock
        .catch(() => undefined)
        .then(async () => {
          const existing = entries.get(identity.operation);
          if (existing) return existing;
          const previous = [...entries.values()].filter(
            (e) =>
              e.chainId === identity.chainId && e.signer === identity.signer,
          );
          const floor = previous.length
            ? Math.max(...previous.map((e) => e.nonce)) + 1
            : undefined;
          const signed = await prepare(floor);
          const entry = {
            ...identity,
            ...signed,
            hash: keccak256(signed.raw),
            reverted: false,
          };
          entries.set(identity.operation, entry);
          return entry;
        });
      lock = run;
      return run;
    },
    async markReverted(hash) {
      const entry = [...entries.values()].find((e) => e.hash === hash);
      if (entry) entry.reverted = true;
    },
  };
}
