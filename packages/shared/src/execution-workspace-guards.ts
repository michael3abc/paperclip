import type { ExecutionWorkspace } from "./types/workspace-runtime.js";

/** Server-owned marker. Even an unknown version must fence legacy cleanup. */
export const MAIN_MANAGED_WORKTREE_KEY = "mainManagedWorktree";
export const MAIN_MANAGED_WORKTREE_SCHEMA = "paperclip.main-managed-worktree.v1";

export interface MainManagedWorktree {
  schema: typeof MAIN_MANAGED_WORKTREE_SCHEMA;
  /** Absent only on existing v1 linked-worktree registrations. */
  kind?: "repository_root" | "linked_worktree";
  phase: "open" | "converging" | "merged" | "retired";
  sourceCwd: string;
  parentDir: string;
  branch: string;
  targetBranch: string;
  hostId: string | null;
  pendingOperationId: string | null;
  participants: Record<string, { issueId: string; agentId: string; runId: string | null; joinedAt: string }>;
  lastReceipt?: { operationId: string; head: string | null; targetHead: string | null };
}

/** Unknown markers remain protected but cannot be admitted or mutated. */
export function readMainManagedWorktree(metadata: Record<string, unknown> | null | undefined): MainManagedWorktree | null {
  const raw = metadata?.[MAIN_MANAGED_WORKTREE_KEY];
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const value = raw as MainManagedWorktree;
  if ((value.kind !== undefined && !["repository_root", "linked_worktree"].includes(value.kind))
    || value.schema !== MAIN_MANAGED_WORKTREE_SCHEMA || !["open", "converging", "merged", "retired"].includes(value.phase)
    || ![value.sourceCwd, value.parentDir, value.branch, value.targetBranch].every(item => typeof item === "string" && item.length > 0)
    || !(value.hostId === null || typeof value.hostId === "string")
    || !(value.pendingOperationId === null || typeof value.pendingOperationId === "string")
    || !value.participants || typeof value.participants !== "object" || Array.isArray(value.participants)) return null;
  return value;
}

export function isMainManagedExecutionWorkspace(
  workspace: { metadata?: Record<string, unknown> | null } | null | undefined,
): boolean {
  return Object.prototype.hasOwnProperty.call(workspace?.metadata ?? {}, MAIN_MANAGED_WORKTREE_KEY);
}

type ExecutionWorkspaceGuardTarget = Pick<ExecutionWorkspace, "closedAt" | "mode" | "name" | "status">;

const CLOSED_EXECUTION_WORKSPACE_STATUSES = new Set<ExecutionWorkspace["status"]>(["archived", "cleanup_failed"]);

export function isClosedIsolatedExecutionWorkspace(
  workspace: Pick<ExecutionWorkspaceGuardTarget, "closedAt" | "mode" | "status"> | null | undefined,
): boolean {
  if (!workspace) return false;
  if (workspace.mode !== "isolated_workspace") return false;
  return workspace.closedAt != null || CLOSED_EXECUTION_WORKSPACE_STATUSES.has(workspace.status);
}

export function getClosedIsolatedExecutionWorkspaceMessage(
  workspace: Pick<ExecutionWorkspaceGuardTarget, "name">,
): string {
  return `This issue is linked to the closed workspace "${workspace.name}". Move it to an open workspace before adding comments or resuming work.`;
}
