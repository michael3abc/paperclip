import { and, asc, eq, gt, inArray, isNull, isNotNull, or, sql } from "drizzle-orm";
import { issueWatchdogEvents, issueWatchdogs, type Db } from "@paperclipai/db";
import type { createDeliveryWorkCoordinator } from "./delivery-work-coordinator.js";
import { DELIVERY_QUEUES } from "./delivery-work-notifications.js";
import type { IssueRecoveryScope } from "./issue-recovery-notifications.js";
import { registerScopedDeadlineWork } from "./scoped-deadline-work.js";

type Entry = { id: string; companyId: string; dueAt: number };

/** Commit event consumption and watchdog deadlines together, outside producer locks. */
export async function consumeTaskWatchdogEvents(db: Db, scope?: IssueRecoveryScope): Promise<number> {
  return db.transaction(async tx => {
    const events = await tx.select().from(issueWatchdogEvents)
      .where(scope ? eq(issueWatchdogEvents.companyId, scope.companyId) : undefined)
      .orderBy(asc(issueWatchdogEvents.createdAt), asc(issueWatchdogEvents.id)).limit(100)
      .for("update", { skipLocked: true });
    if (!events.length) return 0;
    // Different scheduler consumers lock watchdogs in the same order. No issue
    // rows are locked, and ordinary producers only append independent events.
    const rows = await tx.select({ id: issueWatchdogs.id }).from(issueWatchdogs).where(and(
      eq(issueWatchdogs.status, "active"), eq(issueWatchdogs.checkIntervalSec, 300),
      inArray(issueWatchdogs.companyId, [...new Set(events.map(event => event.companyId))]),
      sql`EXISTS (SELECT 1 FROM issues source WHERE source.id = ${issueWatchdogs.issueId}
        AND source.company_id = ${issueWatchdogs.companyId}
        AND (${issueWatchdogs.nextCheckAt} IS NOT NULL OR source.status NOT IN ('done', 'cancelled', 'backlog')))`,
    )).orderBy(asc(issueWatchdogs.id)).for("update");
    if (rows.length) await tx.update(issueWatchdogs).set({ nextCheckAt: new Date(),
      obligationVersion: sql`${issueWatchdogs.obligationVersion} + 1`,
    }).where(inArray(issueWatchdogs.id, rows.map(row => row.id)));
    await tx.delete(issueWatchdogEvents).where(inArray(issueWatchdogEvents.id, events.map(event => event.id)));
    return events.length;
  });
}

export function registerTaskWatchdogWork(
  db: Db,
  coordinator: ReturnType<typeof createDeliveryWorkCoordinator>,
  owner: {
    enabled(): Promise<boolean>;
    reconcile(scope: { companyId: string; watchdogId: string; onDeferredDeadline: (at: number) => void }): Promise<{ incomplete: number }>;
  },
  canRun: () => boolean,
) {
  const cursors = new Map<string, string>();
  let enabled = false;
  return registerScopedDeadlineWork<Entry, IssueRecoveryScope>(coordinator, {
    queue: DELIVERY_QUEUES.taskWatchdogs,
    reconstructionIntervalMs: 1_000,
    beforePass: async () => { enabled = await owner.enabled(); },
    decodeScope: hint => hint === "*" ? undefined : JSON.parse(hint) as IssueRecoveryScope,
    matches: (entry, scope) => !scope || entry.companyId === scope.companyId,
    load: async scope => {
      const key = scope?.companyId ?? "*";
      if (!enabled) { cursors.delete(key); return []; }
      const consumed = await consumeTaskWatchdogEvents(db, scope);
      if (consumed) cursors.delete(key);
      const cursor = cursors.get(key);
      const rows = await db.select({ id: issueWatchdogs.id, companyId: issueWatchdogs.companyId, nextCheckAt: issueWatchdogs.nextCheckAt })
        .from(issueWatchdogs).where(and(eq(issueWatchdogs.status, "active"),
          or(isNull(issueWatchdogs.checkIntervalSec), isNotNull(issueWatchdogs.nextCheckAt)),
          scope ? eq(issueWatchdogs.companyId, scope.companyId) : undefined,
          cursor ? gt(issueWatchdogs.id, cursor) : undefined))
        .orderBy(asc(issueWatchdogs.id)).limit(100);
      const complete = rows.length < 100 && consumed < 100;
      if (rows.length < 100) cursors.delete(key); else cursors.set(key, rows.at(-1)!.id);
      return { rows: rows.map(row => ({ id: row.id, companyId: row.companyId, dueAt: row.nextCheckAt?.getTime() ?? Date.now() })), complete };
    },
    check: async entry => {
      if (!enabled) return null;
      let next: number | null = null;
      const result = await owner.reconcile({ companyId: entry.companyId, watchdogId: entry.id,
        onDeferredDeadline: at => { next = next === null ? at : Math.min(next, at); } });
      if (result.incomplete > 0) throw new Error(`Task watchdog ${entry.id} in company ${entry.companyId} has an incomplete subtree`);
      return next === null ? null : { ...entry, dueAt: next };
    },
  }, canRun);
}
