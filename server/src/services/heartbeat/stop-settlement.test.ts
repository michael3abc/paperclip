import { createHash, randomUUID } from "node:crypto";
import { hostname } from "node:os";
import { and, eq } from "drizzle-orm";
import { agentInstructionWorkingCopies, agentWakeupRequests, agents, companies, environmentLeases, heartbeatRuns, heartbeatRunEvents, issues, issueRecoveryActions, nativeRunFinalizations,
  createDb, EMBEDDED_POSTGRES_TEST_TIMEOUT_MS } from "@paperclipai/db";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { getEmbeddedPostgresTestSupport, startEmbeddedPostgresTestDatabase } from "../../__tests__/helpers/embedded-postgres.js";
import { createRunStopSettlement, STOP_CHECK_DELAYS } from "./stop-settlement.js";
import { appendHeartbeatRunEvent } from "../heartbeat-run-events.js";
import { sharedCheckoutHolderSettled } from "./shared-checkout.js";
import { createDeliveryWorkCoordinator } from "../delivery-work-coordinator.js";
import { notifyRunStopSettlement } from "../run-stop-settlement-notifications.js";
import { isPreDispatchExecutionWaitVerified } from "../pre-dispatch-execution-wait.js";
import { bridgeSessionStopAcknowledged } from "../explicit-native-continuation.js";
import { getExecutionBlocker } from "../execution-blocker.js";
import { seedSuppressedDisposition } from "../../__tests__/helpers/suppressed-disposition.js";
import { hasCurrentStopVerification } from "./stop-settlement-evidence.js";
import { reconcileWorkspaceWaits, nextWorkspaceWaitLeaseExpiry } from "./workspace-wait-settlement.js";

// Liveness-first rule 2: a terminal run releases every gate at once (receipt
// `settled`, `stopVerified`). Stop evidence and cleanup are collected in the
// background, recorded on the receipt, bounded to four checks, and never
// downgrade the state or ask for Owner intervention.
const support = await getEmbeddedPostgresTestSupport();
describe.skipIf(!support.supported)("durable run stop settlement (terminal releases every gate)", () => {
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

  it("releases at the terminal transition, reconsiders the waiting row once, records cleanup later and stops all scans", async () => {
    const f = await seed();
    await db.insert(agentInstructionWorkingCopies).values({ runId: f.run.id, companyId: f.company.id, agentId: f.agent.id,
      responsibleUserId: "test-owner", entryFile: "AGENTS.md", baseHash: "a".repeat(64), localRoot: "/test", executionRoot: "/test",
      location: "local", state: "unchanged", processStoppedAt: new Date(), receipt: { schema: "paperclip.agent-files.v1", cleanupPending: true } });
    const [waiter] = await db.insert(heartbeatRuns).values({ companyId: f.company.id, agentId: f.agent.id,
      status: "scheduled_retry", scheduledRetryReason: "workspace_busy", scheduledRetryAt: null,
      resultJson: { workspaceBusy: { holderKey: createHash("sha256").update(f.run.id).digest("hex") } } }).returning();
    // The gates read the terminal status directly, before any receipt exists.
    expect(await hasCurrentStopVerification(db, f.company.id, f.run.id)).toBe(true);
    expect(await sharedCheckoutHolderSettled(db, f.company.id, f.run.id)).toBe(true);
    const hook = vi.fn(async () => proof(f.run.id));
    const service = createRunStopSettlement(db, { getAdapter: () => ({ reverifyCancelledRunStop: hook }), isRunActive: () => false });
    const onError = vi.fn((error: unknown) => { console.error(error); });
    const coordinator = createDeliveryWorkCoordinator({ owner: db, canRun: () => true, onError });
    const worker = service.register(coordinator, () => true);
    try {
      await worker.ready;
      // Settled even though cleanup is still pending: cleanup never blocks release.
      await vi.waitFor(async () => expect(await receipt(f.run.id)).toMatchObject({ state: "settled", stopVerified: true,
        cleanup: "instruction_cleanup_pending", evidence: "bridge_stop_receipt" }));
      await vi.waitFor(async () => expect((await read(waiter.id)).scheduledRetryAt).toBeInstanceOf(Date));
      expect((await read(f.run.id)).resultJson?.executionCancellation).toMatchObject({ state: "acknowledged", forced: false });
      await db.transaction(async tx => {
        // Upstream producers pass richer inputs, including a circular DB handle.
        const producer = { companyId: f.company.id, runId: f.run.id, db: tx };
        await notifyRunStopSettlement(tx, producer);
        await tx.update(agentInstructionWorkingCopies).set({ receipt: { schema: "paperclip.agent-files.v1", cleanupPending: false } })
          .where(eq(agentInstructionWorkingCopies.runId, f.run.id));
      });
      await vi.waitFor(async () => {
        expect(await receipt(f.run.id)).toMatchObject({ state: "settled", reason: "cleanup_complete", cleanup: null, nextCheckAt: null });
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

  it.each(["reconsider", "superseded", "resend"] as const)("migrates a historical workspace wait as %s after its actual controller lease expires", async disposition => {
    const f = await seed();
    const [issue] = await db.insert(issues).values({ companyId: f.company.id, title: "Saved pending input", status: "todo",
      assigneeAgentId: f.agent.id }).returning();
    const leaseUntil = new Date(Date.now() + 60_000);
    const [waiter] = await db.insert(heartbeatRuns).values({ companyId: f.company.id, agentId: f.agent.id, issueId: issue.id,
      status: "scheduled_retry", scheduledRetryReason: "workspace_busy", scheduledRetryAt: null,
      controllerLeaseExpiresAt: leaseUntil, nativeSessionId: disposition === "resend" ? randomUUID() : null,
      contextSnapshot: { issueId: issue.id }, resultJson: { executionRecovery: { kind: "workspace_wait", providerWorkStarted: false },
        workspaceBusy: { holderKey: createHash("sha256").update(f.run.id).digest("hex") } } }).returning();
    await db.update(issues).set({ executionRunId: disposition === "superseded" ? f.run.id : waiter.id }).where(eq(issues.id, issue.id));
    await reconcileWorkspaceWaits(db);
    expect((await read(waiter.id)).resultJson).not.toHaveProperty("workspaceWaitMigration");
    expect(await nextWorkspaceWaitLeaseExpiry(db)).toBe(leaseUntil.getTime());
    await db.update(heartbeatRuns).set({ controllerLeaseExpiresAt: new Date(Date.now() - 1) }).where(eq(heartbeatRuns.id, waiter.id));
    await reconcileWorkspaceWaits(db);
    const after = await read(waiter.id);
    expect(after.resultJson).toMatchObject({ workspaceWaitMigration: { disposition } });
    expect(after.scheduledRetryAt instanceof Date).toBe(disposition !== "superseded");
    if (disposition === "superseded") expect(after.status).toBe("cancelled");
    else expect(after.status).toBe("scheduled_retry");
    // No Owner reconciliation is ever requested.
    expect(await db.select().from(issueRecoveryActions).where(eq(issueRecoveryActions.sourceIssueId, issue.id))).toEqual([]);
    await reconcileWorkspaceWaits(db);
    expect(await read(waiter.id)).toEqual(after);
    expect(await nextWorkspaceWaitLeaseExpiry(db)).toBeNull();
    expect((await read(f.run.id)).resultJson).toEqual(f.run.resultJson);
    expect(await db.select().from(heartbeatRunEvents).where(and(eq(heartbeatRunEvents.runId, waiter.id),
      eq(heartbeatRunEvents.eventType, "workspace.wait_migrated")))).toHaveLength(1);
  });

  it.each(["provider_event", "native_input", "bridge_input"] as const)("resends old workspace input with unknown delivery instead of parking it: %s", async retained => {
    const f = await seed();
    const [issue] = await db.insert(issues).values({ companyId: f.company.id, title: "Saved input with conflicting proof",
      status: "todo", assigneeAgentId: f.agent.id }).returning();
    const [waiter] = await db.insert(heartbeatRuns).values({ companyId: f.company.id, agentId: f.agent.id, issueId: issue.id,
      status: "scheduled_retry", scheduledRetryReason: "workspace_busy", scheduledRetryAt: null,
      controllerLeaseExpiresAt: new Date(Date.now() - 1), contextSnapshot: { issueId: issue.id },
      runnerProfileJson: retained === "native_input" ? { nativeExecutionInput: { schema: "retained-input" } } : null,
      resultJson: { executionRecovery: { kind: "workspace_wait", providerWorkStarted: false },
        ...(retained === "bridge_input" ? { bridgeInputReceipt: { schema: "paperclip.bridge-input.v1", acceptedSeq: 1 } } : {}) },
    }).returning();
    await db.update(issues).set({ executionRunId: waiter.id }).where(eq(issues.id, issue.id));
    if (retained === "provider_event") await appendHeartbeatRunEvent(db, { companyId: f.company.id, agentId: f.agent.id,
      runId: waiter.id, eventType: "provider.event", stream: "system", payload: { type: "turn.started" } });
    await reconcileWorkspaceWaits(db);
    const after = await read(waiter.id);
    // Liveness-first rule 1: the unknown earlier delivery is resent through normal dispatch.
    expect(after.scheduledRetryAt).toBeInstanceOf(Date);
    expect(after.status).toBe("scheduled_retry");
    expect(after.errorCode).not.toBe("delivery_unknown");
    expect(after.resultJson).toMatchObject({ workspaceWaitMigration: { disposition: "resend" } });
    expect(await db.select().from(issueRecoveryActions).where(eq(issueRecoveryActions.sourceIssueId, issue.id))).toEqual([]);
    await reconcileWorkspaceWaits(db);
    expect(await read(waiter.id)).toEqual(after);
    expect(await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.issueId, issue.id))).toHaveLength(1);
  });

  it("settles a failed Bridge holder without manufacturing cancellation or losing its failure", async () => {
    const f = await seed();
    const resultJson = { ...f.run.resultJson }; delete resultJson.executionCancellation;
    await db.update(heartbeatRuns).set({ status: "failed", errorCode: "original_adapter_failure", resultJson }).where(eq(heartbeatRuns.id, f.run.id));
    const hook = vi.fn(async () => proof(f.run.id));
    const service = createRunStopSettlement(db, { getAdapter: () => ({ reverifyCancelledRunStop: hook }), isRunActive: () => false });
    await service.reconcile(f.run.id, f.company.id);
    expect(await read(f.run.id)).toMatchObject({ status: "failed", errorCode: "original_adapter_failure",
      resultJson: { originalFailure: "retained", stopSettlement: { state: "settled", evidence: "bridge_terminal_stop_receipt" },
        executionStopVerification: { schema: "paperclip.bridge-terminal-stop.v1" } } });
    expect((await read(f.run.id)).resultJson?.executionCancellation).toBeUndefined();
    expect(await sharedCheckoutHolderSettled(db, f.company.id, f.run.id)).toBe(true);
    await service.reconcile(f.run.id, f.company.id);
    expect(hook).toHaveBeenCalledTimes(1);
  });

  it.each(["no_evidence", "live_lease", "remote_lease", "local_process", "forced", "new_launch"])(
    "releases a terminal Bridge run whatever its stop or resource evidence (%s)", async evidence => {
      const f = await seed();
      await db.update(heartbeatRuns).set({ status: "failed", errorCode: "original_adapter_failure",
        resultJson: { bridgeSessionId: "bridge", nativeSessionId: "native",
          ...(evidence === "forced" ? { executionCancellation: { forced: true, state: "requested" } } : {}) }
      }).where(eq(heartbeatRuns.id, f.run.id));
      if (evidence === "new_launch") await appendHeartbeatRunEvent(db, { companyId: f.company.id, runId: f.run.id, agentId: f.agent.id, eventType: "turn.started" });
      if (["live_lease", "remote_lease"].includes(evidence)) await db.insert(environmentLeases).values({ companyId: f.company.id, heartbeatRunId: f.run.id,
        provider: evidence === "remote_lease" ? "ssh" : "local", releasedAt: evidence === "live_lease" ? null : new Date() });
      if (evidence === "local_process") await db.update(heartbeatRuns).set({ processPid: process.pid }).where(eq(heartbeatRuns.id, f.run.id));
      const hook = vi.fn(async () => ({ verified: false as const, reason: "result_not_recorded" }));
      const service = createRunStopSettlement(db, { getAdapter: () => ({ reverifyCancelledRunStop: hook }), isRunActive: () => false });
      await service.reconcile(f.run.id, f.company.id);
      expect(await receipt(f.run.id)).toMatchObject({ state: "settled", stopVerified: true });
      expect(await read(f.run.id)).toMatchObject({ status: "failed", errorCode: "original_adapter_failure" });
      if (evidence === "forced") expect((await read(f.run.id)).resultJson?.executionCancellation).toMatchObject({ state: "acknowledged", forced: true });
      else expect((await read(f.run.id)).resultJson?.executionCancellation).toBeUndefined();
      expect(await hasCurrentStopVerification(db, f.company.id, f.run.id)).toBe(true);
      expect(await sharedCheckoutHolderSettled(db, f.company.id, f.run.id)).toBe(true);
      // A later launch event or an explicit recheck never reverts the release.
      await appendHeartbeatRunEvent(db, { companyId: f.company.id, runId: f.run.id, agentId: f.agent.id, eventType: "adapter.invoke",
        payload: { adapterType: "ccpocket_bridge", context: { hostId: "remote-e" } } });
      await service.reconcile(f.run.id, f.company.id, { manual: true });
      expect(await receipt(f.run.id)).toMatchObject({ state: "settled", stopVerified: true });
      expect(await hasCurrentStopVerification(db, f.company.id, f.run.id)).toBe(true);
      expect(await sharedCheckoutHolderSettled(db, f.company.id, f.run.id)).toBe(true);
    });

  it.each(["unstarted", "started", "launch", "foreign_parent", "wrong_child", "missing_wake", "instruction_copy"])(
    "verifies the original scheduling trace of a historical cancelled workspace retry as evidence only (%s)", async evidence => {
      const f = await seed();
      const [parent] = await db.insert(heartbeatRuns).values({ companyId: f.company.id, agentId: f.agent.id,
        issueId: f.issue.id, contextSnapshot: { issueId: f.issue.id }, status: "cancelled", errorCode: "workspace_busy", finishedAt: new Date() }).returning();
      const [wake] = await db.insert(agentWakeupRequests).values({ companyId: f.company.id, agentId: f.agent.id,
        source: "automation", status: "cancelled", reason: "workspace_busy_retry", runId: f.run.id,
        payload: { retryOfRunId: parent.id, retryReason: "workspace_busy", scheduledRetryAttempt: 24 } }).returning();
      await db.update(heartbeatRuns).set({ errorCode: "cancelled", retryOfRunId: parent.id, wakeupRequestId: wake.id,
        scheduledRetryReason: "workspace_busy", scheduledRetryAttempt: 24, scheduledRetryAt: new Date(), contextSnapshot: { issueId: f.issue.id },
        resultJson: { startupCancellation: { errorCode: "cancelled" }, executionCancellation: { state: "requested" } } }).where(eq(heartbeatRuns.id, f.run.id));
      await appendHeartbeatRunEvent(db, { companyId: f.company.id, runId: parent.id, agentId: f.agent.id, eventType: "lifecycle", stream: "system",
        payload: { retryRunId: evidence === "wrong_child" ? randomUUID() : f.run.id, retryReason: "workspace_busy", scheduledRetryAttempt: 24 } });
      if (evidence === "started") await db.update(heartbeatRuns).set({ startedAt: new Date() }).where(eq(heartbeatRuns.id, f.run.id));
      if (evidence === "launch") await appendHeartbeatRunEvent(db, { companyId: f.company.id, runId: f.run.id, agentId: f.agent.id, eventType: "adapter.invoke" });
      if (evidence === "foreign_parent") await db.update(heartbeatRuns).set({ contextSnapshot: { issueId: randomUUID() } }).where(eq(heartbeatRuns.id, parent.id));
      if (evidence === "missing_wake") await db.update(heartbeatRuns).set({ wakeupRequestId: null }).where(eq(heartbeatRuns.id, f.run.id));
      if (evidence === "instruction_copy") await db.insert(agentInstructionWorkingCopies).values({ runId: f.run.id, companyId: f.company.id, agentId: f.agent.id,
        responsibleUserId: "test-owner", entryFile: "AGENTS.md", baseHash: "a".repeat(64), localRoot: "/test", executionRoot: "/test", location: "local", state: "unchanged" });
      expect(await isPreDispatchExecutionWaitVerified(db, await read(f.run.id))).toBe(evidence === "unstarted");
      const hook = vi.fn();
      await createRunStopSettlement(db, { getAdapter: () => ({ reverifyCancelledRunStop: hook }), isRunActive: () => false }).reconcile(f.run.id, f.company.id);
      expect(await receipt(f.run.id)).toMatchObject({ state: "settled", stopVerified: true,
        evidence: evidence === "unstarted" ? "verified_pre_dispatch_wait" : null });
      expect(hook).not.toHaveBeenCalled();
      expect(await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.companyId, f.company.id))).toHaveLength(2);
    });

  async function parkedCancellation() {
    const f = await seed();
    await db.update(heartbeatRuns).set({ startedAt: new Date(), controllerBootId: randomUUID(), executionStage: "preparing",
      scheduledRetryReason: "workspace_busy", errorCode: "cancelled", contextSnapshot: { issueId: f.issue.id },
      resultJson: { executionRecovery: { kind: "workspace_wait", providerWorkStarted: false },
        workspaceBusy: { holderKey: "a".repeat(64) }, executionCancellation: { state: "requested" } },
    }).where(eq(heartbeatRuns.id, f.run.id));
    await appendHeartbeatRunEvent(db, { companyId: f.company.id, runId: f.run.id, agentId: f.agent.id,
      eventType: "lifecycle", stream: "system", payload: { workspaceWait: true } });
    await db.insert(issueRecoveryActions).values({ companyId: f.company.id, sourceIssueId: f.issue.id,
      kind: "execution_reconciliation", cause: "legacy_execution_requires_reconciliation", fingerprint: f.run.id,
      nextAction: "Verify the original run", evidence: { runId: f.run.id } });
    return f;
  }

  it.each(["valid", "missing_trace", "provider_event", "provider_identity", "accounting_started",
    "wake_mismatch", "source_mismatch", "live_lease", "remote_lease", "active_controller", "retained_copy"])(
    "releases a suppressed disposition repair at once and records its never-dispatched proof only when complete (%s)", async evidence => {
      const f = await seed();
      const s = await seedSuppressedDisposition(db, f.run);
      const copy = { runId: f.run.id, companyId: f.company.id, agentId: f.agent.id, responsibleUserId: "test-owner",
        entryFile: "AGENTS.md", baseHash: "a".repeat(64), localRoot: "/test", executionRoot: "/test", location: "local",
        state: "unavailable", receipt: { schema: "paperclip.agent-files.v1" } };
      await db.insert(agentInstructionWorkingCopies).values(copy);
      if (evidence === "missing_trace") await db.delete(heartbeatRunEvents).where(eq(heartbeatRunEvents.runId, f.run.id));
      if (evidence === "provider_event") await appendHeartbeatRunEvent(db, { companyId: f.company.id, runId: f.run.id, agentId: f.agent.id, eventType: "adapter.invoke" });
      if (evidence === "provider_identity") await db.update(heartbeatRuns).set({ resultJson: { bridgeSessionId: "accepted" } }).where(eq(heartbeatRuns.id, f.run.id));
      if (evidence === "accounting_started") await db.update(heartbeatRuns).set({ usageJson: { accountingProviderWorkStarted: true } }).where(eq(heartbeatRuns.id, f.run.id));
      if (evidence === "wake_mismatch") await db.update(agentWakeupRequests).set({ error: "other_reason" }).where(eq(agentWakeupRequests.id, s.wake.id));
      if (evidence === "source_mismatch") await db.update(heartbeatRuns).set({ contextSnapshot: { issueId: s.issue.id, legacyDispositionEpisode: { id: randomUUID() } } }).where(eq(heartbeatRuns.id, s.source.id));
      if (evidence === "live_lease") await db.update(environmentLeases).set({ releasedAt: null }).where(eq(environmentLeases.id, s.lease.id));
      if (evidence === "remote_lease") await db.update(environmentLeases).set({ provider: "remote" }).where(eq(environmentLeases.id, s.lease.id));
      if (evidence === "active_controller") await db.update(heartbeatRuns).set({ controllerLeaseExpiresAt: new Date(Date.now() + 60_000) }).where(eq(heartbeatRuns.id, f.run.id));
      if (evidence === "retained_copy") await db.update(agentInstructionWorkingCopies).set({ receipt: { ...copy.receipt, retainedByRunId: randomUUID() } }).where(eq(agentInstructionWorkingCopies.runId, f.run.id));
      const hook = vi.fn();
      const service = createRunStopSettlement(db, { getAdapter: () => ({ reverifyCancelledRunStop: hook }), isRunActive: () => false });
      expect(await isPreDispatchExecutionWaitVerified(db, await read(f.run.id))).toBe(evidence === "valid");
      await service.reconcile(f.run.id, f.company.id);
      expect(await receipt(f.run.id)).toMatchObject({ state: "settled", stopVerified: true });
      expect(await sharedCheckoutHolderSettled(db, f.company.id, f.run.id)).toBe(true);
      if (evidence === "valid") {
        expect(await receipt(f.run.id)).toMatchObject({ evidence: "verified_pre_dispatch_wait", cleanup: "instruction_process_stop_unverified" });
        await db.update(agentInstructionWorkingCopies).set({ state: "unchanged", processStoppedAt: new Date(),
          receipt: { ...copy.receipt, cleanupPending: false } }).where(eq(agentInstructionWorkingCopies.runId, f.run.id));
        await service.reconcile(f.run.id, f.company.id);
        expect(await receipt(f.run.id)).toMatchObject({ state: "settled", reason: "cleanup_complete", evidence: "verified_pre_dispatch_wait" });
        // A later dispatch event changes the evidence, never the release.
        await appendHeartbeatRunEvent(db, { companyId: f.company.id, runId: f.run.id, agentId: f.agent.id, eventType: "adapter.invoke" });
        expect(await hasCurrentStopVerification(db, f.company.id, f.run.id)).toBe(true);
        expect(await sharedCheckoutHolderSettled(db, f.company.id, f.run.id)).toBe(true);
      }
      expect(hook).not.toHaveBeenCalled();
      expect((await read(f.run.id)).errorCode).toBe("legacy_disposition_repair_suppressed");
      expect((await read(f.run.id)).resultJson?.executionCancellation).toBeUndefined();
    });

  it("settles a parked run cancelled before workspace admission without stopping its holder or replaying input", async () => {
    const f = await parkedCancellation();
    const hook = vi.fn();
    const service = createRunStopSettlement(db, { getAdapter: () => ({ reverifyCancelledRunStop: hook }), isRunActive: () => false });
    expect(await isPreDispatchExecutionWaitVerified(db, await read(f.run.id))).toBe(true);
    expect(await getExecutionBlocker(db, f.company.id, f.issue.id)).toBeNull();
    await service.reconcile(f.run.id, f.company.id);
    expect(await receipt(f.run.id)).toMatchObject({ state: "settled", stopVerified: true, evidence: "verified_pre_dispatch_wait" });
    expect((await read(f.run.id)).resultJson?.executionCancellation).toMatchObject({ state: "acknowledged", forced: false, proof: "terminal_status" });
    expect(hook).not.toHaveBeenCalled();
    expect(await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.companyId, f.company.id))).toHaveLength(1);
    // A newer launch changes only the recorded evidence; the terminal run stays released.
    await appendHeartbeatRunEvent(db, { companyId: f.company.id, runId: f.run.id, agentId: f.agent.id,
      eventType: "turn.started", stream: "system", payload: {} });
    await service.reconcile(f.run.id, f.company.id);
    expect(await receipt(f.run.id)).toMatchObject({ state: "settled", stopVerified: true, evidence: null });
    expect(await sharedCheckoutHolderSettled(db, f.company.id, f.run.id)).toBe(true);
  });

  it.each(["missing_trace", "provider_identity", "checkout_claim", "instruction_copy"])("does not treat a cancelled workspace wait with contradictory %s evidence as never dispatched", async conflict => {
    const f = await parkedCancellation();
    if (conflict === "missing_trace") await db.delete(heartbeatRunEvents).where(eq(heartbeatRunEvents.runId, f.run.id));
    if (conflict === "provider_identity") await db.update(heartbeatRuns).set({ resultJson: { ...(await read(f.run.id)).resultJson, bridgeSessionId: "live" } }).where(eq(heartbeatRuns.id, f.run.id));
    if (conflict === "checkout_claim") await db.update(heartbeatRuns).set({ contextSnapshot: { issueId: f.issue.id, sharedCheckoutClaim: { path: "/owned" } } }).where(eq(heartbeatRuns.id, f.run.id));
    if (conflict === "instruction_copy") await db.insert(agentInstructionWorkingCopies).values({ runId: f.run.id, companyId: f.company.id, agentId: f.agent.id,
      responsibleUserId: "test-owner", entryFile: "AGENTS.md", baseHash: "a".repeat(64), localRoot: "/test", executionRoot: "/test", location: "local", state: "unavailable" });
    expect(await isPreDispatchExecutionWaitVerified(db, await read(f.run.id))).toBe(false);
    // Still released for holders and stop gates.
    expect(await hasCurrentStopVerification(db, f.company.id, f.run.id)).toBe(true);
    expect(await sharedCheckoutHolderSettled(db, f.company.id, f.run.id)).toBe(true);
  });

  it("bounds background evidence to four completion-relative checks and never escalates to needs_attention", async () => {
    const f = await seed(); let clock = Date.now();
    const hook = vi.fn(async () => ({ verified: false as const, reason: "bridge_unavailable" }));
    const make = () => createRunStopSettlement(db, { getAdapter: () => ({ reverifyCancelledRunStop: hook }), isRunActive: () => false, now: () => clock });
    for (let n = 1; n <= 4; n++) {
      await make().reconcile(f.run.id, f.company.id);
      expect(await receipt(f.run.id)).toMatchObject({ state: "settled", stopVerified: true, attempts: n, evidence: null });
      const next = (await receipt(f.run.id)).nextCheckAt;
      expect(next).toBe(n === 4 ? null : new Date(clock + STOP_CHECK_DELAYS[n - 1]!).toISOString());
      await make().reconcile(f.run.id, f.company.id);
      expect(hook).toHaveBeenCalledTimes(n);
      if (next) clock = Date.parse(String(next));
    }
    expect(await receipt(f.run.id)).toMatchObject({ state: "settled", stopVerified: true, attempts: 4, nextCheckAt: null });
    expect(await hasCurrentStopVerification(db, f.company.id, f.run.id)).toBe(true);
    clock += 86400_000;
    await make().reconcile(f.run.id, f.company.id);
    expect(hook).toHaveBeenCalledTimes(4);
    await make().reconcile(f.run.id, f.company.id, { manual: true });
    expect(hook).toHaveBeenCalledTimes(5);
    expect(await receipt(f.run.id)).toMatchObject({ state: "settled", nextCheckAt: null });
  });

  it("releases a cancelled Bridge run that never recorded a session at once and records never-delivered proof when it arrives", async () => {
    const f = await seed();
    const [run] = await db.insert(heartbeatRuns).values({ companyId: f.company.id, agentId: f.agent.id, status: "cancelled", runtimeMode: "legacy",
      issueId: f.issue.id, startedAt: new Date(Date.now() - 600_000), finishedAt: new Date(Date.now() - 590_000), errorCode: "operator_interrupted",
      contextSnapshot: { issueId: f.issue.id }, runnerProfileJson: { adapterDispatch: { adapterType: "ccpocket_bridge", adapterConfig: {} } },
      resultJson: { stopReason: "cancelled", cancellation: { source: "queued_message", expected: true } } }).returning();
    let clock = Date.now(); let verified = false;
    const hook = vi.fn(async (input: { runId: string }) => verified ? { verified: true as const, proof: { schema: "ccpocket.bridge-undispatched-stop.v1",
      runId: input.runId, bridgeSessionId: "bridge", nativeSessionId: "native", recordedInputs: 3, lastRecordedRunId: f.run.id,
      checkedAt: new Date().toISOString(), background: { known: true as const, active: [] } } } : { verified: false as const, reason: "history_incomplete" });
    const service = createRunStopSettlement(db, { getAdapter: () => ({ reverifyUndispatchedRunStop: hook }), isRunActive: () => false, now: () => clock });
    await service.reconcile(run.id, f.company.id, { manual: true });
    expect(await receipt(run.id)).toMatchObject({ state: "settled", stopVerified: true, evidence: null });
    expect(await sharedCheckoutHolderSettled(db, f.company.id, run.id)).toBe(true);
    clock += 400_000;
    verified = true;
    await service.reconcile(run.id, f.company.id, { manual: true });
    const settled = await read(run.id);
    expect(await receipt(run.id)).toMatchObject({ state: "settled", stopVerified: true, evidence: "bridge_undispatched_stop_receipt" });
    expect(settled.resultJson?.executionCancellation).toBeUndefined();
    expect(settled.resultJson?.executionStopVerification).toMatchObject({ schema: "paperclip.bridge-undispatched-stop.v1", proof: "bridge_undispatched_reverified" });
    expect(settled).toMatchObject({ status: "cancelled", errorCode: "operator_interrupted" });
    expect(bridgeSessionStopAcknowledged(settled)).toBe(true);
    expect((await db.select().from(issues).where(eq(issues.id, f.issue.id)))[0]?.status).toBe("blocked");
  });

  it("serializes concurrent automatic/manual checks and records a late Bridge stop without task replay", async () => {
    const f = await seed(); let complete!: () => void;
    const gate = new Promise<void>(resolve => { complete = resolve; });
    const hook = vi.fn(async () => { await gate; return proof(f.run.id); });
    const owner = () => createRunStopSettlement(db, { getAdapter: () => ({ reverifyCancelledRunStop: hook }), isRunActive: () => false });
    const first = owner().reconcile(f.run.id, f.company.id);
    await vi.waitFor(() => expect(hook).toHaveBeenCalledTimes(1));
    // Released before the adapter answers.
    expect(await receipt(f.run.id)).toMatchObject({ state: "settled", stopVerified: true });
    expect(await sharedCheckoutHolderSettled(db, f.company.id, f.run.id)).toBe(true);
    await owner().reconcile(f.run.id, f.company.id, { manual: true });
    expect(hook).toHaveBeenCalledTimes(1); complete(); await first;
    expect(await receipt(f.run.id)).toMatchObject({ state: "settled", attempts: 1, evidence: "bridge_stop_receipt" });
    expect(await read(f.run.id)).toMatchObject({ status: "cancelled", resultJson: { originalFailure: "retained",
      executionCancellation: { state: "acknowledged", bridgeStopProof: { runId: f.run.id } } } });
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
    expect(await receipt(f.run.id)).toMatchObject({ state: "settled", stopVerified: true, attempts: 4, nextCheckAt: null });
    expect(await receipt(f.run.id)).not.toHaveProperty("claimToken");
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
    expect(await receipt(f.run.id)).toMatchObject({ state: "settled", stopVerified: true, evidence: "local_process_stop_receipt" });
  });

  it("records remote termination evidence bound to the latest launch without delaying the release", async () => {
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
    expect(await receipt(f.run.id)).toMatchObject({ state: "settled", stopVerified: true, evidence: null });
    await db.update(environmentLeases).set({ metadata: proof(new Date().toISOString()) }).where(eq(environmentLeases.id, leaseId));
    await service.reconcile(f.run.id, f.company.id);
    expect(await receipt(f.run.id)).toMatchObject({ state: "settled", stopVerified: true, evidence: "provider_termination_receipt" });
  });

  it.each(["turn.started", "session.resumed"])("keeps a terminal run released on newer %s evidence", async eventType => {
    const f = await seed(true);
    const service = createRunStopSettlement(db, { getAdapter: () => undefined, isRunActive: () => false });
    const stopped = () => appendHeartbeatRunEvent(db, { companyId: f.company.id, runId: f.run.id, agentId: f.agent.id,
      eventType: "native.local_process_stopped", stream: "system",
      payload: { processPid: 2147483000, processGroupId: 2147483000, processStartedAt: "2026-01-01T00:00:00.000Z" } });
    await stopped();
    await service.reconcile(f.run.id, f.company.id);
    expect(await receipt(f.run.id)).toMatchObject({ state: "settled", stopVerified: true, evidence: "local_process_stop_receipt" });
    await appendHeartbeatRunEvent(db, { companyId: f.company.id, runId: f.run.id, agentId: f.agent.id,
      eventType, stream: "system", payload: {} });
    await service.reconcile(f.run.id, f.company.id);
    expect(await receipt(f.run.id)).toMatchObject({ state: "settled", stopVerified: true, evidence: null });
    expect(await sharedCheckoutHolderSettled(db, f.company.id, f.run.id)).toBe(true);
    await stopped();
    await service.reconcile(f.run.id, f.company.id);
    expect(await receipt(f.run.id)).toMatchObject({ state: "settled", stopVerified: true, evidence: "local_process_stop_receipt" });
  });

  it("retires only a cancelled observed native finalizer after independent process proof, preserving holds and failures", async () => {
    const f = await seed(true);
    await db.insert(nativeRunFinalizations).values({ runId: f.run.id, companyId: f.company.id, issueId: f.issue.id,
      phase: "observed", recoveryState: "resuming_session", failureCode: "original_failure" });
    const service = createRunStopSettlement(db, { getAdapter: () => undefined, isRunActive: () => false });
    await service.reconcile(f.run.id, f.company.id);
    expect(await receipt(f.run.id)).toMatchObject({ state: "settled", stopVerified: true, evidence: null, cleanup: "finalizer_unsettled" });
    expect(await sharedCheckoutHolderSettled(db, f.company.id, f.run.id)).toBe(true);
    const pid = 2147483000;
    await appendHeartbeatRunEvent(db, { companyId: f.company.id, runId: f.run.id, agentId: f.agent.id,
      eventType: "native.local_process_stopped", stream: "system", payload: { processPid: pid, processGroupId: pid, processStartedAt: "2026-01-01T00:00:00.000Z" } });
    await service.reconcile(f.run.id, f.company.id);
    expect(await receipt(f.run.id)).toMatchObject({ state: "settled", stopVerified: true, evidence: "local_process_stop_receipt", cleanup: null });
    expect((await db.select().from(nativeRunFinalizations).where(eq(nativeRunFinalizations.runId, f.run.id)))[0])
      .toMatchObject({ phase: "terminal_failure", recoveryState: "blocked", failureCode: "original_failure" });
    // A new launch changes the recorded evidence only.
    await appendHeartbeatRunEvent(db, { companyId: f.company.id, runId: f.run.id, agentId: f.agent.id,
      eventType: "native.process_start_requested", stream: "system", payload: { hostname: hostname(), targetKind: "local" } });
    await service.reconcile(f.run.id, f.company.id);
    expect(await receipt(f.run.id)).toMatchObject({ state: "settled", stopVerified: true, evidence: null });
    expect(await sharedCheckoutHolderSettled(db, f.company.id, f.run.id)).toBe(true);
    const events = await db.select().from(heartbeatRunEvents).where(and(eq(heartbeatRunEvents.runId, f.run.id), eq(heartbeatRunEvents.eventType, "execution.cancelled_cleanup_settled")));
    expect(events).toHaveLength(1);
  });
});
