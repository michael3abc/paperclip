import { randomUUID } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { asc, eq, inArray, sql } from "drizzle-orm";
import {
  activityLog,
  agentWakeupRequests,
  agents,
  companies,
  createDb,
  heartbeatRuns,
  issueRecoveryActions,
  issueRelations,
  issues,
} from "@paperclipai/db";
import { getEmbeddedPostgresTestSupport, startEmbeddedPostgresTestDatabase } from "./helpers/embedded-postgres.js";
import {
  applyLivenessReset,
  LIVENESS_RESET_SUPERSEDED_MARKER,
  parseLivenessResetArgs,
  planLivenessReset,
  runLivenessResetCommand,
  type LivenessResetResult,
} from "../services/recovery/liveness-reset.js";
import { ABANDONED_LIVENESS_RESET_ERROR_CODE } from "../services/recovery/failure-classification.js";

const support = await getEmbeddedPostgresTestSupport();
const describeDatabase = support.supported ? describe : describe.skip;

type Db = ReturnType<typeof createDb>;

const minutesAgo = (now: Date, minutes: number) => new Date(now.getTime() - minutes * 60_000);

async function seed(db: Db) {
  const now = new Date();
  const old = minutesAgo(now, 120);
  const companyId = randomUUID();
  const prefix = `L${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`;
  await db.insert(companies).values({ id: companyId, name: "Liveness reset fixture", issuePrefix: prefix });

  const agent = (name: string, patch: Partial<typeof agents.$inferInsert> = {}) => ({
    id: randomUUID(), companyId, name, role: "engineer", adapterType: "process", ...patch,
  });
  const paused = (holds: string[]) => ({ status: "paused", lifecycleState: "paused" as const, lifecycleHolds: holds,
    pauseReason: holds[0], pausedAt: old, lifecycleVersion: 3 });
  const a = {
    worker: agent("worker", { status: "running" }),
    manual: agent("manual-paused", paused(["manual"])),
    system: agent("system-paused", paused(["system"])),
    mixed: agent("system-and-manual-paused", paused(["system", "manual"])),
    budget: agent("budget-paused", paused(["budget"])),
  };
  await db.insert(agents).values(Object.values(a));
  const workerId = a.worker.id;

  let issueNumber = 0;
  const issue = (status: string) => ({
    id: randomUUID(), companyId, title: `Fixture ${issueNumber + 1}`, status, priority: "medium",
    assigneeAgentId: workerId, issueNumber: ++issueNumber, identifier: `${prefix}-${issueNumber}`,
  });
  const i = {
    orphan: issue("in_progress"),
    flagged: issue("blocked"),
    reconcile: issue("blocked"),
    workspaceHold: issue("blocked"),
    blockedByRelation: issue("blocked"),
    blocker: issue("todo"),
    config: issue("blocked"),
    staleLock: issue("in_progress"),
    liveLock: issue("in_progress"),
    recent: issue("in_progress"),
    silent: issue("in_progress"),
  };
  await db.insert(issues).values(Object.values(i));
  await db.insert(issueRelations).values({ companyId, issueId: i.blocker.id, relatedIssueId: i.blockedByRelation.id, type: "blocks" });

  const wakeup = (status: string) => ({ id: randomUUID(), companyId, agentId: workerId, source: "assignment", status });
  const w = { orphan: wakeup("claimed"), flagged: wakeup("queued"), deterministic: wakeup("queued"), transient: wakeup("queued") };
  await db.insert(agentWakeupRequests).values(Object.values(w));

  const run = (status: string, patch: Partial<typeof heartbeatRuns.$inferInsert> = {}) => ({
    id: randomUUID(), companyId, agentId: workerId, status, invocationSource: "assignment", ...patch,
  });
  const onIssue = (issueId: string) => ({ scopeKind: "issue" as const, issueId, contextSnapshot: { issueId } });
  const r = {
    orphan: run("running", { ...onIssue(i.orphan.id), startedAt: old, wakeupRequestId: w.orphan.id }),
    flaggedQueued: run("queued", { ...onIssue(i.flagged.id), wakeupRequestId: w.flagged.id }),
    live: run("running", { ...onIssue(i.liveLock.id), startedAt: old }),
    recent: run("running", { ...onIssue(i.recent.id), startedAt: old, lastOutputAt: minutesAgo(now, 5) }),
    silent: run("running", { ...onIssue(i.silent.id), startedAt: old, lastOutputAt: old }),
    succeeded: run("succeeded", { ...onIssue(i.staleLock.id), startedAt: old, finishedAt: old }),
    failedReconcile: run("failed", { ...onIssue(i.reconcile.id), errorCode: "stop_unconfirmed", finishedAt: old }),
    failedDeterministic: run("failed", { errorCode: "configuration_incomplete", finishedAt: old }),
    failedTransient: run("failed", { errorCode: "bridge_unavailable", finishedAt: old }),
  };
  await db.insert(heartbeatRuns).values(Object.values(r));
  const s = {
    deterministic: run("scheduled_retry", { retryOfRunId: r.failedDeterministic.id, wakeupRequestId: w.deterministic.id,
      scheduledRetryAt: minutesAgo(now, -10), scheduledRetryAttempt: 1 }),
    transient: run("scheduled_retry", { retryOfRunId: r.failedTransient.id, wakeupRequestId: w.transient.id,
      scheduledRetryAt: minutesAgo(now, -10), scheduledRetryAttempt: 1 }),
  };
  await db.insert(heartbeatRuns).values(Object.values(s));
  for (const [wakeupId, runId] of [[w.orphan.id, r.orphan.id], [w.flagged.id, r.flaggedQueued.id],
    [w.deterministic.id, s.deterministic.id], [w.transient.id, s.transient.id]] as const) {
    await db.update(agentWakeupRequests).set({ runId }).where(eq(agentWakeupRequests.id, wakeupId));
  }
  const lock = async (issueId: string, runId: string) => db.update(issues)
    .set({ executionRunId: runId, checkoutRunId: runId, executionLockedAt: old }).where(eq(issues.id, issueId));
  await lock(i.orphan.id, r.orphan.id);
  await lock(i.flagged.id, r.flaggedQueued.id);
  await lock(i.staleLock.id, r.succeeded.id);
  await lock(i.liveLock.id, r.live.id);
  await lock(i.recent.id, r.recent.id);
  await lock(i.silent.id, r.silent.id);

  const action = (sourceIssueId: string, kind: string, cause: string, evidence: Record<string, unknown> = {},
    ownerType = "agent") => ({
    id: randomUUID(), companyId, sourceIssueId, kind, cause, ownerType, status: "active",
    fingerprint: `${cause}:${sourceIssueId}`, evidence, nextAction: "Fixture next action",
  });
  const ra = {
    flagged: action(i.flagged.id, "active_run_watchdog", "active_run_silent", { runId: r.flaggedQueued.id }),
    reconcile: action(i.reconcile.id, "stranded_assigned_issue", "legacy_execution_requires_reconciliation",
      { runId: r.failedReconcile.id }, "board"),
    workspaceHold: action(i.workspaceHold.id, "active_run_watchdog", "native_workspace_sync_out_retry_exhausted"),
    blockedByRelation: action(i.blockedByRelation.id, "workspace_validation", "workspace_validation_failed"),
    config: action(i.config.id, "configuration_validation", "configuration_incomplete"),
    recent: action(i.recent.id, "active_run_watchdog", "active_run_silent", { runId: r.recent.id }),
    silent: action(i.silent.id, "active_run_watchdog", "active_run_silent", { runId: r.silent.id }),
  };
  await db.insert(issueRecoveryActions).values(Object.values(ra));

  return { now, companyId, a, i, w, r, s, ra };
}

type Fixture = Awaited<ReturnType<typeof seed>>;

async function snapshot(db: Db, companyId: string) {
  return {
    runs: await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.companyId, companyId)).orderBy(asc(heartbeatRuns.id)),
    wakeups: await db.select().from(agentWakeupRequests).where(eq(agentWakeupRequests.companyId, companyId)).orderBy(asc(agentWakeupRequests.id)),
    actions: await db.select().from(issueRecoveryActions).where(eq(issueRecoveryActions.companyId, companyId)).orderBy(asc(issueRecoveryActions.id)),
    issues: await db.select().from(issues).where(eq(issues.companyId, companyId)).orderBy(asc(issues.id)),
    agents: await db.select().from(agents).where(eq(agents.companyId, companyId)).orderBy(asc(agents.id)),
    activity: await db.select({ id: activityLog.id }).from(activityLog).where(eq(activityLog.companyId, companyId)),
  };
}

const sortedIds = (rows: Array<{ id: string }>) => rows.map(row => row.id).sort();
const changeIds = (result: LivenessResetResult) => ({
  runs: sortedIds(result.changes.runs),
  wakeups: sortedIds(result.changes.wakeups),
  recoveryActions: sortedIds(result.changes.recoveryActions),
  issueStatuses: sortedIds(result.changes.issueStatuses),
  issueLocks: sortedIds(result.changes.issueLocks),
  agents: sortedIds(result.changes.agents),
});

function expectedStoppedChanges(f: Fixture) {
  return {
    runs: [f.r.orphan.id, f.r.flaggedQueued.id, f.r.recent.id, f.r.silent.id, f.s.deterministic.id].sort(),
    wakeups: [f.w.orphan.id, f.w.flagged.id, f.w.deterministic.id].sort(),
    recoveryActions: [f.ra.flagged.id, f.ra.reconcile.id, f.ra.blockedByRelation.id, f.ra.recent.id, f.ra.silent.id].sort(),
    issueStatuses: [f.i.flagged.id, f.i.reconcile.id].sort(),
    issueLocks: [f.i.orphan.id, f.i.flagged.id, f.i.staleLock.id, f.i.recent.id, f.i.silent.id].sort(),
    agents: [f.a.system.id, f.a.mixed.id].sort(),
  };
}

describeDatabase("one-time liveness reset", () => {
  let database: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>>;
  let db: Db;

  beforeAll(async () => {
    database = await startEmbeddedPostgresTestDatabase("paperclip-liveness-reset-");
    db = createDb(database.connectionString);
  }, 120_000);

  afterAll(async () => {
    await db?.$client.end({ timeout: 1 });
    await database?.cleanup();
  });

  const stoppedOptions = (f: Fixture) => ({ companyId: f.companyId, now: f.now, serverStopped: true, liveRunIds: [f.r.live.id] });

  it("dry run lists every planned row and changes nothing", async () => {
    const f = await seed(db);
    const before = await snapshot(db, f.companyId);
    const plan = await planLivenessReset(db, stoppedOptions(f));
    expect(await snapshot(db, f.companyId)).toEqual(before);

    expect(plan.mode).toBe("dry-run");
    expect(changeIds(plan)).toEqual(expectedStoppedChanges(f));
    expect(plan.counts).toMatchObject({ runsAbandoned: 4, scheduledRetriesCancelled: 1, scheduledRetriesKept: 1,
      recoveryActionsClosed: 5, issuesUnblocked: 2, issueLocksCleared: 5, agentPausesLifted: 2 });
    const orphan = plan.changes.runs.find(run => run.id === f.r.orphan.id)!;
    expect(orphan).toMatchObject({ action: "abandon", reason: "server_stopped_orphan",
      before: { status: "running" }, after: { status: "failed", errorCode: ABANDONED_LIVENESS_RESET_ERROR_CODE } });
    expect(plan.kept).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: f.r.live.id, reason: "live_process" }),
      expect.objectContaining({ id: f.ra.workspaceHold.id, reason: "workspace_data_hold" }),
      expect.objectContaining({ id: f.ra.config.id, reason: "not_superseded_by_policy" }),
      expect.objectContaining({ id: f.i.blockedByRelation.id, reason: "unresolved_blockers" }),
      expect.objectContaining({ id: f.a.manual.id, reason: "non_liftable_hold" }),
      expect.objectContaining({ id: f.a.budget.id, reason: "non_liftable_hold" }),
    ]));
  });

  it("without --server-stopped abandons only flagged runs that are silent or queued", async () => {
    const f = await seed(db);
    const plan = await planLivenessReset(db, { companyId: f.companyId, now: f.now });
    expect(sortedIds(plan.changes.runs)).toEqual([f.r.flaggedQueued.id, f.r.silent.id, f.s.deterministic.id].sort());
    expect(plan.changes.runs.find(run => run.id === f.r.silent.id)?.reason).toBe("flagged_by_recovery_action");
    expect(plan.kept).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: f.r.recent.id, reason: "recent_activity" }),
    ]));
    expect(sortedIds(plan.changes.issueLocks)).toEqual([f.i.flagged.id, f.i.staleLock.id, f.i.silent.id].sort());
  });

  it("apply changes exactly the planned rows and leaves the rest untouched", async () => {
    const f = await seed(db);
    const before = await snapshot(db, f.companyId);
    const plan = await planLivenessReset(db, stoppedOptions(f));
    const result = await applyLivenessReset(db, stoppedOptions(f));
    expect(result.mode).toBe("apply");
    expect(changeIds(result)).toEqual(changeIds(plan));
    expect(result.counts).toEqual({ ...plan.counts });

    const after = await snapshot(db, f.companyId);
    const row = <T extends { id: string }>(rows: T[], id: string) => rows.find(item => item.id === id)!;

    for (const id of [f.r.orphan.id, f.r.flaggedQueued.id, f.r.recent.id, f.r.silent.id]) {
      expect(row(after.runs, id)).toMatchObject({ status: "failed", errorCode: ABANDONED_LIVENESS_RESET_ERROR_CODE,
        finishedAt: f.now });
      expect(row(after.runs, id).resultJson).toMatchObject({ livenessReset: { action: "abandon" } });
    }
    expect(row(after.runs, f.s.deterministic.id)).toMatchObject({ status: "cancelled", errorCode: "configuration_incomplete" });
    for (const id of [f.r.live.id, f.s.transient.id, f.r.succeeded.id, f.r.failedReconcile.id]) {
      expect(row(after.runs, id)).toEqual(row(before.runs, id));
    }

    expect(row(after.wakeups, f.w.orphan.id).status).toBe("failed");
    expect(row(after.wakeups, f.w.flagged.id).status).toBe("failed");
    expect(row(after.wakeups, f.w.deterministic.id).status).toBe("cancelled");
    expect(row(after.wakeups, f.w.transient.id)).toEqual(row(before.wakeups, f.w.transient.id));

    for (const id of expectedStoppedChanges(f).recoveryActions) {
      const action = row(after.actions, id);
      expect(action).toMatchObject({ status: "cancelled", outcome: "cancelled" });
      expect(action.resolutionNote?.startsWith(LIVENESS_RESET_SUPERSEDED_MARKER)).toBe(true);
      expect(action.evidence).toEqual(row(before.actions, id).evidence);
    }
    expect(row(after.actions, f.ra.workspaceHold.id)).toEqual(row(before.actions, f.ra.workspaceHold.id));
    expect(row(after.actions, f.ra.config.id)).toEqual(row(before.actions, f.ra.config.id));

    expect(row(after.issues, f.i.flagged.id)).toMatchObject({ status: "todo", executionRunId: null, checkoutRunId: null });
    expect(row(after.issues, f.i.reconcile.id).status).toBe("todo");
    for (const id of [f.i.workspaceHold.id, f.i.blockedByRelation.id, f.i.config.id]) {
      expect(row(after.issues, id).status).toBe("blocked");
    }
    for (const id of [f.i.orphan.id, f.i.staleLock.id, f.i.recent.id, f.i.silent.id]) {
      expect(row(after.issues, id)).toMatchObject({ status: "in_progress", executionRunId: null, checkoutRunId: null,
        executionLockedAt: null });
    }
    expect(row(after.issues, f.i.liveLock.id)).toEqual(row(before.issues, f.i.liveLock.id));
    expect(row(after.issues, f.i.blocker.id)).toEqual(row(before.issues, f.i.blocker.id));
    expect(after.activity.length - before.activity.length).toBe(2);

    expect(row(after.agents, f.a.manual.id)).toEqual(row(before.agents, f.a.manual.id));
    expect(row(after.agents, f.a.budget.id)).toEqual(row(before.agents, f.a.budget.id));
    expect(row(after.agents, f.a.worker.id)).toEqual(row(before.agents, f.a.worker.id));
    expect(row(after.agents, f.a.system.id)).toMatchObject({ lifecycleHolds: [], pauseReason: null,
      lifecycleState: "resuming", lifecycleVersion: 4, status: "paused" });
    expect(row(after.agents, f.a.mixed.id)).toMatchObject({ lifecycleHolds: ["manual"], pauseReason: "manual",
      lifecycleState: "paused", lifecycleVersion: 3 });

    // The reset is idempotent: a second plan finds nothing left to change.
    const again = await planLivenessReset(db, stoppedOptions(f));
    expect(Object.values(changeIds(again)).flat()).toEqual([]);
  });

  it("rolls back every change when any write in the transaction fails", async () => {
    const f = await seed(db);
    const before = await snapshot(db, f.companyId);
    await db.execute(sql.raw(`create or replace function liveness_reset_test_fail() returns trigger language plpgsql as
      $$ begin raise exception 'liveness reset fixture failure'; end $$`));
    // Agents are written last, so every earlier write must roll back with them.
    await db.execute(sql.raw(`create trigger liveness_reset_test_fail before update on agents for each row
      when (new.id = '${f.a.system.id}'::uuid) execute function liveness_reset_test_fail()`));
    try {
      const failure = await applyLivenessReset(db, stoppedOptions(f)).then(() => null, (error: unknown) => error as Error & { cause?: Error });
      expect(failure?.message).toMatch(/update "agents"/);
      expect(failure?.cause?.message).toContain("liveness reset fixture failure");
    } finally {
      await db.execute(sql.raw("drop trigger if exists liveness_reset_test_fail on agents"));
      await db.execute(sql.raw("drop function if exists liveness_reset_test_fail()"));
    }
    expect(await snapshot(db, f.companyId)).toEqual(before);
  });

  it("refuses to run without a receipt, never overwrites one, and records no secrets", async () => {
    expect(() => parseLivenessResetArgs(["--dry-run"])).toThrow(/--receipt <path> is required/);
    expect(() => parseLivenessResetArgs(["--receipt", "r.json"])).toThrow(/exactly one of --dry-run or --apply/);
    expect(() => parseLivenessResetArgs(["--dry-run", "--apply", "--receipt", "r.json"])).toThrow(/exactly one/);
    expect(() => parseLivenessResetArgs(["--dry-run", "--receipt", "r.json", "--lift-hold", "manual"])).toThrow(/never lifts/);
    expect(() => parseLivenessResetArgs(["--dry-run", "--receipt", "r.json", "--live-run", "nope"])).toThrow(/Invalid UUID/);
    expect(() => parseLivenessResetArgs(["--dry-run", "--receipt"])).toThrow(/Missing value/);
    expect(parseLivenessResetArgs(["--apply", "--receipt", "r.json", "--server-stopped"])).toMatchObject({
      mode: "apply", receiptPath: path.resolve("r.json"), serverStopped: true,
    });

    const f = await seed(db);
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "paperclip-liveness-reset-receipt-"));
    try {
      const receiptPath = path.join(dir, "receipt.json");
      const input = { mode: "dry-run" as const, receiptPath, companyId: f.companyId, serverStopped: true,
        liveRunIds: [f.r.live.id], connectionString: database.connectionString, connectionSource: "embedded-test" };
      const { receipt } = await runLivenessResetCommand(input);
      const text = fs.readFileSync(receiptPath, "utf8");
      expect(JSON.parse(text)).toEqual(JSON.parse(JSON.stringify(receipt)));
      expect(receipt).toMatchObject({ mode: "dry-run", connectionSource: "embedded-test" });
      expect(changeIds(receipt)).toEqual(expectedStoppedChanges(f));
      expect(text).not.toContain(database.connectionString);
      expect(text).not.toMatch(/postgres(ql)?:\/\//);
      expect(fs.statSync(receiptPath).mode & 0o777).toBe(0o600);

      await expect(runLivenessResetCommand({ ...input, mode: "apply" })).rejects.toThrow(/Receipt already exists/);
      expect(fs.readFileSync(receiptPath, "utf8")).toBe(text);
      const runs = await db.select({ status: heartbeatRuns.status }).from(heartbeatRuns)
        .where(inArray(heartbeatRuns.id, [f.r.orphan.id, f.s.deterministic.id]));
      expect(runs.map(run => run.status).sort()).toEqual(["running", "scheduled_retry"]);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});
