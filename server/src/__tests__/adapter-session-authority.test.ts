import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { agentTaskSessions, agents, companies, createDb, heartbeatRuns, issues, EMBEDDED_POSTGRES_TEST_TIMEOUT_MS } from "@paperclipai/db";
import { getEmbeddedPostgresTestSupport, startEmbeddedPostgresTestDatabase } from "./helpers/embedded-postgres.js";
import { ADAPTER_SESSION_AUTHORITY, claimAdapterSessionAuthority, adapterSessionWriteAllowed,
  lockAdapterSessionAuthority, mergeProtectedSessionParams } from "../services/adapter-session-authority.js";
import { assertAgentRunWriteAllowed } from "../agent-run-cancellation.js";

// Liveness-first (rule 1): session authority is last-writer-wins. A running,
// uncancelled run of the same task always takes over; CAS fields are ignored.
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
    const claim = { hostId: "fixture-host", provider: "codex", nativeSessionId: randomUUID() as string | null, bridgeSessionId: randomUUID(),
      operationId: randomUUID(), expectedPreviousRunId: null as string | null, expectedGeneration: 0 };
    return { companyId, agentId, taskKey, first, claim, run };
  }

  it("takes over from the previous owner, records takeoverFrom and rejects late publication", async () => {
    const f = await fixture();
    expect(await adapterSessionWriteAllowed(db, f.first)).toBe(false);
    const first = await claimAdapterSessionAuthority(db, f.first, f.claim);
    expect(first.generation).toBe(1);
    expect(await claimAdapterSessionAuthority(db, f.first, f.claim)).toEqual(first);
    await db.update(heartbeatRuns).set({ status: "timed_out" }).where(eq(heartbeatRuns.id, f.first.runId));
    expect(await adapterSessionWriteAllowed(db, f.first)).toBe(true);
    const next = await f.run();
    // Stale CAS fields are ignored.
    const second = await claimAdapterSessionAuthority(db, next, { ...f.claim, operationId: randomUUID(),
      expectedPreviousRunId: randomUUID(), expectedGeneration: 42 });
    expect(second).toMatchObject({ generation: 2, previousRunId: f.first.runId, previousGeneration: 1,
      takeoverFrom: { runId: f.first.runId, generation: 1, taskKey: f.taskKey } });
    expect(await adapterSessionWriteAllowed(db, f.first)).toBe(false);
    expect(await adapterSessionWriteAllowed(db, next)).toBe(true);
    // A terminal run can never claim again.
    await expect(claimAdapterSessionAuthority(db, f.first, f.claim)).rejects.toThrow("no longer owns");
    const [row] = await db.select().from(agentTaskSessions).where(eq(agentTaskSessions.taskKey, f.taskKey));
    expect(mergeProtectedSessionParams(row.sessionParamsJson, { nativeSessionId: "late" }, f.first.runId)).toBeUndefined();
    expect(mergeProtectedSessionParams(row.sessionParamsJson, { nativeSessionId: f.claim.nativeSessionId,
      [ADAPTER_SESSION_AUTHORITY]: { runId: f.first.runId } }, next.runId)?.[ADAPTER_SESSION_AUTHORITY]).toEqual(second);
  });

  it("lets a running predecessor be taken over without any CAS and the latest writer win", async () => {
    const f = await fixture(); await claimAdapterSessionAuthority(db, f.first, f.claim);
    const next = await f.run();
    const second = await claimAdapterSessionAuthority(db, next, { ...f.claim, operationId: randomUUID(), expectedGeneration: 0 });
    expect(second.generation).toBe(2);
    expect(await adapterSessionWriteAllowed(db, f.first)).toBe(false);
    const third = await claimAdapterSessionAuthority(db, f.first, { ...f.claim, operationId: randomUUID() });
    expect(third).toMatchObject({ generation: 3, takeoverFrom: { runId: next.runId, generation: 2 } });
    expect(await adapterSessionWriteAllowed(db, f.first)).toBe(true);
    expect(await adapterSessionWriteAllowed(db, next)).toBe(false);
  });

  it("only rejects runs that are not running, cancel-requested or bound to another task", async () => {
    const f = await fixture(); await claimAdapterSessionAuthority(db, f.first, f.claim);
    const cancelRequested = await f.run();
    await db.update(heartbeatRuns).set({ resultJson: { executionCancellation: { state: "requested" } } })
      .where(eq(heartbeatRuns.id, cancelRequested.runId));
    await expect(claimAdapterSessionAuthority(db, cancelRequested, { ...f.claim, operationId: randomUUID() })).rejects.toThrow("no longer owns");
    const cancelled = await f.run();
    await db.update(heartbeatRuns).set({ status: "cancelled" }).where(eq(heartbeatRuns.id, cancelled.runId));
    await expect(claimAdapterSessionAuthority(db, cancelled, { ...f.claim, operationId: randomUUID() })).rejects.toThrow("no longer owns");
    const otherTask = randomUUID();
    await db.insert(issues).values({ id: otherTask, companyId: f.companyId, title: "Other task" });
    const foreign = await f.run(otherTask);
    await expect(claimAdapterSessionAuthority(db, { ...foreign, taskKey: f.taskKey }, { ...f.claim, operationId: randomUUID() }))
      .rejects.toMatchObject({ details: { code: "session_task_mismatch" } });
    await expect(claimAdapterSessionAuthority(db, f.first, { ...f.claim, hostId: " " }))
      .rejects.toMatchObject({ details: { code: "session_identity_invalid" } });
    expect(await adapterSessionWriteAllowed(db, f.first)).toBe(true);
  });

  it("cancellation revokes writes immediately without requiring stop or cleanup receipts", async () => {
    const f = await fixture(); await claimAdapterSessionAuthority(db, f.first, f.claim);
    await db.update(heartbeatRuns).set({ status: "cancelled", resultJson: { executionCancellation: { state: "requested" } } })
      .where(eq(heartbeatRuns.id, f.first.runId));
    await expect(db.transaction(tx => assertAgentRunWriteAllowed(tx as unknown as typeof db, f.companyId, f.first)))
      .rejects.toThrow("cancelled");
    const next = await f.run();
    await claimAdapterSessionAuthority(db, next, { ...f.claim, operationId: randomUUID() });
    expect(await adapterSessionWriteAllowed(db, next)).toBe(true);
  });

  it("binds over a pre-authority session index without legacy proof", async () => {
    const f = await fixture();
    await db.insert(agentTaskSessions).values({ companyId: f.companyId, agentId: f.agentId, adapterType: "ccpocket_bridge",
      taskKey: f.taskKey, lastRunId: f.first.runId, sessionParamsJson: { hostId: f.claim.hostId, provider: f.claim.provider, nativeSessionId: f.claim.nativeSessionId } });
    const next = await f.run();
    const receipt = await claimAdapterSessionAuthority(db, next, { ...f.claim, expectedPreviousRunId: f.first.runId });
    expect(receipt.generation).toBe(1);
    expect(await adapterSessionWriteAllowed(db, f.first)).toBe(false);
    expect(await adapterSessionWriteAllowed(db, next)).toBe(true);
  });

  it("a deleted session index (reset conversation or changed adapter) yields a fresh binding", async () => {
    const f = await fixture(); await claimAdapterSessionAuthority(db, f.first, f.claim);
    await db.delete(agentTaskSessions).where(eq(agentTaskSessions.taskKey, f.taskKey));
    expect(await adapterSessionWriteAllowed(db, f.first)).toBe(false);
    const next = await f.run();
    const fresh = await claimAdapterSessionAuthority(db, next, { ...f.claim, operationId: randomUUID(),
      expectedPreviousRunId: f.first.runId, expectedGeneration: 1 });
    expect(fresh.generation).toBe(1);
    expect(fresh.takeoverFrom).toBeUndefined();
    expect(await adapterSessionWriteAllowed(db, next)).toBe(true);
    expect(await adapterSessionWriteAllowed(db, f.first)).toBe(false);
  });

  it("one native identity keeps authority in only one task row", async () => {
    const f = await fixture(); await claimAdapterSessionAuthority(db, f.first, f.claim);
    const otherTask = randomUUID();
    await db.insert(issues).values({ id: otherTask, companyId: f.companyId, title: "Other task", status: "in_progress", assigneeAgentId: f.agentId });
    const next = await f.run(otherTask);
    const moved = await claimAdapterSessionAuthority(db, next, { ...f.claim, operationId: randomUUID() });
    expect(moved).toMatchObject({ generation: 2, takeoverFrom: { runId: f.first.runId, taskKey: f.taskKey } });
    expect(await adapterSessionWriteAllowed(db, f.first)).toBe(false);
    expect(await adapterSessionWriteAllowed(db, next)).toBe(true);
    const returning = await f.run();
    const receipt = await claimAdapterSessionAuthority(db, returning, { ...f.claim, operationId: randomUUID() });
    expect(receipt.generation).toBe(3);
    expect(await adapterSessionWriteAllowed(db, next)).toBe(false);
    expect(await adapterSessionWriteAllowed(db, returning)).toBe(true);
  });

  it("binds a new Claude card before its native identity exists and lets a successor replace the card", async () => {
    const f = await fixture();
    const first = await claimAdapterSessionAuthority(db, f.first, { ...f.claim, nativeSessionId: null });
    expect(await adapterSessionWriteAllowed(db, f.first)).toBe(true);
    const next = await f.run();
    const successor = await claimAdapterSessionAuthority(db, next, { ...f.claim, bridgeSessionId: randomUUID(), operationId: randomUUID() });
    expect(successor).toMatchObject({ generation: first.generation + 1, takeoverFrom: { runId: f.first.runId } });
    expect(await adapterSessionWriteAllowed(db, f.first)).toBe(false);
    expect(await adapterSessionWriteAllowed(db, next)).toBe(true);
  });

  it("contention waits for the holder instead of failing", async () => {
    const f = await fixture(); const receipt = await claimAdapterSessionAuthority(db, f.first, f.claim);
    let release!: () => void, acquired!: () => void;
    const ready = new Promise<void>(resolve => { acquired = resolve; });
    const wait = new Promise<void>(resolve => { release = resolve; });
    const holder = db.transaction(async tx => { await lockAdapterSessionAuthority(tx as unknown as typeof db, [receipt.bindingKey]); acquired(); await wait; });
    await ready;
    let settled = false;
    const writer = db.transaction(tx => assertAgentRunWriteAllowed(tx as unknown as typeof db, f.companyId, f.first))
      .then(() => { settled = true; });
    await new Promise(resolve => setTimeout(resolve, 300));
    expect(settled).toBe(false);
    release(); await holder; await writer;
    expect(settled).toBe(true);
    expect(await adapterSessionWriteAllowed(db, f.first)).toBe(true);
  });

  it("an unknown authority format is replaced by a running claim but never by a late publisher", async () => {
    const f = await fixture();
    await db.insert(agentTaskSessions).values({ companyId: f.companyId, agentId: f.agentId, taskKey: f.taskKey,
      adapterType: "ccpocket_bridge", sessionParamsJson: { [ADAPTER_SESSION_AUTHORITY]: { schema: "future" } } });
    expect(mergeProtectedSessionParams({ [ADAPTER_SESSION_AUTHORITY]: { schema: "future" } }, {}, f.first.runId)).toBeUndefined();
    const receipt = await claimAdapterSessionAuthority(db, f.first, f.claim);
    expect(receipt.generation).toBe(1);
    expect(await adapterSessionWriteAllowed(db, f.first)).toBe(true);
  });
});
