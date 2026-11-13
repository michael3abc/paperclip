import { and, eq, isNull, or } from "drizzle-orm";
import { executionWorkspaces, projects, type Db } from "@paperclipai/db";
import { readMainManagedWorktree, type TaskWorkspaceIntent } from "@paperclipai/shared";
import { conflict, notFound } from "../errors.js";
import { logger } from "../middleware/logger.js";
import { taskWorkspaceSelectableCondition } from "./task-workspace-selection.js";

type ExecutionWorkspaceRow = typeof executionWorkspaces.$inferSelect;
export type CooperativeTaskWorkspace = {
  executionWorkspaceId: string | null; projectWorkspaceId: string | null; executionWorkspacePreference: string | null;
  executionWorkspaceSettings: Record<string, unknown>;
  /** Null when no worktree applies: the run uses the configured source or the project default directory. */
  workspaceSelection: TaskWorkspaceIntent | null;
};

/**
 * Select work once, before assignment. Provider/session admission remains separate.
 *
 * Liveness-first (Owner 2026-11-13, rule 3, workspace = directory): a task is never
 * refused for its workspace. A selected worktree is used whether or not the project
 * main registered it, and while it converges or has a pending main operation. A
 * missing or closed worktree, or none at all, falls back to the caller's configured
 * source when given, else the project default directory (or the agent's own
 * directory for a task outside any project). Each mismatch is logged only.
 */
export async function resolveCooperativeTaskWorkspace(db: Db, input: {
  companyId: string; projectId?: string | null; conversationAgentId?: string | null;
  executionWorkspaceId?: string | null; executionWorkspaceSettings?: Record<string, unknown> | null;
  /** The caller's configured project source; kept when no worktree applies. */
  projectWorkspaceId?: string | null;
}): Promise<CooperativeTaskWorkspace> {
  const settings = input.executionWorkspaceSettings ?? {};
  const warn = (reason: string, message: string, workspaceId?: string | null) => logger.warn({ companyId: input.companyId,
    projectId: input.projectId ?? null, workspaceId: workspaceId ?? null, workspaceValidation: { reason } },
  `Workspace mismatch ignored: ${message}`);
  const sessionOnly = (): CooperativeTaskWorkspace => ({ executionWorkspaceId: null, projectWorkspaceId: null,
    executionWorkspacePreference: null, executionWorkspaceSettings: { ...settings, sessionOnly: true },
    workspaceSelection: { version: 1, selection: { kind: "session_only" }, source: "task_default" } });
  // No execution workspace is bound: the run resolves the configured source or the
  // project default directory and creates it if missing. Settings stay unchanged.
  const directory = (): CooperativeTaskWorkspace => ({ executionWorkspaceId: null, projectWorkspaceId: input.projectWorkspaceId ?? null,
    executionWorkspacePreference: null, executionWorkspaceSettings: settings, workspaceSelection: null });
  const existing = (workspace: ExecutionWorkspaceRow): CooperativeTaskWorkspace => ({ executionWorkspaceId: workspace.id,
    projectWorkspaceId: workspace.projectWorkspaceId, executionWorkspacePreference: "reuse_existing",
    executionWorkspaceSettings: { ...settings, sessionOnly: false, mode: workspace.mode },
    workspaceSelection: { version: 1, source: input.executionWorkspaceId ? "explicit" : "project",
      selection: { kind: "existing", workspaceId: workspace.id } } });
  if (settings.sessionOnly === true) {
    if (input.executionWorkspaceId) throw conflict("session_only_workspace_conflict", { code: "session_only_workspace_conflict" });
    return sessionOnly();
  }
  if ((!input.projectId || input.conversationAgentId) && !input.executionWorkspaceId) {
    return input.projectWorkspaceId ? directory() : sessionOnly();
  }
  if (!input.projectId) {
    // A task outside any project keeps an open directory it already selected (for example
    // its parent's task folder); otherwise it runs in the agent's own directory.
    const [workspace] = await db.select().from(executionWorkspaces).where(and(eq(executionWorkspaces.companyId, input.companyId),
      eq(executionWorkspaces.id, input.executionWorkspaceId!), taskWorkspaceSelectableCondition()));
    if (workspace) return existing(workspace);
    warn("execution_worktree_unavailable", "the selected directory is unavailable; running session-only.", input.executionWorkspaceId);
    return sessionOnly();
  }
  const [project] = await db.select({ policy: projects.executionWorkspacePolicy }).from(projects).where(and(
    eq(projects.companyId, input.companyId), eq(projects.id, input.projectId),
  ));
  if (!project) throw notFound("Project not found");
  if (!input.executionWorkspaceId && project.policy?.executionMode === "session_only") return sessionOnly();
  const workspaceId = input.executionWorkspaceId ?? project.policy?.defaultExecutionWorkspaceId;
  if (typeof workspaceId !== "string" || !workspaceId) {
    if (!input.projectWorkspaceId) warn("execution_worktree_required", "no worktree is selected; using the project default directory.");
    return directory();
  }
  // A project task may keep this project's worktree or a projectless task folder of its
  // company; another project's directory is never adopted.
  const [workspace] = await db.select().from(executionWorkspaces).where(and(
    eq(executionWorkspaces.companyId, input.companyId), eq(executionWorkspaces.id, workspaceId),
    or(eq(executionWorkspaces.projectId, input.projectId), isNull(executionWorkspaces.projectId)),
  ));
  if (!workspace) {
    warn("execution_worktree_unavailable", "the selected worktree is unavailable; using the project directory.", workspaceId);
    return directory();
  }
  if (workspace.closedAt || !["active", "idle"].includes(workspace.status)) {
    warn("workspace_closed", "the selected worktree is closed; using the project directory.", workspace.id);
    return directory();
  }
  const managed = readMainManagedWorktree(workspace.metadata);
  if (!managed) {
    if (workspace.projectId) warn("execution_worktree_registration_required", "the selected worktree is not registered by the project main; using it anyway.", workspace.id);
  } else if (managed.phase !== "open") warn("workspace_converging", "the selected worktree is converging; joining it anyway.", workspace.id);
  if (managed?.pendingOperationId) warn("worktree_operation_reconciliation_required", "the selected worktree has a pending main operation; joining it anyway.", workspace.id);
  return existing(workspace);
}
