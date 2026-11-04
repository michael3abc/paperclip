import { heartbeatRuns, type Db } from "@paperclipai/db";
import type { PaperclipPmWorkspaceContext } from "@paperclipai/shared";
import { eq } from "drizzle-orm";
import {
  PROJECT_PM_OUT_OF_BOUNDS_ERROR_CODE,
  readPaperclipPmWorkspaceContext,
  readProjectPmRunIssueId,
  resolveProjectPmRunWorkspace,
} from "../agent-workspace-binding.js";

type HeartbeatRun = typeof heartbeatRuns.$inferSelect;

/** Lifecycle writes the coordinator lends for the terminal out-of-bounds settlement. */
export type ProjectPmRunSettlement = {
  setRunStatus(runId: string, status: "cancelled", patch: {
    finishedAt: Date;
    error: string;
    errorCode: typeof PROJECT_PM_OUT_OF_BOUNDS_ERROR_CODE;
  }): Promise<unknown>;
  setWakeupStatus(wakeupRequestId: string | null, status: "cancelled", patch: { finishedAt: Date; error: string }): Promise<unknown>;
  getRun(runId: string): Promise<HeartbeatRun | null>;
  appendRunEvent(run: HeartbeatRun, event: {
    eventType: "lifecycle";
    stream: "system";
    level: "warn";
    message: string;
    payload: { errorCode: typeof PROJECT_PM_OUT_OF_BOUNDS_ERROR_CODE; issueId: string | null };
  }): Promise<unknown>;
  releaseIssueExecutionAndPromote(run: HeartbeatRun, options: { suppressImmediateRecovery: true }): Promise<unknown>;
};

/**
 * `admitted` continues the run (`workspace` is null for a non-PM agent).
 * `cancelled` means the run, its wakeup and its issue execution are already
 * settled; the coordinator only finalizes the agent status and stops.
 */
export type ProjectPmRunAdmission =
  | { outcome: "admitted"; workspace: PaperclipPmWorkspaceContext | null }
  | { outcome: "cancelled" };

/**
 * Paperclip is the authority for a project PM run's role and cwd. Keep only
 * the role the queue stored at claim (for the same issue); rebuild the rest
 * from the current binding, and reject issues outside the project.
 *
 * `context` is the coordinator's working snapshot and is updated in place: a
 * supplied PM workspace is always dropped, and an admitted PM workspace is
 * stored and persisted on the run. An out-of-bounds run settles in the order
 * persist status, append event, release. Configuration errors still throw
 * `workspace_validation_failed` from the resolver.
 */
export async function admitProjectPmRun(
  db: Db,
  input: {
    run: Pick<HeartbeatRun, "id" | "wakeupRequestId">;
    agent: { id: string; companyId: string; runtimeConfig: Record<string, unknown> | null | undefined };
    context: Record<string, unknown>;
    claimedByQueue: boolean;
  },
  settlement: ProjectPmRunSettlement,
): Promise<ProjectPmRunAdmission> {
  const { run, context } = input;
  const claimedPmWorkspace = input.claimedByQueue ? readPaperclipPmWorkspaceContext(context.paperclipPmWorkspace) : null;
  delete context.paperclipPmWorkspace;
  const projectPmRun = await resolveProjectPmRunWorkspace(db, {
    agent: input.agent,
    context,
    claimedRole: claimedPmWorkspace && claimedPmWorkspace.issueId === readProjectPmRunIssueId(context)
      ? claimedPmWorkspace.role
      : null,
  });
  if (projectPmRun.outcome === "out_of_bounds") {
    await settlement.setRunStatus(run.id, "cancelled", {
      finishedAt: new Date(),
      error: projectPmRun.message,
      errorCode: PROJECT_PM_OUT_OF_BOUNDS_ERROR_CODE,
    });
    await settlement.setWakeupStatus(run.wakeupRequestId, "cancelled", { finishedAt: new Date(), error: projectPmRun.message });
    const rejectedRun = await settlement.getRun(run.id);
    if (rejectedRun) {
      await settlement.appendRunEvent(rejectedRun, {
        eventType: "lifecycle",
        stream: "system",
        level: "warn",
        message: projectPmRun.message,
        payload: { errorCode: PROJECT_PM_OUT_OF_BOUNDS_ERROR_CODE, issueId: projectPmRun.issueId },
      });
      await settlement.releaseIssueExecutionAndPromote(rejectedRun, { suppressImmediateRecovery: true });
    }
    return { outcome: "cancelled" };
  }
  const workspace = projectPmRun.outcome === "workspace" ? projectPmRun.workspace : null;
  if (workspace) {
    context.paperclipPmWorkspace = workspace;
    await db.update(heartbeatRuns)
      .set({ contextSnapshot: context, updatedAt: new Date() })
      .where(eq(heartbeatRuns.id, run.id));
  }
  return { outcome: "admitted", workspace };
}
