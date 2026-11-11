import { createHash, randomUUID } from "node:crypto";
import { hostname } from "node:os";
import { and, eq } from "drizzle-orm";
import { agentInstructionWorkingCopies, agents, companies, environmentLeases, heartbeatRuns, heartbeatRunEvents, issues, nativeRunFinalizations,
  createDb, EMBEDDED_POSTGRES_TEST_TIMEOUT_MS } from "@paperclipai/db";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { getEmbeddedPostgresTestSupport, startEmbeddedPostgresTestDatabase } from "../../__tests__/helpers/embedded-postgres.js";
import { createRunStopSettlement, STOP_CHECK_DELAYS } from "./stop-settlement.js";
import { appendHeartbeatRunEvent } from "../heartbeat-run-events.js";
import { sharedCheckoutHolderSettled } from "./shared-checkout.js";
import { createDeliveryWorkCoordinator } from "../delivery-work-coordinator.js";
import { notifyRunStopSettlement } from "../run-stop-settlement-notifications.js";

const support = await getEmbeddedPostgresTestSupport();
describe.skipIf(!support.supported)("durable run stop settlement", () => {
  let database: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>>;
  let db: ReturnType<typeof createDb>;
  beforeAll(async () => { database = await startEmbeddedPostgresTestDatabase("paperclip-stop-settlement-"); db = createDb(database.connectionString); }, EMBEDDED_POSTGRES_TEST_TIMEOUT_MS);
  afterAll(async () => { await db?.$client.end(); await database?.cleanup(); });
  const read = async (id: string) => (await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, id)))[0]!;
  const receipt = async (id: string) => (await read(id)).resultJson?.stopSettlement as Record<string, unknown>;
  async function seed(native = false) {
    const [company] = await db.insert(companies).values({ name: "Settlement", issuePrefix: "S" + randomUUID().slice(0, 6) }).returning();
    const [agent] = await db.insert(agents).values({ companyId: company.id, name: "Main", adapterType: native ? "paperclip_runner" : "ccpocket_bridge" }).returning();
    const [issue] = await db.insert(issues).values({ companyId: company.id, title: "Original task", status: "blocked", assigneeAgentId: agent.id }).returning();
    const [run] = await db.insert(heartbeatRuns).values({ companyId: company.id, agentId: agent.id,
      status: "cancelled", runtimeMode: native ? "native" : "legacy", issueId: issue.id, nativeIssueId: native ? issue.id : null,
      finishedAt: new Date(), nativeSessionId: native ? randomUUID() : null,
      runnerProfileJson: { adapterDispatch: { adapterType: native ? "paperclip_runner" : "ccpocket_bridge", adapterConfig: {} } },
      resultJson: { originalFailure: "retained", bridgeSessionId: native ? undefined : "bridge", nativeSessionId: native ? undefined : "native",
        executionCancellation: { state: "requested", requestedAt: new Date().toISOString(), forced: false } },
    }).returning();
    return { run, company, agent, issue };
  }
  const proof = (runId: string) => ({ verified: true as const, proof: { schema: "ccpocket.bridge-stop-reverification.v1",
    runId, bridgeSessionId: "bridge", nativeSessionId: "native", acceptedSeq: 1, resultSeq: 2,
    checkedAt: new Date().toISOString(), background: { known: true as const, active: [] } } });

  it("automatically waits for cleanup, releases the same waiting row once, and stops all scheduled scans", async () => {
    const f = await seed();
    await db.insert(agentInstructionWorkingCopies).values({ runId: f.run.id, companyId: f.company.id, agentId: f.agent.id,
      responsibleUserId: "test-owner", entryFile: "AGENTS.md", baseHash: "a".repeat(64), localRoot: "/test", executionRoot: "/test",
      location: "local", state: "unchanged", processStoppedAt: new Date(), receipt: { schema: "paperclip.agent-files.v1", cleanupPending: true } });
    const [waiter] = await db.insert(heartbeatRuns).values({ companyId: f.company.id, agentId: f.agent.id,
      status: "scheduled_retry", scheduledRetryReason: "workspace_busy", scheduledRetryAt: null,
      resultJson: { workspaceBusy: { holderKey: createHash("sha256").update(f.run.id).digest("hex") } } }).returning();
    const hook = vi.fn(async () => proof(f.run.id));
    const service = createRunStopSettlement(db, { getAdapter: () => ({ reverifyCancelledRunStop: hook }), isRunActive: () => false });
    const onError = vi.fn((error: unknown) => { console.error(error); });
    const coordinator = createDeliveryWorkCoordinator({ owner: db, canRun: () => true, onError });
    const worker = service.register(coordinator, () => true);
    try {
      await worker.ready;
      await vi.waitFor(async () => expect(await receipt(f.run.id)).toMatchObject({ state: "cleaning", stopVerified: true }));
      expect((await read(waiter.id)).scheduledRetryAt).toBeNull();
      expect(await sharedCheckoutHolderSettled(db, f.company.id, f.run.id)).toBe(false);
      await db.transaction(async tx => {
        await notifyRunStopSettlement(tx, { companyId: f.company.id, runId: f.run.id });
        await tx.update(agentInstructionWorkingCopies).set({ receipt: { schema: "paperclip.agent-files.v1", cleanupPending: false } })
          .where(eq(agentInstructionWorkingCopies.runId, f.run.id));
      });
      await vi.waitFor(async () => {
        expect(await receipt(f.run.id)).toMatchObject({ state: "settled" });
        expect((await read(waiter.id)).scheduledRetryAt).toBeInstanceOf(Date);
        expect(coordinator.nextWakeAt()).toBeNull();
      }, { timeout: 5000 });
      const due = (await read(waiter.id)).scheduledRetryAt;
      for (let n = 0; n < 3; n++) await db.transaction(tx => notifyRunStopSettlement(tx, { companyId: f.company.id, runId: f.run.id }));
      await vi.waitFor(() => expect(coordinator.nextWakeAt()).toBeNull());
      expect((await read(waiter.id)).scheduledRetryAt).toEqual(due);
      expect(hook).toHaveBeenCalledTimes(1);
      expect(await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.companyId, f.company.id))).toHaveLength(2);
      const selects = vi.spyOn(db, "select"), executions = vi.spyOn(db, "execute");
      vi.useFakeTimers();
      await vi.advanceTimersByTimeAsync(600_000);
      expect(selects).not.toHaveBeenCalled(); expect(executions).not.toHaveBeenCalled();
      selects.mockRestore(); executions.mockRestore();
      expect(onError).not.toHaveBeenCalled();
    } finally { vi.useRealTimers(); await worker.stop(); await coordinator.stop(); }
  });

  it("settles a failed Bridge holder without manufacturing cancellation or losing its failure", async () => {
    const f = await seed();
    const resultJson = { ...f.run.resultJson }; delete resultJson.executionCancellation;
    await db.update(heartbeatRuns).set({ status: "failed", errorCode: "original_adapter_failure", resultJson }).where(eq(heartbeatRuns.id, f.run.id));
    const hook = vi.fn(async () => proof(f.run.id));
    const service = createRunStopSettlement(db, { getAdapter: () => ({ reverifyCancelledRunStop: hook }), isRunActive: () => false });
    await service.reconcile(f.run.id, f.company.id);
    expect(await read(f.run.id)).toMatchObject({ status: "failed", errorCode: "original_adapter_failure",
      resultJson: { originalFailure: "retained", stopSettlement: { state: "settled" },
        executionStopVerification: { schema: "paperclip.bridge-terminal-stop.v1" } } });
    expect((await read(f.run.id)).resultJson?.executionCancellation).toBeUndefined();
    expect(await sharedCheckoutHolderSettled(db, f.company.id, f.run.id)).toBe(true);
    await service.reconcile(f.run.id, f.company.id);
    expect(hook).toHaveBeenCalledTimes(1);
  });

  it("persists four checks with completion-relative deadlines across restart, then stays quiet until explicit recheck", async () => {
    const f = await seed(); let clock = Date.now();
    const hook = vi.fn(async () => ({ verified: false as const, reason: "bridge_unavailable" }));
    const make = () => createRunStopSettlement(db, { getAdapter: () => ({ reverifyCancelledRunStop: hook }), isRunActive: () => false, now: () => clock });
    for (let n = 1; n <= 4; n++) {
      await make().reconcile(f.run.id, f.company.id);
      expect((await receipt(f.run.id)).attempts).toBe(n);
      const next = (await receipt(f.run.id)).nextCheckAt;
      expect(next).toBe(n === 4 ? null : new Date(clock + STOP_CHECK_DELAYS[n - 1]!).toISOString());
      await make().reconcile(f.run.id, f.company.id);
      expect(hook).toHaveBeenCalledTimes(n);
      if (next) clock = Date.parse(String(next));
    }
    expect(await receipt(f.run.id)).toMatchObject({ state: "needs_attention", reason: "bridge_unavailable", attempts: 4 });
    clock += 86400_000;
    await make().reconcile(f.run.id, f.company.id);
    expect(hook).toHaveBeenCalledTimes(4);
    await make().reconcile(f.run.id, f.company.id, { manual: true });
    expect(hook).toHaveBeenCalledTimes(5);
    expect((await receipt(f.run.id)).nextCheckAt).toBeNull();
  });

  it("serializes concurrent automatic/manual checks and settles a late Bridge stop without task replay", async () => {
    const f = await seed(); let complete!: () => void;
    const gate = new Promise<void>(resolve => { complete = resolve; });
    const hook = vi.fn(async () => { await gate; return proof(f.run.id); });
    const owner = () => createRunStopSettlement(db, { getAdapter: () => ({ reverifyCancelledRunStop: hook }), isRunActive: () => false });
    const first = owner().reconcile(f.run.id, f.company.id);
    await vi.waitFor(() => expect(hook).toHaveBeenCalledTimes(1));
    await owner().reconcile(f.run.id, f.company.id, { manual: true });
    expect(hook).toHaveBeenCalledTimes(1); complete(); await first;
    expect(await receipt(f.run.id)).toMatchObject({ state: "settled", attempts: 1 });
    expect(await sharedCheckoutHolderSettled(db, f.company.id, f.run.id)).toBe(true);
    expect(await read(f.run.id)).toMatchObject({ status: "cancelled", resultJson: { originalFailure: "retained", executionCancellation: { state: "acknowledged" } } });
    expect((await db.select().from(issues).where(eq(issues.id, f.issue.id)))[0]?.status).toBe("blocked");
    expect(await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.companyId, f.company.id))).toHaveLength(1);
  });

  it("retains the fourth claimed attempt after a crash instead of resetting its budget", async () => {
    const f = await seed();
    const hook = vi.fn(async () => ({ verified: false as const, reason: "bridge_unavailable" }));
    let clock = Date.now(); const service = createRunStopSettlement(db, { getAdapter: () => ({ reverifyCancelledRunStop: hook }), isRunActive: () => false, now: () => clock });
    await service.reconcile(f.run.id, f.company.id);
    const current = await read(f.run.id), old = await receipt(f.run.id);
    await db.update(heartbeatRuns).set({ resultJson: { ...current.resultJson, stopSettlement: {
      ...old, attempts: 4, nextCheckAt: null, claimToken: randomUUID(), claimUntil: new Date(clock + 1000).toISOString(),
    } } }).where(eq(heartbeatRuns.id, f.run.id));
    clock += 1001; await service.reconcile(f.run.id, f.company.id);
    expect(hook).toHaveBeenCalledTimes(1);
    expect(await receipt(f.run.id)).toMatchObject({ state: "needs_attention", attempts: 4, nextCheckAt: null });
  });

  it("reconstructs the latest local launch after its turn starts, using host-bound process evidence", async () => {
    const f = await seed(true);
    const service = createRunStopSettlement(db, { getAdapter: () => undefined, isRunActive: () => false });
    await appendHeartbeatRunEvent(db, { companyId: f.company.id, runId: f.run.id, agentId: f.agent.id,
      eventType: "native.process_identity_recorded", stream: "system", payload: { targetKind: "local", hostname: hostname(),
        processPid: 2147483000, processGroupId: 2147483000, processStartedAt: "2026-01-01T00:00:00.000Z" } });
    await appendHeartbeatRunEvent(db, { companyId: f.company.id, runId: f.run.id, agentId: f.agent.id,
      eventType: "turn.started", stream: "system", payload: {} });
    await service.reconcile(f.run.id, f.company.id);
    expect(await receipt(f.run.id)).toMatchObject({ state: "settled", stopVerified: true });
  });

  it("binds remote termination to the latest launch, accepting only a newer provider receipt", async () => {
    const f = await seed(true);
    const service = createRunStopSettlement(db, { getAdapter: () => undefined, isRunActive: () => false });
    const leaseId = randomUUID();
    const proof = (confirmedAt: string) => ({ remoteExecutionTermination: {
      schema: "paperclip.remote-termination.v1", companyId: f.company.id, runId: f.run.id,
      leaseId, provider: "test-remote", providerLeaseId: "sandbox", state: "stopped", confirmedAt,
    } });
    await db.insert(environmentLeases).values({ id: leaseId, companyId: f.company.id, heartbeatRunId: f.run.id,
      provider: "test-remote", providerLeaseId: "sandbox", status: "released", cleanupStatus: "success",
      releasedAt: new Date(), metadata: proof("2020-01-01T00:00:00.000Z") });
    await appendHeartbeatRunEvent(db, { companyId: f.company.id, runId: f.run.id, agentId: f.agent.id,
      eventType: "turn.started", stream: "system", payload: {} });
    await service.reconcile(f.run.id, f.company.id);
    expect(await receipt(f.run.id)).toMatchObject({ state: "stopping", stopVerified: false });
    await db.update(environmentLeases).set({ metadata: proof(new Date().toISOString()) }).where(eq(environmentLeases.id, leaseId));
    await service.reconcile(f.run.id, f.company.id);
    expect(await receipt(f.run.id)).toMatchObject({ state: "settled", stopVerified: true });
  });

  it.each(["turn.started", "session.resumed"])("invalidates a settled receipt on newer %s evidence", async eventType => {
    const f = await seed(true);
    const service = createRunStopSettlement(db, { getAdapter: () => undefined, isRunActive: () => false });
    const stopped = () => appendHeartbeatRunEvent(db, { companyId: f.company.id, runId: f.run.id, agentId: f.agent.id,
      eventType: "native.local_process_stopped", stream: "system",
      payload: { processPid: 2147483000, processGroupId: 2147483000, processStartedAt: "2026-01-01T00:00:00.000Z" } });
    await stopped();
    await service.reconcile(f.run.id, f.company.id);
    expect(await receipt(f.run.id)).toMatchObject({ state: "settled", stopVerified: true });
    await appendHeartbeatRunEvent(db, { companyId: f.company.id, runId: f.run.id, agentId: f.agent.id,
      eventType, stream: "system", payload: {} });
    await service.reconcile(f.run.id, f.company.id);
    expect(await receipt(f.run.id)).toMatchObject({ state: "stopping", stopVerified: false });
    expect(await sharedCheckoutHolderSettled(db, f.company.id, f.run.id)).toBe(false);
    await stopped();
    await service.reconcile(f.run.id, f.company.id);
    expect(await receipt(f.run.id)).toMatchObject({ state: "settled", stopVerified: true });
  });

  it("retires only a cancelled observed native finalizer after independent process proof, preserving holds and failures", async () => {
    const f = await seed(true);
    await db.insert(nativeRunFinalizations).values({ runId: f.run.id, companyId: f.company.id, issueId: f.issue.id,
      phase: "observed", recoveryState: "resuming_session", failureCode: "original_failure" });
    const service = createRunStopSettlement(db, { getAdapter: () => undefined, isRunActive: () => false });
    await service.reconcile(f.run.id, f.company.id);
    expect(await receipt(f.run.id)).toMatchObject({ state: "stopping", reason: "native_process_stop_unverified" });
    const pid = 2147483000;
    await appendHeartbeatRunEvent(db, { companyId: f.company.id, runId: f.run.id, agentId: f.agent.id,
      eventType: "native.local_process_stopped", stream: "system", payload: { processPid: pid, processGroupId: pid, processStartedAt: "2026-01-01T00:00:00.000Z" } });
    await service.reconcile(f.run.id, f.company.id);
    expect(await receipt(f.run.id)).toMatchObject({ state: "settled", stopVerified: true });
    expect((await db.select().from(nativeRunFinalizations).where(eq(nativeRunFinalizations.runId, f.run.id)))[0])
      .toMatchObject({ phase: "terminal_failure", recoveryState: "blocked", failureCode: "original_failure" });
    expect(await sharedCheckoutHolderSettled(db, f.company.id, f.run.id)).toBe(true);
    // New launch invalidates the old proof even if the mutable PID was cleared.
    await appendHeartbeatRunEvent(db, { companyId: f.company.id, runId: f.run.id, agentId: f.agent.id,
      eventType: "native.process_start_requested", stream: "system", payload: { hostname: hostname(), targetKind: "local" } });
    await service.reconcile(f.run.id, f.company.id);
    expect(await receipt(f.run.id)).toMatchObject({ state: "stopping", reason: "native_process_stop_unverified" });
    expect(await sharedCheckoutHolderSettled(db, f.company.id, f.run.id)).toBe(false);
    const events = await db.select().from(heartbeatRunEvents).where(and(eq(heartbeatRunEvents.runId, f.run.id), eq(heartbeatRunEvents.eventType, "execution.cancelled_cleanup_settled")));
    expect(events).toHaveLength(1);
  });
});
