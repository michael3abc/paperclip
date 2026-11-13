import { randomUUID } from "node:crypto";
import { hostname } from "node:os";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { agentInstructionWorkingCopies, agents, companies, createDb, environmentLeases, heartbeatRuns, issues,
  nativeRunFinalizations, workspaceOperations, EMBEDDED_POSTGRES_TEST_TIMEOUT_MS } from "@paperclipai/db";
import { getEmbeddedPostgresTestSupport, startEmbeddedPostgresTestDatabase } from "./helpers/embedded-postgres.js";
import { hasCurrentStopVerification } from "../services/heartbeat/stop-settlement-evidence.js";
import { sharedCheckoutHolderSettled, unsettledWorkspaceHolders } from "../services/heartbeat/shared-checkout.js";
import { createRunStopSettlement } from "../services/heartbeat/stop-settlement.js";
import { DELIVERY_QUEUES, subscribeDeliveryWork } from "../services/delivery-work-notifications.js";

// Liveness-first rule 2: a run in a terminal status releases every gate
// immediately. Stop evidence, native-stop verification and cleanup receipts are
// best-effort background records and never hold a workspace, a holder check or
// another run. A live (non-terminal) run is still a holder.
const support = await getEmbeddedPostgresTestSupport();
describe.skipIf(!support.supported)("terminal run releases holders and stop gates", () => {
  let database: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>>;
  let db: ReturnType<typeof createDb>;
  beforeAll(async () => {
    database = await startEmbeddedPostgresTestDatabase("paperclip-terminal-releases-");
    db = createDb(database.connectionString);
  }, EMBEDDED_POSTGRES_TEST_TIMEOUT_MS);
  afterAll(async () => { await db?.$client.end(); await database?.cleanup(); });

  /** A run that left every kind of unresolved stop/cleanup evidence behind. */
  async function seedHolder(status: string, path: string) {
    const [company] = await db.insert(companies).values({ name: "Terminal", issuePrefix: "T" + randomUUID().slice(0, 6) }).returning();
    const [agent] = await db.insert(agents).values({ companyId: company.id, name: "Worker", adapterType: "ccpocket_bridge" }).returning();
    const [issue] = await db.insert(issues).values({ companyId: company.id, title: "Task", status: "in_progress", assigneeAgentId: agent.id }).returning();
    const [run] = await db.insert(heartbeatRuns).values({ companyId: company.id, agentId: agent.id, issueId: issue.id,
      status, runtimeMode: "native", nativeIssueId: issue.id, nativeSessionId: randomUUID(),
      finishedAt: status === "running" ? null : new Date(), processPid: process.pid, processGroupId: process.pid,
      processStartedAt: new Date(), controllerLeaseExpiresAt: new Date(Date.now() + 3_600_000),
      runnerProfileJson: { adapterDispatch: { adapterType: "ccpocket_bridge" } },
      contextSnapshot: { issueId: issue.id, sharedCheckoutClaim: { version: 1, host: hostname(), path, issueId: issue.id,
        acquiredAt: new Date().toISOString(), kind: "directory" } },
      resultJson: { bridgeSessionId: "bridge", nativeSessionId: "native",
        executionCancellation: { state: "requested", forced: true, requestedAt: new Date().toISOString() } },
    }).returning();
    await db.insert(environmentLeases).values({ companyId: company.id, heartbeatRunId: run.id, provider: "ssh",
      status: "pending_cleanup", cleanupStatus: "failed", metadata: { nativeWorkspaceExportResume: true } });
    await db.insert(nativeRunFinalizations).values({ runId: run.id, companyId: company.id, issueId: issue.id,
      phase: "observed", recoveryState: "resuming_session", leaseOwner: "another-controller",
      leaseExpiresAt: new Date(Date.now() + 3_600_000) });
    await db.insert(agentInstructionWorkingCopies).values({ runId: run.id, companyId: company.id, agentId: agent.id,
      responsibleUserId: "owner", entryFile: "AGENTS.md", baseHash: "a".repeat(64), localRoot: path, executionRoot: path,
      location: "local", state: "pending_collection", receipt: { cleanupPending: true } });
    await db.insert(workspaceOperations).values({ companyId: company.id, heartbeatRunId: run.id, phase: "worktree_prepare", status: "running" });
    return { company, agent, issue, run };
  }
  const holderIds = async (path: string) => (await unsettledWorkspaceHolders(db,
    { host: hostname(), path, remote: false })).map(holder => holder.id);

  it.each(["succeeded", "failed", "cancelled", "timed_out", "interrupted"])(
    "a %s run is released at once whatever stop and cleanup evidence remains", async status => {
      const path = `/liveness/${randomUUID()}`;
      const f = await seedHolder(status, path);
      expect(await hasCurrentStopVerification(db, f.company.id, f.run.id)).toBe(true);
      expect(await sharedCheckoutHolderSettled(db, f.company.id, f.run.id)).toBe(true);
      expect(await holderIds(path)).toEqual([]);
      expect(await holderIds(`${path}/child`)).toEqual([]);
      // Releasing is a read decision: no record is rewritten or deleted.
      expect((await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, f.run.id)))[0]).toEqual(f.run);
      expect(await db.select().from(environmentLeases).where(eq(environmentLeases.heartbeatRunId, f.run.id))).toHaveLength(1);
    });

  it("a live run is still a holder of its directory and its parent/child paths", async () => {
    const path = `/liveness/${randomUUID()}`;
    const f = await seedHolder("running", path);
    expect(await hasCurrentStopVerification(db, f.company.id, f.run.id)).toBe(false);
    expect(await sharedCheckoutHolderSettled(db, f.company.id, f.run.id)).toBe(false);
    expect(await holderIds(path)).toEqual([f.run.id]);
    expect(await holderIds(`${path}/child`)).toEqual([f.run.id]);
    expect(await holderIds(`/liveness/${randomUUID()}`)).toEqual([]);
    await db.update(heartbeatRuns).set({ status: "failed", finishedAt: new Date() }).where(eq(heartbeatRuns.id, f.run.id));
    expect(await holderIds(path)).toEqual([]);
  });

  it("stop settlement releases and notifies waiters in its first transaction, before any stop evidence is checked", async () => {
    const f = await seedHolder("cancelled", `/liveness/${randomUUID()}`);
    await db.update(heartbeatRuns).set({ runtimeMode: "legacy", controllerLeaseExpiresAt: null, processPid: null, processGroupId: null,
      resultJson: { ...f.run.resultJson, executionCancellation: { state: "requested", forced: false, requestedAt: new Date().toISOString() } } })
      .where(eq(heartbeatRuns.id, f.run.id));
    const wakes: string[] = [];
    const unsubscribe = [
      subscribeDeliveryWork(db, DELIVERY_QUEUES.deferredExecutionReceipts, () => { wakes.push("deferred"); }),
      subscribeDeliveryWork(db, DELIVERY_QUEUES.workspaceWaitSettlement, () => { wakes.push("workspace"); }),
    ];
    // The adapter never answers: evidence is pending forever, release is not.
    let answer!: (value: { verified: false; reason: string }) => void;
    const hook = vi.fn(() => new Promise<{ verified: false; reason: string }>(resolve => { answer = resolve; }));
    const service = createRunStopSettlement(db, { getAdapter: () => ({ reverifyCancelledRunStop: hook }), isRunActive: () => false });
    try {
      const pending = service.reconcile(f.run.id, f.company.id);
      await vi.waitFor(() => expect(hook).toHaveBeenCalledTimes(1));
      const [released] = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, f.run.id));
      expect(released!.resultJson).toMatchObject({ stopSettlement: { state: "settled", stopVerified: true, reason: "terminal" },
        executionCancellation: { state: "acknowledged", forced: false, proof: "terminal_status" } });
      await vi.waitFor(() => expect(new Set(wakes)).toEqual(new Set(["deferred", "workspace"])));
      answer({ verified: false, reason: "bridge_unavailable" });
      await pending;
      // Missing evidence is recorded and retried in the background; the state never regresses.
      const [after] = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, f.run.id));
      expect(after!.resultJson?.stopSettlement).toMatchObject({ state: "settled", stopVerified: true, evidence: null });
      expect(after!.resultJson?.stopSettlement).not.toHaveProperty("claimToken");
      expect(after!.status).toBe("cancelled");
    } finally { for (const stop of unsubscribe) stop(); }
  });
});
