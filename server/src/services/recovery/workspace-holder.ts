import { and, eq } from "drizzle-orm";
import { agents, heartbeatRuns, issues, projects, type Db } from "@paperclipai/db";
import { conflict, forbidden } from "../../errors.js";
import { mainAgentProjectId } from "../main-agent-workers.js";
import { issueTreeControlService } from "../issue-tree-control.js";
import { adapterExecutionControls } from "../adapter-execution-control.js";
import { sharedCheckoutHolderSettled } from "../heartbeat/shared-checkout.js";
import { record } from "./workspace-creator.js";
import { logActivity } from "../activity-log.js";
import { evaluateAgentInvokabilityFromDb } from "../agent-invokability.js";
import { reconcileRemoteHostRebootHolders, type RemoteHolderActor, type RemoteHostRebootDeps } from "./remote-host-reboot.js";

/** Re-check one terminal holder. This capability never cancels a live run or removes a claim.
 * Without holderRunId (a holderless wait) the Owner may settle remote owners only by a
 * server-observed host boot boundary; see remote-host-reboot.ts. */
export async function reconcileWorkspaceHolder(db: Db, input: {
  companyId: string; issueId: string; waitingRunId: string; holderRunId?: string | null; expectedBindingRevision: number;
  actor: RemoteHolderActor;
}, reverify: (runId: string, companyId: string) => Promise<unknown>, remote: RemoteHostRebootDeps = {}) {
  if (!input.holderRunId) return reconcileRemoteHostRebootHolders(db, input, remote);
  const holderRunId = input.holderRunId;
  async function verify() {
    const [task] = await db.select().from(issues).where(and(eq(issues.id, input.issueId), eq(issues.companyId, input.companyId)));
    if (!task?.projectId || task.workspaceBindingRevision !== input.expectedBindingRevision || ["done", "cancelled"].includes(task.status))
      throw conflict("The waiting task or workspace revision changed");
    const [project] = await db.select().from(projects).where(and(eq(projects.id, task.projectId), eq(projects.companyId, input.companyId)));
    if (input.actor.type === "agent") {
      const [agent] = input.actor.agentId ? await db.select().from(agents).where(and(eq(agents.id, input.actor.agentId), eq(agents.companyId, input.companyId))) : [];
      const [caller] = input.actor.runId ? await db.select().from(heartbeatRuns).where(and(eq(heartbeatRuns.id, input.actor.runId),
        eq(heartbeatRuns.companyId, input.companyId), eq(heartbeatRuns.agentId, input.actor.agentId!), eq(heartbeatRuns.status, "running"))) : [];
      if (!agent || !caller || mainAgentProjectId(agent) !== task.projectId || project?.leadAgentId !== agent.id ||
          agent.pauseReason || agent.lifecycleHolds.length || agent.lifecycleState !== "ready" ||
          !(await evaluateAgentInvokabilityFromDb(db, agent)).invokable)
        throw forbidden("Only the current project main agent may reconcile its workspace holder");
    } else if (input.actor.type !== "board") throw forbidden("Workspace holder reconciliation is unavailable");
    if (project?.pausedAt || await issueTreeControlService(db).getActivePauseHoldGate(input.companyId, task.id))
      throw conflict("The project or task is held");
    const [wait] = await db.select().from(heartbeatRuns).where(and(eq(heartbeatRuns.id, input.waitingRunId), eq(heartbeatRuns.companyId, input.companyId)));
    const busy = record(wait?.resultJson?.workspaceBusy);
    if (!wait || (wait.issueId ?? wait.nativeIssueId ?? wait.contextSnapshot?.issueId) !== task.id ||
        wait.agentId !== task.assigneeAgentId || wait.errorCode !== "workspace_busy" || busy.holderRunId !== holderRunId ||
        record(wait.resultJson?.executionRecovery).providerWorkStarted !== false || busy.projectWorkspaceId !== task.projectWorkspaceId)
      throw conflict("The waiting run does not identify this holder");
    const [holder] = await db.select().from(heartbeatRuns).where(and(eq(heartbeatRuns.id, holderRunId), eq(heartbeatRuns.companyId, input.companyId)));
    const [source] = holder ? await db.select().from(issues).where(and(eq(issues.id, String(holder.issueId ?? holder.nativeIssueId ?? holder.contextSnapshot?.issueId)),
      eq(issues.companyId, input.companyId))) : [];
    if (!holder || !source || source.projectId !== task.projectId || source.id !== busy.holderIssueId ||
        source.projectWorkspaceId !== task.projectWorkspaceId || !record(holder.contextSnapshot?.sharedCheckoutClaim).path)
      throw forbidden("The holder is outside this configured project workspace");
    if (!["succeeded", "failed", "cancelled", "timed_out", "interrupted"].includes(holder.status) || !holder.finishedAt ||
        adapterExecutionControls.has(holder.id) || await issueTreeControlService(db).getActivePauseHoldGate(input.companyId, source.id))
      throw conflict("The holder is active or held; idle is not stop evidence");
    return holder;
  }
  const before = await verify();
  if (!await sharedCheckoutHolderSettled(db, input.companyId, before.id)) await reverify(before.id, input.companyId);
  await verify();
  const settled = await sharedCheckoutHolderSettled(db, input.companyId, before.id);
  await logActivity(db, { companyId: input.companyId, actorType: input.actor.type === "agent" ? "agent" : "user",
    actorId: input.actor.agentId ?? input.actor.userId ?? "board", agentId: input.actor.agentId, runId: input.actor.runId,
    action: "issue.workspace_holder_reconciled", entityType: "issue", entityId: input.issueId,
    details: { holderRunId: before.id, waitingRunId: input.waitingRunId, settled } });
  return { holderRunId: before.id, state: settled ? "settled" as const : "unverified" as const,
    nextAction: settled ? "The original waiting task retains its scheduled admission; workspace checks still apply."
      : "The original stop or resource settlement remains unverified. Owner intervention is required." };
}
