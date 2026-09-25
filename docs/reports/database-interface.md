# Frozen persistence API

`import { Database, type Transaction } from '@humanos/database'`.

`new Database(connectionString, {schema?:string})`; schema defaults to public. `await db.migrate()`; `await db.close()`.

Database and Transaction share: `query<T extends QueryResultRow>(sql, values?): Promise<QueryResult<T>>`, `get<T>(table,id):Promise<T|null>`, `list<T>(table):Promise<T[]>`, `insert<T extends {id:string}>(table,entity):Promise<T>`, `put<T extends {id:string}>(table,entity):Promise<T>`, `delete(table,id):Promise<boolean>`.

Allowed table names: roots, nullifiers, sessions, missions, agents, actions, approvals, receipts, audit, challenges. All rows have id + data JSONB and timestamp. Domain rows are schema validated. Extra records are typed by callers but must be JSON-safe. Nullifiers id is hash scoped by caller to provider/environment; sessions use hash of session token as id, rootId/expiresAt; challenges use id/rootId/expiresAt/consumedAt plus request-specific fields. All reads return persisted data objects, no row wrappers. Query SQL is internal only and uses current schema search_path. Use parameterized values.

`db.transaction<T>((tx:Transaction)=>Promise<T>):Promise<T>` guarantees rollback on errors. `db.withLockedAction<T>(actionId,(tx,action:ActionProposal)=>Promise<T>):Promise<T>` locks mission first then action until commit, checks existence; all revoke/update mission writes must lock the mission row (`tx.lockMission(id)`) for race safety. `tx.lockMission(id):Promise<Mission>`.

`tx.consumeApproval(id, now:Date):Promise<Approval>` atomically changes VERIFIED unconsumed approval to CONSUMED only before binding expiry. `tx.consumeChallenge<T>(id,now:Date):Promise<T>` atomically consumes unexpired unused challenge. `tx.claimNullifier(id,rootId):Promise<void>` inserts globally unique nullifier record. `tx.getReceiptForAction(actionId):Promise<ExecutionReceipt|null>`.

Receipts have unique actionId and idempotencyKey, approvals have unique bindingHash (human nullifier may repeat across separately bound approvals), roots are unique by id; separate nullifier claims must run in same root-creation transaction. Approvals/receipts reject upsert: use insert/consume methods, receipts reconciliation uses explicit SQL after internal validation. Audit append-only. Foreign keys bind missions->roots, actions->missions, approvals/receipts->actions. General put uses upsert for mutable entities. Transaction lock ordering is mission then action. External side effects still require downstream idempotency and timeout reconciliation; SQL rollback cannot undo external effects.

`tx.updateApprovalStatus(id, status: 'VERIFIED'|'DENIED'|'CANCELLED', verification?: {verifiedAt:string;nullifierHash:string|null}):Promise<Approval>` locks approval row, permits PENDING only while binding unexpired. VERIFIED requires timestamp not before creation/not in future; WORLD_FRESH requires nullifier. No status reset is possible. SessionRecordSchema and ChallengeRecordSchema validate mandatory expiry, session rootId, and arbitrary additional JSON fields. Domain objects have strict schemas; never persist extra fields in those objects.
