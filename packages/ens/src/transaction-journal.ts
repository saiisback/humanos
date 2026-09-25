import { keccak256, type Address, type Hex } from "viem";

export interface JournalSql {
  query<T extends Record<string, unknown> = Record<string, unknown>>(
    sql: string,
    values?: unknown[],
  ): Promise<{ rows: T[] }>;
}
export interface JournalDatabase extends JournalSql {
  transaction<T>(callback: (tx: JournalSql) => Promise<T>): Promise<T>;
}
export interface JournalEntry {
  operation: string;
  chainId: number;
  signer: Address;
  nonce: number;
  raw: Hex;
  hash: Hex;
  reverted: boolean;
}
export interface TransactionJournal {
  readonly durable: boolean;
  reserve(
    identity: { operation: string; chainId: number; signer: Address },
    prepare: (
      reservedNonce: number | undefined,
    ) => Promise<{ nonce: number; raw: Hex }>,
  ): Promise<JournalEntry>;
  markReverted(hash: Hex): Promise<void>;
}

/** Call at application boot. Raw transactions are signed, public chain payloads, never private keys. */
export async function initializeEnsTransactionJournal(
  db: JournalSql,
): Promise<void> {
  await db.query(`CREATE TABLE IF NOT EXISTS humanos_ens_transactions (
    operation text PRIMARY KEY,
    chain_id bigint NOT NULL,
    signer text NOT NULL,
    nonce bigint NOT NULL,
    raw text NOT NULL,
    hash text NOT NULL UNIQUE,
    reverted boolean NOT NULL DEFAULT false,
    created_at timestamptz NOT NULL DEFAULT now(),
    UNIQUE (chain_id, signer, nonce)
  )`);
}

/** The SQL transaction commits signed bytes before reserve returns, hence before broadcasting. */
export function createPostgresTransactionJournal(
  db: JournalDatabase,
): TransactionJournal {
  return {
    durable: true,
    reserve: (identity, prepare) =>
      db.transaction(async (tx) => {
        const signer = identity.signer.toLowerCase() as Address;
        await tx.query(
          "SELECT pg_advisory_xact_lock(hashtextextended($1, 0))",
          [`humanos:ens:${identity.chainId}:${signer}`],
        );
        const existing = await tx.query<{ data: JournalEntry }>(
          `SELECT json_build_object('operation',operation,'chainId',chain_id,'signer',signer,
          'nonce',nonce,'raw',raw,'hash',hash,'reverted',reverted) AS data
         FROM humanos_ens_transactions WHERE operation=$1`,
          [identity.operation],
        );
        const entry = existing.rows[0]?.data;
        if (entry) {
          if (entry.chainId !== identity.chainId || entry.signer !== signer)
            throw new Error("ENS_JOURNAL_IDENTITY_CONFLICT");
          return entry;
        }
        const last = await tx.query<{ nonce: string | null }>(
          "SELECT max(nonce)::text AS nonce FROM humanos_ens_transactions WHERE chain_id=$1 AND signer=$2",
          [identity.chainId, signer],
        );
        const lastNonce = last.rows[0]?.nonce;
        const floor = lastNonce == null ? undefined : Number(lastNonce) + 1;
        if (floor !== undefined && !Number.isSafeInteger(floor))
          throw new Error("ENS_NONCE_OVERFLOW");
        const signed = await prepare(floor);
        if (!Number.isSafeInteger(signed.nonce) || signed.nonce < (floor ?? 0))
          throw new Error("ENS_INVALID_NONCE");
        const hash = keccak256(signed.raw);
        await tx.query(
          `INSERT INTO humanos_ens_transactions(operation,chain_id,signer,nonce,raw,hash)
         VALUES($1,$2,$3,$4,$5,$6)`,
          [
            identity.operation,
            identity.chainId,
            signer,
            signed.nonce,
            signed.raw,
            hash,
          ],
        );
        return { ...identity, signer, ...signed, hash, reverted: false };
      }),
    async markReverted(hash) {
      await db.query(
        "UPDATE humanos_ens_transactions SET reverted=true WHERE hash=$1",
        [hash],
      );
    },
  };
}
