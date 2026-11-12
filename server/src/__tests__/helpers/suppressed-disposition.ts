import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { agentWakeupRequests, environmentLeases, heartbeatRuns, issues, type Db } from "@paperclipai/db";
import { appendHeartbeatRunEvent } from "../../services/heartbeat-run-events.js";

/** Historical controller trace: preparation completed, final disposition gate
 * skipped dispatch, and accounting released the unused reservation. */
export async function seedSuppressedDisposition(db: Db, run: typeof heartbeatRuns.$inferSelect) {
  const [issue] = run.issueId ? await db.select().from(issues).where(eq(issues.id, run.issueId))
    : await db.insert(issues).values({ companyId: run.companyId, title: "Original repair",
      status: "blocked", assigneeAgentId: run.agentId }).returning();
  const [source] = await db.insert(heartbeatRuns).values({ companyId: run.companyId, agentId: run.agentId,
    issueId: issue.id, contextSnapshot: { issueId: issue.id }, status: "succeeded", finishedAt: new Date() }).returning();
  const episode = { id: source.id, attempt: 1, maxAttempts: 2 };
  const [wake] = await db.insert(agentWakeupRequests).values({ companyId: run.companyId, agentId: run.agentId,
    runId: run.id, source: "automation", reason: "issue_execution_promoted", status: "skipped", error: "durable_wait", finishedAt: new Date(),
    payload: { issueId: issue.id, _paperclipWakeContext: { legacyDispositionEpisode: episode, dispositionRepairSourceRunId: source.id } } }).returning();
  const startedAt = new Date(), controllerBootId = randomUUID();
  const [suppressed] = await db.update(heartbeatRuns).set({ status: "cancelled", runtimeMode: "legacy",
    issueId: issue.id, wakeupRequestId: wake.id, startedAt, finishedAt: new Date(), controllerBootId,
    runtimeModeResolvedAt: startedAt, executionStage: "settled", errorCode: "legacy_disposition_repair_suppressed",
    error: "Disposition repair suppressed: durable_wait", costAccountedAt: new Date(),
    usageJson: { accountingProviderWorkStarted: false }, resultJson: {},
    contextSnapshot: { issueId: issue.id, legacyDispositionEpisode: episode, dispositionRepairSourceRunId: source.id,
      sharedCheckoutClaim: { version: 1, host: "ccpocket:test", path: "/project", issueId: issue.id, acquiredAt: startedAt.toISOString() } },
    runnerProfileJson: { adapterDispatch: { adapterType: "ccpocket_bridge" },
      chatControlRecoveryAdmission: { version: 1, phase: "admitted", companyId: run.companyId,
        runId: run.id, agentId: run.agentId, issueId: issue.id, wakeupRequestId: wake.id } },
  }).where(eq(heartbeatRuns.id, run.id)).returning();
  await appendHeartbeatRunEvent(db, { companyId: run.companyId, agentId: run.agentId, runId: run.id, stream: "system",
    eventType: "legacy.case_handoff_cleanup_intent", payload: { schema: "paperclip.legacy-case-handoff-cleanup-intent.v1",
      controllerBootId, issueId: issue.id, runStartedAt: startedAt.toISOString(), processPid: null, processGroupId: null, processStartedAt: null } });
  const [lease] = await db.insert(environmentLeases).values({ companyId: run.companyId, heartbeatRunId: run.id,
    provider: "local", status: "expired", releasedAt: new Date() }).returning();
  return { run: suppressed, issue, source, wake, lease };
}
