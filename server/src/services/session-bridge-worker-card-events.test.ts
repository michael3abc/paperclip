import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { activityLog, agents, agentTaskSessions, companies, createDb, heartbeatRuns, issues, projects } from "@paperclipai/db";
import { recoveryPostgresSupport, startRecoveryPostgres } from "../__tests__/helpers/recovery-postgres.js";
import { deliverExecutionStatuses } from "./execution-status-delivery.js";
import { sessionBridgeEventsService, parseSessionBridgeEventCursor, SESSION_BRIDGE_EVENTS_EMPTY_CURSOR, SESSION_BRIDGE_WORKER_CARD_SNAPSHOT_LIMIT } from "./session-bridge-events.js";

describe.skipIf(!recoveryPostgresSupport.supported)("worker card event authorization", () => {
  let database: Awaited<ReturnType<typeof startRecoveryPostgres>>, db: ReturnType<typeof createDb>;
  beforeAll(async () => { database = await startRecoveryPostgres("paperclip-worker-events-"); db = createDb(database.connectionString); }, 90000);
  afterAll(async () => { await database?.cleanup(); });
  async function seed() {
    const companyId = randomUUID(), projectId = randomUUID(), mainAgentId = randomUUID(), issueId = randomUUID();
    const workerIds = [randomUUID(), randomUUID()], runIds = [randomUUID(), randomUUID()];
    const selections = workerIds.map(() => randomUUID());
    const runtimeConfig = { pmDelegation: { version: 2, defaultSelectionId: selections[0], workers: workerIds.map((agentId, i) => ({
      agentId, harness: "ccpocket_bridge", selections: [{ id: selections[i], model: "model", thinking: null, permission: "full-access", speed: "standard" }],
    })) } };
    await db.insert(companies).values({ id: companyId, name: "Events", issuePrefix: companyId.slice(0, 8).toUpperCase() });
    await db.insert(projects).values({ id: projectId, companyId, name: "Scoped project" });
    await db.insert(agents).values([
      { id: mainAgentId, companyId, name: "Main", role: "engineer", status: "idle", adapterType: "ccpocket_bridge", adapterConfig: { role: "main", projectId }, runtimeConfig },
      ...workerIds.map(id => ({ id, companyId, name: "Worker", role: "engineer", status: "idle", adapterType: "ccpocket_bridge", runtimeConfig: { requireProjectWorkspace: true } })),
    ]);
    await db.insert(issues).values({ id: issueId, companyId, projectId, title: "Task", status: "in_progress", assigneeAgentId: workerIds[0] });
    for (const [i, agentId] of workerIds.entries()) {
      const runId = runIds[i]!;
      // Canonical issueId alone is sufficient; legacy nativeIssueId/context are absent.
      await db.insert(heartbeatRuns).values({ id: runId, companyId, agentId, issueId, scopeKind: "issue", status: "succeeded", finishedAt: new Date() });
      await db.insert(agentTaskSessions).values({ companyId, agentId, adapterType: "ccpocket_bridge", taskKey: issueId, sessionParamsJson: {
        adapterSessionAuthority: { schema: "paperclip.adapter-session-authority.v1", runId, generation: 1, operationId: randomUUID(), bindingKey: "binding", taskKey: issueId, hostId: "host", provider: "codex", nativeSessionId: "native" },
      } });
    }
    const read = (canReadWorkerIssue?: (issue: string, project: string) => Promise<boolean>) => sessionBridgeEventsService(db, { canReadWorkerIssue }).readEvents({ companyId, agentId: mainAgentId, after: parseSessionBridgeEventCursor(SESSION_BRIDGE_EVENTS_EMPTY_CURSOR)! });
    const notify = async (issueActivity = false) => {
      const id = randomUUID();
      await db.insert(activityLog).values({ id, companyId, actorType: "system", actorId: "test", action: issueActivity ? "issue.comment_added" : "session_bridge.worker_card_changed", entityType: issueActivity ? "issue" : "agent", entityId: issueActivity ? issueId : mainAgentId, details: { runId: runIds[0] } });
      return id;
    };
    const snapshot = (canReadWorkerIssue?: (issue: string, project: string) => Promise<boolean>) => sessionBridgeEventsService(db, { canReadWorkerIssue }).poll({ companyId, agentId: mainAgentId, waitMs: 0 });
    return { companyId, projectId, mainAgentId, issueId, workerIds, runIds, runtimeConfig, read, notify, snapshot };
  }
  it("publishes canonical issueId-only status with current request authorization", async () => {
    const f = await seed();
    await db.update(heartbeatRuns).set({ executionStatusDeliveryId: randomUUID() }).where(eq(heartbeatRuns.id, f.runIds[0]!));
    const publish = vi.fn(event => ({ ...event, id: 0, payload: event.payload ?? {}, createdAt: new Date().toISOString() }));
    expect(await deliverExecutionStatuses(db, { publish })).toEqual({ scanned: 1, delivered: 1 });
    // The scoped worker control event must not expand the legacy status payload.
    expect(publish).toHaveBeenCalledWith(expect.objectContaining({ payload: expect.objectContaining({ issueId: null }) }));
    const authorize = vi.fn(async (issue: string, project: string) => issue === f.issueId && project === f.projectId);
    const page = await f.read(authorize);
    expect(page.events).toMatchObject([{ type: "worker_card_changed", runId: f.runIds[0] }]);
    expect(authorize).toHaveBeenCalledWith(f.issueId, f.projectId);
    expect(await deliverExecutionStatuses(db)).toEqual({ scanned: 0, delivered: 0 });
  });
  it("fails closed without issue-read authorization while advancing the raw cursor", async () => {
    const f = await seed(); await f.notify();
    for (const authorize of [undefined, async () => false]) {
      const page = await f.read(authorize);
      expect(page.events).toEqual([]);
      expect(page.cursor).not.toBe(SESSION_BRIDGE_EVENTS_EMPTY_CURSOR);
      expect(JSON.stringify(page)).not.toContain(f.runIds[0]);
    }
  });
  it("rechecks configured workers after an event has already been persisted", async () => {
    const f = await seed(); await f.notify();
    await db.update(agents).set({ runtimeConfig: { pmDelegation: { ...f.runtimeConfig.pmDelegation, defaultSelectionId: f.runtimeConfig.pmDelegation.workers[1]!.selections[0]!.id, workers: [f.runtimeConfig.pmDelegation.workers[1]!] } } }).where(eq(agents.id, f.mainAgentId));
    const authorize = vi.fn(async () => true);
    expect((await f.read(authorize)).events).toEqual([]);
    expect(authorize).not.toHaveBeenCalled();
  });
  it("rejects foreign projects even when the issue reader would allow them", async () => {
    const f = await seed(); await f.notify();
    const other = randomUUID(); await db.insert(projects).values({ id: other, companyId: f.companyId, name: "Other" });
    await db.update(issues).set({ projectId: other }).where(eq(issues.id, f.issueId));
    const authorize = vi.fn(async () => true);
    expect((await f.read(authorize)).events).toEqual([]);
    expect(authorize).not.toHaveBeenCalled();
  });
  it("fans out one issue activity with unique per-run ids and one raw cursor", async () => {
    const f = await seed(), activityId = await f.notify(true);
    const page = await f.read(async () => true);
    expect(page.events).toHaveLength(2);
    expect(new Set(page.events.map(event => event.id))).toEqual(new Set(f.runIds.map(id => `${activityId}:${id}`)));
    expect(new Set(page.events.map(event => event.cursor))).toEqual(new Set([page.cursor]));
    expect(parseSessionBridgeEventCursor(page.cursor)?.id).toBe(activityId);
  });
  it("does not project an unrelated task through a stale session pointer", async () => {
    const f = await seed(); await f.notify(true);
    const other = randomUUID(); await db.insert(issues).values({ id: other, companyId: f.companyId, projectId: f.projectId, title: "Other task", status: "todo" });
    const unrelatedRunId = randomUUID();
    await db.insert(heartbeatRuns).values({ id: unrelatedRunId, companyId: f.companyId, agentId: f.workerIds[0]!, issueId: other, scopeKind: "issue", status: "succeeded" });
    await db.update(agentTaskSessions).set({ sessionParamsJson: { adapterSessionAuthority: {
      schema: "paperclip.adapter-session-authority.v1", runId: unrelatedRunId, generation: 1, operationId: randomUUID(),
      bindingKey: "stale", taskKey: f.issueId, hostId: "host", provider: "codex", nativeSessionId: "native",
    } } }).where(eq(agentTaskSessions.taskKey, f.issueId));
    expect((await f.read(async () => true)).events).toEqual([]);
  });
  it("startup candidates require current project policy and request issue read", async () => {
    const f = await seed();
    expect((await f.snapshot())?.snapshot?.workerCardRunIds).toEqual([]);
    expect((await f.snapshot(async () => false))?.snapshot?.workerCardRunIds).toEqual([]);
    expect(new Set((await f.snapshot(async (issue, project) => issue === f.issueId && project === f.projectId))?.snapshot?.workerCardRunIds)).toEqual(new Set(f.runIds));
    const foreignProject = randomUUID(); await db.insert(projects).values({ id: foreignProject, companyId: f.companyId, name: "Foreign" });
    await db.update(issues).set({ projectId: foreignProject }).where(eq(issues.id, f.issueId));
    const authorize = vi.fn(async () => true);
    expect((await f.snapshot(authorize))?.snapshot?.workerCardRunIds).toEqual([]);
    expect(authorize).not.toHaveBeenCalled();
  });
  it("startup includes unsuccessful current turns but never guesses unknown authority", async () => {
    const f = await seed();
    await db.update(heartbeatRuns).set({ status: "failed" }).where(eq(heartbeatRuns.id, f.runIds[0]!));
    await db.update(heartbeatRuns).set({ status: "running", finishedAt: null }).where(eq(heartbeatRuns.id, f.runIds[1]!));
    expect(new Set((await f.snapshot(async () => true))?.snapshot?.workerCardRunIds)).toEqual(new Set(f.runIds));
    // Legacy lastRunId and a native id are not a server authority receipt.
    await db.update(agentTaskSessions).set({ lastRunId: f.runIds[0], sessionParamsJson: { nativeSessionId: "legacy" } }).where(eq(agentTaskSessions.agentId, f.workerIds[0]!));
    expect((await f.snapshot(async () => true))?.snapshot?.workerCardRunIds).toEqual([f.runIds[1]]);
    const [retained] = await db.select().from(agentTaskSessions).where(eq(agentTaskSessions.agentId, f.workerIds[0]!));
    expect(retained?.sessionParamsJson).toEqual({ nativeSessionId: "legacy" });
    expect(retained?.lastRunId).toBe(f.runIds[0]);
  });
  it("startup reads at most fifty current candidates without refilling or idle scans", async () => {
    const f = await seed();
    const extras = Array.from({ length: 51 }, () => ({ issueId: randomUUID(), runId: randomUUID() }));
    await db.insert(issues).values(extras.map(({ issueId }) => ({ id: issueId, companyId: f.companyId, projectId: f.projectId, title: "Task", status: "in_progress" })));
    await db.insert(heartbeatRuns).values(extras.map(({ issueId, runId }) => ({ id: runId, companyId: f.companyId, agentId: f.workerIds[0]!, issueId, scopeKind: "issue" as const, status: "failed" })));
    await db.insert(agentTaskSessions).values(extras.map(({ issueId, runId }) => ({ companyId: f.companyId, agentId: f.workerIds[0]!, adapterType: "ccpocket_bridge", taskKey: issueId, sessionParamsJson: { adapterSessionAuthority: {
      schema: "paperclip.adapter-session-authority.v1", runId, generation: 1, operationId: randomUUID(), bindingKey: "binding", taskKey: issueId, nativeSessionId: "native",
    } } })));
    const authorize = vi.fn(async () => true);
    const page = await f.snapshot(authorize);
    expect(page?.snapshot?.workerCardRunIds).toHaveLength(SESSION_BRIDGE_WORKER_CARD_SNAPSHOT_LIMIT);
    expect(authorize).toHaveBeenCalledTimes(SESSION_BRIDGE_WORKER_CARD_SNAPSHOT_LIMIT);
    authorize.mockClear(); authorize.mockResolvedValue(false);
    expect((await f.snapshot(authorize))?.snapshot?.workerCardRunIds).toEqual([]);
    expect(authorize).toHaveBeenCalledTimes(SESSION_BRIDGE_WORKER_CARD_SNAPSHOT_LIMIT);
    authorize.mockClear();
    const idle = await sessionBridgeEventsService(db, { canReadWorkerIssue: authorize }).poll({ companyId: f.companyId, agentId: f.mainAgentId, after: parseSessionBridgeEventCursor(page!.cursor)!, waitMs: 0 });
    expect(idle).not.toHaveProperty("snapshot");
    expect(authorize).not.toHaveBeenCalled();
  });
});
