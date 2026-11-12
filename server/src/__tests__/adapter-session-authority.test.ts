import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { agentTaskSessions, agents, companies, createDb, heartbeatRuns, heartbeatRunEvents, issues, EMBEDDED_POSTGRES_TEST_TIMEOUT_MS } from "@paperclipai/db";
import { getEmbeddedPostgresTestSupport, startEmbeddedPostgresTestDatabase } from "./helpers/embedded-postgres.js";
import { ADAPTER_SESSION_AUTHORITY, claimAdapterSessionAuthority, adapterSessionWriteAllowed,
  lockAdapterSessionAuthority, mergeProtectedSessionParams } from "../services/adapter-session-authority.js";
import { assertAgentRunWriteAllowed } from "../agent-run-cancellation.js";

const support = await getEmbeddedPostgresTestSupport();
(support.supported ? describe : describe.skip)("resident adapter session authority", () => {
  let database: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>>;
  let db: ReturnType<typeof createDb>;
  beforeAll(async () => {
    database = await startEmbeddedPostgresTestDatabase("adapter-authority-");
    db = createDb(database.connectionString);
  }, EMBEDDED_POSTGRES_TEST_TIMEOUT_MS);
  afterAll(async () => { await db?.$client.end({ timeout: 0 }); await database?.cleanup(); });
  async function fixture() {
    const companyId = randomUUID(), agentId = randomUUID(), taskKey = randomUUID();
    await db.insert(companies).values({ id: companyId, name: "Authority fixture", issuePrefix: companyId.slice(0, 8).toUpperCase() });
    await db.insert(agents).values({ id: agentId, companyId, name: "Main", adapterType: "ccpocket_bridge" });
    await db.insert(issues).values({ id: taskKey, companyId, title: "Task", status: "in_progress", assigneeAgentId: agentId });
    async function run(key = taskKey) {
      const runId = randomUUID();
      await db.insert(heartbeatRuns).values({ id: runId, companyId, agentId, issueId: key, status: "running",
        runnerProfileJson: { adapterDispatch: { adapterType: "ccpocket_bridge" } } });
      return { companyId, agentId, taskKey: key, runId };
    }
    const first = await run();
    const claim = { hostId: "fixture-host", provider: "codex", nativeSessionId: randomUUID(), bridgeSessionId: randomUUID(),
      operationId: randomUUID(), expectedPreviousRunId: null as string | null, expectedGeneration: 0 };
    return { companyId, agentId, taskKey, first, claim, run };
  }
  it("preserves terminal helper authority until a successor commits, then rejects late publication", async () => {
    const f = await fixture();
    expect(await adapterSessionWriteAllowed(db, f.first)).toBe(false);
    const first = await claimAdapterSessionAuthority(db, f.first, f.claim);
    await db.update(heartbeatRuns).set({ status: "timed_out" }).where(eq(heartbeatRuns.id, f.first.runId));
    expect(await adapterSessionWriteAllowed(db, f.first)).toBe(true);
    expect(await claimAdapterSessionAuthority(db, f.first, f.claim)).toEqual(first);
    const next = await f.run();
    const claim = { ...f.claim, operationId: randomUUID(), expectedPreviousRunId: f.first.runId, expectedGeneration: first.generation };
    const second = await claimAdapterSessionAuthority(db, next, claim);
    expect(second.generation).toBe(first.generation + 1);
    expect(await adapterSessionWriteAllowed(db, f.first)).toBe(false);
    expect(await adapterSessionWriteAllowed(db, next)).toBe(true);
    await expect(claimAdapterSessionAuthority(db, f.first, f.claim)).rejects.toThrow("no longer owns");
    const [row] = await db.select().from(agentTaskSessions).where(eq(agentTaskSessions.taskKey, f.taskKey));
    expect(mergeProtectedSessionParams(row.sessionParamsJson, { nativeSessionId: "late" }, f.first.runId)).toBeUndefined();
    expect(mergeProtectedSessionParams(row.sessionParamsJson, { nativeSessionId: f.claim.nativeSessionId,
      [ADAPTER_SESSION_AUTHORITY]: { runId: f.first.runId } }, next.runId)?.[ADAPTER_SESSION_AUTHORITY]).toEqual(second);
  });
  it("cancellation revokes writes immediately without requiring stop or cleanup receipts", async () => {
    const f = await fixture(); await claimAdapterSessionAuthority(db, f.first, f.claim);
    await db.update(heartbeatRuns).set({ status: "cancelled", resultJson: { executionCancellation: { state: "requested" } } })
      .where(eq(heartbeatRuns.id, f.first.runId));
    await expect(db.transaction(tx => assertAgentRunWriteAllowed(tx as unknown as typeof db, f.companyId, f.first)))
      .rejects.toThrow("cancelled");
    const next = await f.run();
    await claimAdapterSessionAuthority(db, next, { ...f.claim, operationId: randomUUID(), expectedPreviousRunId: f.first.runId, expectedGeneration: 1 });
    expect(await adapterSessionWriteAllowed(db, next)).toBe(true);
  });
  it("rejects stale generations, mismatched native owners and cancelled claims", async () => {
    const f = await fixture(); await claimAdapterSessionAuthority(db, f.first, f.claim);
    const next = await f.run();
    for (const patch of [{ expectedGeneration: 0 }, { expectedPreviousRunId: randomUUID() }]) {
      await expect(claimAdapterSessionAuthority(db, next, { ...f.claim, operationId: randomUUID(),
        expectedPreviousRunId: f.first.runId, expectedGeneration: 1, ...patch })).rejects.toThrow();
    }
    await db.update(heartbeatRuns).set({ status: "cancelled" }).where(eq(heartbeatRuns.id, next.runId));
    await expect(claimAdapterSessionAuthority(db, next, { ...f.claim, operationId: randomUUID(),
      expectedPreviousRunId: f.first.runId, expectedGeneration: 1 })).rejects.toThrow();
    expect(await adapterSessionWriteAllowed(db, f.first)).toBe(true);
  });
  it("does not infer a legacy owner from lastRunId or terminal status", async () => {
    const f = await fixture();
    await db.insert(agentTaskSessions).values({ companyId: f.companyId, agentId: f.agentId, adapterType: "ccpocket_bridge",
      taskKey: f.taskKey, lastRunId: f.first.runId, sessionParamsJson: { hostId: f.claim.hostId, provider: f.claim.provider, nativeSessionId: f.claim.nativeSessionId } });
    const next = await f.run();
    await expect(claimAdapterSessionAuthority(db, next, { ...f.claim, expectedPreviousRunId: f.first.runId }))
      .rejects.toThrow("needs reconciliation");
    await db.update(heartbeatRuns).set({ status: "failed", resultJson: { nativeSessionId: f.claim.nativeSessionId,
      bridgeSessionId: f.claim.bridgeSessionId } }).where(eq(heartbeatRuns.id, f.first.runId));
    await claimAdapterSessionAuthority(db, next, { ...f.claim, expectedPreviousRunId: f.first.runId });
    expect(await adapterSessionWriteAllowed(db, f.first)).toBe(false);
  });
  async function missingLegacyFixture() {
    const f = await fixture();
    await db.update(heartbeatRuns).set({ status: "succeeded", resultJson: { nativeSessionId: f.claim.nativeSessionId,
      bridgeSessionId: f.claim.bridgeSessionId } }).where(eq(heartbeatRuns.id, f.first.runId));
    const [event] = await db.insert(heartbeatRunEvents).values({ companyId: f.companyId, agentId: f.agentId,
      runId: f.first.runId, seq: 1, eventType: "adapter.invoke", payload: { adapterType: "ccpocket_bridge",
        context: { hostId: f.claim.hostId, provider: f.claim.provider, bridgeSessionId: f.claim.bridgeSessionId } } }).returning();
    const next = await f.run();
    return { ...f, next, event, recovery: { ...f.claim, operationId: randomUUID(), bridgeSessionId: randomUUID(),
      expectedPreviousRunId: f.first.runId } };
  }
  it("recovers a missing legacy Chat index from original invocation and result receipts with CAS", async () => {
    const f = await missingLegacyFixture();
    const receipt = await claimAdapterSessionAuthority(db, f.next, f.recovery);
    expect(receipt.generation).toBe(1);
    expect(await claimAdapterSessionAuthority(db, f.next, f.recovery)).toEqual(receipt);
    const [row] = await db.select().from(agentTaskSessions).where(eq(agentTaskSessions.taskKey, f.taskKey));
    expect(row.sessionParamsJson?.adapterSessionAuthority).toMatchObject({ legacySessionRecovery: {
      sourceRunId: f.first.runId, sourceEventId: f.event.id } });
    expect(await adapterSessionWriteAllowed(db, f.first)).toBe(false);
    expect(await adapterSessionWriteAllowed(db, f.next)).toBe(true);
    const rival = await f.run();
    await expect(claimAdapterSessionAuthority(db, rival, { ...f.recovery, operationId: randomUUID() })).rejects.toThrow();
  });
  it("missing legacy index rejects absent or mismatched invocation and result identity", async () => {
    for (const mismatch of ["host", "provider", "bridge", "native", "absent"]) {
      const f = await missingLegacyFixture();
      if (mismatch === "native") await db.update(heartbeatRuns).set({ resultJson: {
        nativeSessionId: randomUUID(), bridgeSessionId: f.claim.bridgeSessionId } }).where(eq(heartbeatRuns.id, f.first.runId));
      else if (mismatch === "absent") await db.delete(heartbeatRunEvents).where(eq(heartbeatRunEvents.id, f.event.id));
      else await db.update(heartbeatRunEvents).set({ payload: { adapterType: "ccpocket_bridge", context: {
        hostId: mismatch === "host" ? "foreign-host" : f.claim.hostId,
        provider: mismatch === "provider" ? "claude" : f.claim.provider,
        bridgeSessionId: mismatch === "bridge" ? randomUUID() : f.claim.bridgeSessionId } } }).where(eq(heartbeatRunEvents.id, f.event.id));
      await expect(claimAdapterSessionAuthority(db, f.next, f.recovery)).rejects.toThrow("needs reconciliation");
      expect(await db.select().from(agentTaskSessions).where(eq(agentTaskSessions.taskKey, f.taskKey))).toHaveLength(0);
    }
  });
  it("missing legacy index rejects foreign tasks, changed generations and existing native owners", async () => {
    for (const mismatch of ["task", "generation", "owner"]) {
      const f = await missingLegacyFixture();
      if (mismatch === "task") {
        const otherTask = randomUUID();
        await db.insert(issues).values({ id: otherTask, companyId: f.companyId, title: "Foreign task" });
        f.next = await f.run(otherTask);
      }
      if (mismatch === "generation") await db.update(heartbeatRuns).set({ contextSnapshot: { conversationSessionGeneration: 1 } }).where(eq(heartbeatRuns.id, f.first.runId));
      if (mismatch === "owner") await db.insert(agentTaskSessions).values({ companyId: f.companyId, agentId: f.agentId,
        taskKey: randomUUID(), adapterType: "ccpocket_bridge", sessionParamsJson: { nativeSessionId: f.claim.nativeSessionId,
          hostId: f.claim.hostId, provider: f.claim.provider } });
      await expect(claimAdapterSessionAuthority(db, f.next, f.recovery)).rejects.toThrow("needs reconciliation");
    }
  });
  it("missing legacy index cannot resurrect a deleted feature-era authority", async () => {
    const f = await missingLegacyFixture();
    await claimAdapterSessionAuthority(db, f.next, f.recovery);
    await db.delete(agentTaskSessions).where(eq(agentTaskSessions.taskKey, f.taskKey));
    const later = await f.run();
    await expect(claimAdapterSessionAuthority(db, later, { ...f.recovery, operationId: randomUUID() })).rejects.toThrow("needs reconciliation");
    expect(await adapterSessionWriteAllowed(db, f.next)).toBe(false);
  });
  it("one native identity cannot keep authority in two task rows", async () => {
    const f = await fixture(); await claimAdapterSessionAuthority(db, f.first, f.claim);
    const otherTask = randomUUID();
    await db.insert(issues).values({ id: otherTask, companyId: f.companyId, title: "Other task", status: "in_progress", assigneeAgentId: f.agentId });
    const next = await f.run(otherTask);
    await expect(claimAdapterSessionAuthority(db, next, { ...f.claim, operationId: randomUUID() })).rejects.toThrow();
    expect(await adapterSessionWriteAllowed(db, f.first)).toBe(true);
    await claimAdapterSessionAuthority(db, next, { ...f.claim, operationId: randomUUID(),
      expectedPreviousRunId: f.first.runId, expectedGeneration: 1 });
    expect(await adapterSessionWriteAllowed(db, f.first)).toBe(false);
    expect(await adapterSessionWriteAllowed(db, next)).toBe(true);
    const returning = await f.run();
    const receipt = await claimAdapterSessionAuthority(db, returning, { ...f.claim, operationId: randomUUID(),
      expectedPreviousRunId: next.runId, expectedGeneration: 2 });
    expect(receipt.generation).toBe(3);
    expect(await adapterSessionWriteAllowed(db, next)).toBe(false);
    expect(await adapterSessionWriteAllowed(db, returning)).toBe(true);
  });
  it("a reset or deletion cannot leave an old helper authorized", async () => {
    const f = await fixture(); await claimAdapterSessionAuthority(db, f.first, f.claim);
    await db.delete(agentTaskSessions).where(eq(agentTaskSessions.taskKey, f.taskKey));
    expect(await adapterSessionWriteAllowed(db, f.first)).toBe(false);
    await expect(claimAdapterSessionAuthority(db, f.first, f.claim)).rejects.toThrow();
  });
  it("binds a new Claude card before its first native identity exists, then upgrades on its successor", async () => {
    const f = await fixture();
    const first = await claimAdapterSessionAuthority(db, f.first, { ...f.claim, nativeSessionId: null });
    expect(await adapterSessionWriteAllowed(db, f.first)).toBe(true);
    const next = await f.run();
    const successor = { ...f.claim, expectedPreviousRunId: f.first.runId, expectedGeneration: first.generation, operationId: randomUUID() };
    await expect(claimAdapterSessionAuthority(db, next, { ...successor, bridgeSessionId: randomUUID() })).rejects.toThrow();
    await claimAdapterSessionAuthority(db, next, successor);
    expect(await adapterSessionWriteAllowed(db, f.first)).toBe(false);
    expect(await adapterSessionWriteAllowed(db, next)).toBe(true);
  });
  it("contention fails explicitly without retry or waiting behind reversed business locks", async () => {
    const f = await fixture(); const receipt = await claimAdapterSessionAuthority(db, f.first, f.claim);
    let release!: () => void, acquired!: () => void;
    const ready = new Promise<void>(resolve => { acquired = resolve; });
    const wait = new Promise<void>(resolve => { release = resolve; });
    const holder = db.transaction(async tx => { await lockAdapterSessionAuthority(tx as unknown as typeof db, [receipt.bindingKey]); acquired(); await wait; });
    await ready;
    try { await expect(db.transaction(tx => assertAgentRunWriteAllowed(tx as unknown as typeof db, f.companyId, f.first))).rejects.toThrow("authority is changing"); }
    finally { release(); await holder; }
    expect(await adapterSessionWriteAllowed(db, f.first)).toBe(true);
  });
  it("unknown authority formats cannot be erased by an adapter or silently reenrolled", async () => {
    const f = await fixture();
    await db.insert(agentTaskSessions).values({ companyId: f.companyId, agentId: f.agentId, taskKey: f.taskKey,
      adapterType: "ccpocket_bridge", sessionParamsJson: { [ADAPTER_SESSION_AUTHORITY]: { schema: "future" } } });
    await expect(claimAdapterSessionAuthority(db, f.first, f.claim)).rejects.toThrow("Unrecognized server binding");
    expect(mergeProtectedSessionParams({ [ADAPTER_SESSION_AUTHORITY]: { schema: "future" } }, {}, f.first.runId)).toBeUndefined();
  });
});
