import { executionWorkspaces, type Db } from "@paperclipai/db";
import { MAIN_MANAGED_WORKTREE_SCHEMA } from "@paperclipai/shared";

/** Saved main-owned registration fixture; no provider or filesystem operation. */
export async function seedManagedDispatchWorkspace(db: Db, input: {
  id: string; companyId: string; projectId: string; sourceId: string; cwd: string; sourceCwd?: string;
  hostId?: string | null; kind?: "repository_root" | "linked_worktree";
}) {
  const { id, companyId, projectId, sourceId, cwd, hostId = null, kind = "linked_worktree" } = input;
  await db.insert(executionWorkspaces).values({ id, companyId, projectId, projectWorkspaceId: sourceId,
    name: "Main-selected Git directory", cwd, mode: "isolated_workspace", strategyType: "git_worktree",
    providerType: hostId ? "remote_managed" : "local_fs", status: "active", branchName: "main",
    metadata: { mainManagedWorktree: { schema: MAIN_MANAGED_WORKTREE_SCHEMA, kind, phase: "open",
      sourceCwd: input.sourceCwd ?? cwd, parentDir: cwd, branch: "main", targetBranch: "main", hostId,
      pendingOperationId: null, participants: {} } },
  });
}
