import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { eq, sql } from 'drizzle-orm';
import { agents, companies, projects, issues, issueWatchdogs, heartbeatRuns, agentWakeupRequests, issueRecoveryActions, createDb, applyPendingMigrations, type Db } from '@paperclipai/db';
import { getEmbeddedPostgresTestSupport, startEmbeddedPostgresTestDatabase } from './helpers/embedded-postgres.js';
import { resolveExternalTestDatabaseUrl } from './helpers/external-test-database.js';
import { classifyTaskWatchdogSubtree, taskWatchdogService } from '../services/task-watchdogs.js';
import { reconcilePmFollowthrough } from '../services/task-watchdog-followthrough.js';
import { issueContinuationService, assertPmContinuation, assertIssueContinuationWake } from '../services/issue-continuations.js';
import { pmCoordinationScope } from '../services/pm-coordination-policy.js';
import { loadProjectPmIssueFacts, resolveProjectPmRole } from '../services/agent-workspace-binding.js';
import { notifyIssueRecovery } from '../services/issue-recovery-notifications.js';
import { createDeliveryWorkCoordinator } from '../services/delivery-work-coordinator.js';
import { registerTaskWatchdogWork } from '../services/task-watchdog-work.js';
import { issueService } from '../services/issues.js';
import { setImmediate as immediate } from 'node:timers/promises';

const external = resolveExternalTestDatabaseUrl('PAPERCLIP_PM_FOLLOWTHROUGH_TEST_DATABASE_URL');
const support = external ? { supported: true } : await getEmbeddedPostgresTestSupport();
(support.supported ? describe : describe.skip)('PM durable task follow-through', () => {
  let db: Db;
  let database: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | undefined;
  beforeAll(async () => {
    if (external) await applyPendingMigrations(external);
    else database = await startEmbeddedPostgresTestDatabase('pm-followthrough-');
    db = createDb(external ?? database!.connectionString);
  }, 90_000);
  beforeEach(async () => { await db.execute(sql`truncate companies cascade`); });
  afterAll(async () => { await db?.$client.end({ timeout: 1 }); await database?.cleanup(); });

  async function fixture() {
    const [company] = await db.insert(companies).values({ name: 'PM follow-through', issuePrefix: 'P' + randomUUID().slice(0, 7) }).returning();
    const [project] = await db.insert(projects).values({ companyId: company.id, name: 'Project' }).returning();
    const [worker] = await db.insert(agents).values({ companyId: company.id, name: 'Worker', status: 'idle', adapterType: 'process' }).returning();
    const [pm] = await db.insert(agents).values({ companyId: company.id, name: 'PM', status: 'idle', adapterType: 'process',
      runtimeConfig: { workspaceBinding: { mode: 'project_pm', projectId: project.id, workerRoot: '/tmp/pm-test', workerSlots: 0 },
        taskTracking: { enabled: true, intervalSec: 300, maxRecoveryAttempts: 2 },
        pmDelegation: { version: 1, workers: [{ agentId: worker.id, selections: [{ model: 'test' }] }] } } }).returning();
    const [source] = await db.insert(issues).values({ companyId: company.id, projectId: project.id, title: 'Original task', status: 'blocked',
      assigneeAgentId: worker.id, assigneeAdapterOverrides: { adapterConfig: { model: 'test' } }, createdAt: new Date(0) }).returning();
    const [watchdog] = await db.insert(issueWatchdogs).values({ companyId: company.id, issueId: source.id, watchdogAgentId: pm.id,
      checkIntervalSec: 300, nextCheckAt: new Date() }).returning();
    const [chat] = await db.insert(issues).values({ companyId: company.id, projectId: project.id, title: 'PM coordination',
      assigneeAgentId: pm.id, status: 'in_progress' }).returning();
    const [pmRun] = await db.insert(heartbeatRuns).values({ companyId: company.id, agentId: pm.id, status: 'running',
      nativeIssueId: chat.id, issueId: chat.id, scopeKind: 'issue', runtimeMode: 'native', contextSnapshot: { issueId: chat.id } }).returning();
    await db.update(issues).set({ executionRunId: pmRun.id }).where(eq(issues.id, chat.id));
    const stopped = classifyTaskWatchdogSubtree({ watchdog: { ...watchdog, lastReviewedFingerprint: null, lastReviewedStopSnapshot: null }, issues: [source], activeRuns: [], queuedWakeRequests: [] });
    if (stopped.state !== 'stopped') throw new Error(stopped.state);
    const ensureChild = vi.fn(async () => {
      const [existing] = await db.select().from(issues).where(eq(issues.originId, source.id));
      if (existing) return existing;
      const [child] = await db.insert(issues).values({ companyId: company.id, projectId: project.id, title: 'Coordinate task', status: 'todo',
        assigneeAgentId: pm.id, parentId: source.id, originKind: 'task_watchdog', originId: source.id }).returning();
      return child;
    });
    const wake = vi.fn(async (target: typeof source, _classification: unknown, key: string) => {
      const [run] = await db.insert(heartbeatRuns).values({ companyId: company.id, agentId: pm.id, issueId: target.id,
        nativeIssueId: target.id, scopeKind: 'issue', status: 'queued', runtimeMode: 'native' }).returning();
      await db.insert(agentWakeupRequests).values({ companyId: company.id, agentId: pm.id, source: 'automation', idempotencyKey: key,
        runId: run.id, payload: { issueId: target.id }, status: 'queued' });
      return run;
    });
    const row = async () => (await db.select().from(issueWatchdogs).where(eq(issueWatchdogs.id, watchdog.id)))[0];
    const classify = vi.fn(async () => stopped);
    const deadline = vi.fn();
    const check = async () => reconcilePmFollowthrough(db, await row(), source, { classify, ensureChild, wake, onDeferredDeadline: deadline });
    return { company, project, worker, pm, source, pmRun, watchdog, stopped, ensureChild, wake, row, classify, deadline, check };
  }

  it('keeps an obligation after dispatch, waits for the actual run and caps the same fault at two recoveries', async () => {
    const f = await fixture();
    await f.check();
    expect(f.wake).toHaveBeenCalledTimes(1);
    expect((await f.row()).nextCheckAt!.getTime()).toBeGreaterThan(Date.now() + 290_000);
    await f.check();
    expect(f.wake).toHaveBeenCalledTimes(1);
    expect((await f.row()).lastCheckOutcome).toBe('coordination_live');
    await db.update(heartbeatRuns).set({ status: 'succeeded' }).where(eq(heartbeatRuns.id, (await f.row()).lastWakeupRunId!));
    await f.check();
    expect(f.wake).toHaveBeenCalledTimes(2);
    await db.update(heartbeatRuns).set({ status: 'succeeded' }).where(eq(heartbeatRuns.id, (await f.row()).lastWakeupRunId!));
    await f.check(); await f.check();
    expect(f.wake).toHaveBeenCalledTimes(2);
    expect((await f.row()).lastCheckOutcome).toBe('owner_required');
    expect((await f.row()).nextCheckAt).toBeNull();
    const actions = await db.select().from(issueRecoveryActions);
    expect(actions).toHaveLength(1);
    expect(actions[0].ownerType).toBe('board');
    expect(actions[0].evidence.responsiblePmId).toBe(f.pm.id);
  });

  it('does not replay an unknown wake after restart', async () => {
    const f = await fixture();
    await db.update(issueWatchdogs).set({ lastWakeupKey: 'pm-followthrough:unknown', recoveryAttempts: 1 }).where(eq(issueWatchdogs.id, f.watchdog.id));
    await f.check(); await f.check();
    expect(f.wake).not.toHaveBeenCalled();
    expect((await f.row()).recoveryNotifiedAt).not.toBeNull();
    expect(await db.select().from(issueRecoveryActions)).toHaveLength(1);
  });

  it('records formal human and dependency waits without invoking a model repeatedly', async () => {
    const f = await fixture();
    f.stopped.stoppedLeaves[0].blockerIssueIds = [randomUUID()];
    f.stopped.stoppedLeaves[0].pendingInteractionIds = [randomUUID()];
    await f.check(); await f.check();
    expect(f.wake).not.toHaveBeenCalled();
    expect((await f.row()).waitingReason).toContain('dependency:');
    expect((await f.row()).nextCheckAt).not.toBeNull();
  });

  it.each(['done', 'cancelled', 'backlog'])('drops deadlines for %s tasks', async status => {
    const f = await fixture(); f.source.status = status;
    await f.check();
    expect(f.classify).not.toHaveBeenCalled();
    expect((await f.row()).nextCheckAt).toBeNull();
  });

  it('does not resume a manually paused PM or widen worker slots', async () => {
    const f = await fixture();
    await db.update(agents).set({ status: 'paused' }).where(eq(agents.id, f.pm.id));
    await f.check();
    expect(f.classify).not.toHaveBeenCalled();
    expect((await f.row()).lastCheckOutcome).toBe('paused');
  });

  it('serializes competing checks and requires persisted coordination provenance', async () => {
    const f = await fixture();
    await Promise.all([f.check(), f.check()]);
    expect(f.wake).toHaveBeenCalledTimes(1);
    const childId = (await f.row()).watchdogIssueId!;
    const facts = await loadProjectPmIssueFacts(db, f.company.id, childId);
    expect(facts).not.toBe('missing');
    if (facts === 'missing' || !facts) throw new Error('child missing');
    expect(facts.verifiedPmWatchdog).toBe(true);
    await db.update(issues).set({ originId: randomUUID() }).where(eq(issues.id, childId));
    const forged = await loadProjectPmIssueFacts(db, f.company.id, childId);
    expect(forged && forged !== 'missing' && forged.verifiedPmWatchdog).toBe(false);
  });

  it('rolls back an event obligation and persists a committed event without relying on its wake hint', async () => {
    const f = await fixture(); const before = await f.row();
    await expect(db.transaction(async tx => { await notifyIssueRecovery(tx, { companyId: f.company.id }); throw new Error('rollback'); })).rejects.toThrow('rollback');
    expect((await f.row()).obligationVersion).toBe(before.obligationVersion);
    await db.transaction(tx => notifyIssueRecovery(tx, { companyId: f.company.id }));
    expect((await f.row()).obligationVersion).toBe(before.obligationVersion + 1);
    expect((await f.row()).nextCheckAt!.getTime()).toBeLessThanOrEqual(Date.now());
  });

  it('deduplicates continuation operations, rejects stale versions and preserves unknown receipts', async () => {
    const f = await fixture(); const svc = issueContinuationService(db);
    const body = { idempotencyKey: randomUUID(), observedStatusVersion: f.source.statusVersion, observedRunId: null };
    const first = await svc.begin(f.source, f.pm.id, body, f.pmRun.id);
    const replay = await svc.begin(f.source, f.pm.id, body, f.pmRun.id);
    expect(replay.replay).toBe(true); expect(replay.receipt.id).toBe(first.receipt.id);
    expect((await svc.inspect(first.receipt.id)).outcome).toBe('pending');
    await expect(svc.begin(f.source, f.pm.id, { ...body, idempotencyKey: randomUUID() })).rejects.toMatchObject({ status: 409 });
    await svc.settle(first.receipt.id, { status: 'blocked', outcome: 'blocked', runId: null });
    await expect(svc.begin(f.source, f.pm.id, { ...body, idempotencyKey: randomUUID(), observedStatusVersion: 900 })).rejects.toMatchObject({ status: 409 });
    await expect(svc.inspect(first.receipt.id, randomUUID())).rejects.toMatchObject({ status: 404 });
  });

  it('reports actual run status and never treats run success as task completion', async () => {
    const f = await fixture(); const svc = issueContinuationService(db);
    const op = await svc.begin(f.source, f.pm.id, { idempotencyKey: randomUUID() }, f.pmRun.id);
    const [run] = await db.insert(heartbeatRuns).values({ companyId: f.company.id, agentId: f.worker.id, status: 'running', issueId: f.source.id }).returning();
    await db.insert(agentWakeupRequests).values({ companyId: f.company.id, agentId: f.worker.id, source: 'automation',
      idempotencyKey: 'issue-continue:' + op.receipt.id, runId: run.id });
    expect((await svc.inspect(op.receipt.id)).outcome).toBe('running');
    await db.update(heartbeatRuns).set({ status: 'succeeded' }).where(eq(heartbeatRuns.id, run.id));
    expect(await svc.inspect(op.receipt.id)).toMatchObject({ outcome: 'settled', runStatus: 'succeeded', status: 'blocked' });
    await expect(db.insert(agentWakeupRequests).values({ companyId: f.company.id, agentId: f.worker.id, source: 'automation',
      idempotencyKey: 'issue-continue:' + op.receipt.id })).rejects.toThrow();
  });

  it('creates one real coordination child and preserves the original task', async () => {
    const f = await fixture();
    const enqueued: string[] = [];
    const service = taskWatchdogService(db, { enqueueWakeup: async (agentId, options) => {
      const issueId = options?.contextSnapshot?.issueId;
      const key = options?.idempotencyKey;
      if (typeof issueId !== 'string' || !key) throw new Error('Coordination wake requires an issue and an idempotency key');
      enqueued.push(agentId);
      return f.wake((await db.select().from(issues).where(eq(issues.id, issueId)))[0], f.stopped, key);
    } });
    await service.reconcileTaskWatchdogs({ companyId: f.company.id, watchdogId: f.watchdog.id });
    expect(enqueued).toEqual([f.pm.id]);
    const row = await f.row();
    expect(row.watchdogIssueId).not.toBeNull();
    const facts = await loadProjectPmIssueFacts(db, f.company.id, row.watchdogIssueId!);
    expect(facts && facts !== 'missing' && facts.verifiedPmWatchdog).toBe(true);
    expect((await db.select().from(issues).where(eq(issues.id, f.source.id)))[0].assigneeAgentId).toBe(f.worker.id);
  });

  it('enrolls new PM dispatch atomically and stops terminal deadlines on the next event', async () => {
    const f = await fixture();
    const task = await issueService(db).create(f.company.id, { title: 'New authorized task', projectId: f.project.id,
      status: 'todo', assigneeAgentId: f.worker.id, createdByAgentId: f.pm.id });
    const [tracking] = await db.select().from(issueWatchdogs).where(eq(issueWatchdogs.issueId, task.id));
    expect(tracking).toMatchObject({ watchdogAgentId: f.pm.id, checkIntervalSec: 300 });
    expect(tracking.nextCheckAt).not.toBeNull();
    await db.update(issues).set({ status: 'done' }).where(eq(issues.id, task.id));
    await db.transaction(tx => notifyIssueRecovery(tx, { companyId: f.company.id, issueId: task.id }));
    await taskWatchdogService(db).reconcileTaskWatchdogs({ companyId: f.company.id, watchdogId: tracking.id });
    const [after] = await db.select().from(issueWatchdogs).where(eq(issueWatchdogs.id, tracking.id));
    expect(after.nextCheckAt).toBeNull();
    expect(after.lastCheckOutcome).toBe('terminal');
  });

  it('reconstructs five-minute deadlines, preserves drain work and stops SQL after terminal settlement', async () => {
    const f = await fixture();
    await db.update(issueWatchdogs).set({ nextCheckAt: new Date(Date.now() + 300_000) }).where(eq(issueWatchdogs.id, f.watchdog.id));
    let drained = false;
    const errors: unknown[] = [], passes = new Set<Promise<unknown>>();
    const reconcile = vi.fn(async () => { await f.check(); return { incomplete: 0 }; });
    let worker: ReturnType<typeof registerTaskWatchdogWork> | undefined;
    let coordinator: ReturnType<typeof createDeliveryWorkCoordinator> | undefined;
    vi.useFakeTimers({ toFake: ['Date', 'setTimeout', 'clearTimeout'] });
    // PostgreSQL batches writes on timers after I/O. Pump those short timers
    // while joining a real DB pass instead of awaiting it with a frozen clock.
    const join = async (promise: Promise<unknown>) => {
      let settled = false;
      void promise.finally(() => { settled = true; }).catch(() => {});
      const limit = performance.now() + 5000;
      while (!settled && performance.now() < limit) { await vi.advanceTimersByTimeAsync(1); await immediate(); }
      if (!settled) throw new Error('Database scheduler pass did not settle');
      await promise;
    };
    const select = vi.spyOn(db, 'select');
    const start = async () => {
      coordinator = createDeliveryWorkCoordinator({ owner: db, canRun: () => !drained, onError: e => errors.push(e) });
      const register = coordinator.register.bind(coordinator);
      coordinator.register = (queue, task) => register(queue, { ...task, run: signal => {
        const pass = task.run(signal); passes.add(pass);
        void pass.then(() => passes.delete(pass), () => passes.delete(pass)); return pass;
      } });
      worker = registerTaskWatchdogWork(db, coordinator, { enabled: async () => true, reconcile: async input => {
        const result = await reconcile();
        const row = await f.row();
        if (row.nextCheckAt) input.onDeferredDeadline(row.nextCheckAt.getTime());
        return result;
      } }, () => !drained);
      await join(worker.ready);
    };
    const advance = async (ms: number) => {
      await vi.advanceTimersByTimeAsync(ms);
      await join(Promise.all([...passes]));
      await immediate();
    };
    try {
      await start(); await advance(1000);
      expect(reconcile).not.toHaveBeenCalled();
      await worker!.stop(); await coordinator!.stop();
      await start(); await advance(298_000);
      expect(reconcile).not.toHaveBeenCalled();
      drained = true; await advance(2000);
      expect(reconcile).not.toHaveBeenCalled();
      drained = false; worker!.wake(); await advance(1000);
      expect(reconcile).toHaveBeenCalledTimes(1);
      f.source.status = 'done';
      await advance(300_000); await advance(1000);
      expect(reconcile).toHaveBeenCalledTimes(2);
      const calls = select.mock.calls.length;
      await advance(3_600_000);
      expect(select.mock.calls.length).toBe(calls);
      expect(coordinator!.nextWakeAt()).toBeNull();
      expect(errors).toEqual([]);
    } finally { await worker?.stop(); await coordinator?.stop(); vi.useRealTimers(); select.mockRestore(); }
  });

  it('denies foreign tasks, stale PM runs and forged continuation actors', async () => {
    const f = await fixture(); const scope = pmCoordinationScope(f.pm)!;
    const body = { idempotencyKey: randomUUID(), observedStatusVersion: f.source.statusVersion, observedRunId: null };
    await expect(assertPmContinuation(db, scope, f.source.id, body, f.pmRun.id)).resolves.toMatchObject({ id: f.source.id });
    const foreign = await fixture();
    await expect(assertPmContinuation(db, scope, foreign.source.id, body, f.pmRun.id)).rejects.toMatchObject({ status: 403 });
    const op = await issueContinuationService(db).begin(f.source, f.pm.id, body, f.pmRun.id);
    const input = { companyId: f.company.id, agentId: f.worker.id, issueId: f.source.id, key: 'issue-continue:' + op.receipt.id, actorType: 'agent', actorId: f.pm.id };
    await expect(assertIssueContinuationWake(db, input)).resolves.toBeUndefined();
    await expect(assertIssueContinuationWake(db, { ...input, actorId: f.worker.id })).rejects.toMatchObject({ status: 403 });
    await db.update(heartbeatRuns).set({ status: 'succeeded' }).where(eq(heartbeatRuns.id, f.pmRun.id));
    await expect(assertIssueContinuationWake(db, input)).rejects.toMatchObject({ status: 403 });
  });
});
