import { withDedicatedDbConnection, type Db } from "@paperclipai/db";
import { sql } from "drizzle-orm";
import { withWorkspaceLockKeepalive } from "./native-runtime/native-workspace-lock-keepalive.js";

type Transaction = Parameters<Parameters<Db["transaction"]>[0]>[0];

export async function acquireExecutionWorkspaceLifecycleLock(
  tx: Transaction,
  workspaceId: string,
) {
  await tx.execute(
    sql`select pg_advisory_xact_lock(hashtextextended(${`execution_workspace_lifecycle:${workspaceId}`}, 0))`,
  );
}

export function withExecutionWorkspaceLifecycleLock<T>(
  db: Db,
  workspaceId: string,
  work: (tx: Transaction) => Promise<T>,
  options: { lockTimeoutMs?: number } = {},
): Promise<T> {
  return withDedicatedDbConnection(db, (connection) =>
    connection.transaction(async (tx) => {
      if (options.lockTimeoutMs !== undefined) {
        if (!Number.isSafeInteger(options.lockTimeoutMs) || options.lockTimeoutMs < 1) throw new Error("Invalid workspace lock deadline");
        await tx.execute(sql`select set_config('lock_timeout', ${String(options.lockTimeoutMs) + "ms"}, true)`);
      }
      await acquireExecutionWorkspaceLifecycleLock(tx, workspaceId);
      const rows = await tx.execute(
        sql`select setting::bigint as idle_timeout_ms from pg_settings where name = 'idle_in_transaction_session_timeout'`,
      );
      return withWorkspaceLockKeepalive(
        tx,
        Number(rows[0]?.idle_timeout_ms),
        () => work(tx),
      );
    }),
  );
}
