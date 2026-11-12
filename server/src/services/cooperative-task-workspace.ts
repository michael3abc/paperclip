import { and, eq } from "drizzle-orm";
import { executionWorkspaces, projects, type Db } from "@paperclipai/db";
import { readMainManagedWorktree, type TaskWorkspaceIntent } from "@paperclipai/shared";
import { conflict, notFound } from "../errors.js";

/** Select work once, before assignment. Provider/session admission remains separate. */
export async function resolveCooperativeTaskWorkspace(db: Db, input: {
  companyId: string; projectId?: string | null; conversationAgentId?: string | null;
  executionWorkspaceId?: string | null; executionWorkspaceSettings?: Record<string, unknown> | null;
}) {
  const settings = input.executionWorkspaceSettings ?? {};
  const sessionOnly = () => ({ executionWorkspaceId: null, projectWorkspaceId: null,
    executionWorkspacePreference: null, executionWorkspaceSettings: { ...settings, sessionOnly: true },
    workspaceSelection: { version: 1, selection: { kind: "session_only" }, source: "task_default" } as TaskWorkspaceIntent });
  if (settings.sessionOnly === true) {
    if (input.executionWorkspaceId) throw conflict("session_only_workspace_conflict", { code: "session_only_workspace_conflict" });
    return sessionOnly();
  }
  if ((!input.projectId || input.conversationAgentId) && !input.executionWorkspaceId) return sessionOnly();
  if (!input.projectId) throw conflict("worktree_project_required", { code: "configuration_required" });
  const [project] = await db.select({ policy: projects.executionWorkspacePolicy }).from(projects).where(and(
    eq(projects.companyId, input.companyId), eq(projects.id, input.projectId),
  ));
  if (!project) throw notFound("Project not found");
  if (!input.executionWorkspaceId && project.policy?.executionMode === "session_only") return sessionOnly();
  const workspaceId = input.executionWorkspaceId ?? project.policy?.defaultExecutionWorkspaceId;
  if (typeof workspaceId !== "string" || !workspaceId) throw conflict("Select a linked worktree registered by the project main, or explicitly choose session-only for external-resource work.",
    { code: "configuration_required", reason: "execution_worktree_required" });
  const [workspace] = await db.select().from(executionWorkspaces).where(and(
    eq(executionWorkspaces.companyId, input.companyId), eq(executionWorkspaces.projectId, input.projectId), eq(executionWorkspaces.id, workspaceId),
  ));
  const managed = readMainManagedWorktree(workspace?.metadata);
  if (!workspace || !managed) throw conflict("Register the linked worktree through the project main before assigning execution.",
    { code: "configuration_required", reason: "execution_worktree_registration_required" });
  if (managed.phase !== "open" || workspace.closedAt || !["active", "idle"].includes(workspace.status))
    throw conflict("The selected worktree is closed to new work. Ask its main to reopen or select another tree.", { code: "workspace_converging" });
  if (managed.pendingOperationId) throw conflict("Reconcile the original worktree management operation before joining.",
    { code: "worktree_operation_reconciliation_required" });
  return { executionWorkspaceId: workspace.id, projectWorkspaceId: workspace.projectWorkspaceId,
    executionWorkspacePreference: "reuse_existing", executionWorkspaceSettings: { ...settings, sessionOnly: false, mode: workspace.mode },
    workspaceSelection: { version: 1, source: input.executionWorkspaceId ? "explicit" : "project",
      selection: { kind: "existing", workspaceId: workspace.id } } as TaskWorkspaceIntent };
}
