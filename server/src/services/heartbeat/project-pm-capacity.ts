import { and, eq, inArray, sql } from "drizzle-orm";
import { heartbeatRuns, issues, type Db } from "@paperclipai/db";
import type { PaperclipPmWorkspaceContext, ProjectPmRole } from "@paperclipai/shared";
import {
  buildProjectPmRoleContext,
  readPaperclipPmWorkspaceContext,
  readProjectPmRunIssueId,
  resolveProjectPmBinding,
  resolveProjectPmRole,
  type ProjectPmIssueFacts,
  type ProjectPmWorkspaceBinding,
  type ResolvedProjectPmWorkspaceBinding,
} from "../agent-workspace-binding.js";

type RunRow = Pick<typeof heartbeatRuns.$inferSelect, "id" | "contextSnapshot">;

function snapshot(run: RunRow): Record<string, unknown> {
  const value = run.contextSnapshot;
  return value && typeof value === "object" && !Array.isArray(value) ? value : {};
}

/**
 * Per-role run capacity of one `project_pm` agent: at most one running `pm`
 * run and at most `workerSlots` running `worker` runs. Roles of queued runs
 * come from the current issue state at selection time; roles of running runs
 * come from the role stored at claim (falling back to the current issue).
 */
export type ProjectPmRoleCapacity = {
  /** The role of a queued run, or null when the run is out of bounds (executeRun cancels it). */
  roleOf(run: RunRow): ProjectPmRole | null;
  hasRoom(role: ProjectPmRole): boolean;
  take(role: ProjectPmRole): void;
  /** The claim-time PM workspace context, or null when the binding cannot be resolved now. */
  claimContext(run: RunRow, role: ProjectPmRole): Promise<PaperclipPmWorkspaceContext | null>;
  running(): Record<ProjectPmRole, number>;
};

export async function loadProjectPmRoleCapacity(db: Db, input: {
  agent: { id: string; companyId: string };
  binding: ProjectPmWorkspaceBinding;
  queuedRuns: RunRow[];
}): Promise<ProjectPmRoleCapacity> {
  const { agent, binding } = input;
  const runningRuns = await db
    .select({ id: heartbeatRuns.id, contextSnapshot: heartbeatRuns.contextSnapshot })
    .from(heartbeatRuns)
    .where(and(eq(heartbeatRuns.agentId, agent.id), eq(heartbeatRuns.status, "running")));
  const storedRoles = new Map<string, ProjectPmRole>();
  for (const run of runningRuns) {
    const stored = readPaperclipPmWorkspaceContext(snapshot(run).paperclipPmWorkspace);
    if (stored) storedRoles.set(run.id, stored.role);
  }
  const issueIds = [
    ...new Set(
      [...runningRuns.filter((run) => !storedRoles.has(run.id)), ...input.queuedRuns]
        .map((run) => readProjectPmRunIssueId(snapshot(run)))
        .filter((issueId): issueId is string => Boolean(issueId)),
    ),
  ];
  const facts = new Map<string, ProjectPmIssueFacts>();
  if (issueIds.length > 0) {
    const rows = await db
      .select({
        id: issues.id,
        projectId: issues.projectId,
        parentId: issues.parentId,
        assigneeAgentId: issues.assigneeAgentId,
      })
      .from(issues)
      .where(and(eq(issues.companyId, agent.companyId), inArray(issues.id, issueIds)));
    for (const row of rows) facts.set(row.id, row);
  }

  function currentRole(run: RunRow): ProjectPmRole | null {
    const issueId = readProjectPmRunIssueId(snapshot(run));
    if (issueId && !facts.has(issueId)) return null;
    const decision = resolveProjectPmRole({ binding, agentId: agent.id, issue: issueId ? facts.get(issueId)! : null });
    return decision.outcome === "role" ? decision.role : null;
  }

  const running: Record<ProjectPmRole, number> = { pm: 0, worker: 0 };
  for (const run of runningRuns) {
    const role = storedRoles.get(run.id) ?? currentRole(run);
    // An out-of-bounds run is cancelled before its adapter starts; it holds no role.
    if (role) running[role] += 1;
  }
  const limits: Record<ProjectPmRole, number> = { pm: 1, worker: binding.workerSlots };

  let resolved: Promise<ResolvedProjectPmWorkspaceBinding | null> | null = null;
  return {
    roleOf: currentRole,
    hasRoom: (role) => running[role] < limits[role],
    take: (role) => {
      running[role] += 1;
    },
    running: () => ({ ...running }),
    async claimContext(run, role) {
      // Configuration errors surface in executeRun as a setup failure.
      resolved ??= resolveProjectPmBinding(db, {
        companyId: agent.companyId,
        agentId: agent.id,
        binding,
        validateInbox: false,
      }).catch(() => null);
      const binding_ = await resolved;
      if (!binding_) return null;
      const issueId = readProjectPmRunIssueId(snapshot(run));
      // A cross-project worker root that cannot be resolved now is left to executeRun, which reports it.
      return buildProjectPmRoleContext(db, {
        companyId: agent.companyId,
        binding: binding_,
        role,
        issue: issueId ? facts.get(issueId) ?? null : null,
      }).catch(() => null);
    },
  };
}

/**
 * Record the claim-time role on a just-claimed run. A null context removes any
 * stale value so executeRun recomputes the role instead of trusting it.
 */
export async function persistClaimedProjectPmWorkspace(
  db: Db,
  run: typeof heartbeatRuns.$inferSelect,
  workspace: PaperclipPmWorkspaceContext | null,
): Promise<typeof heartbeatRuns.$inferSelect> {
  const contextSnapshot = workspace
    ? sql`coalesce(${heartbeatRuns.contextSnapshot}, '{}'::jsonb) || jsonb_build_object('paperclipPmWorkspace', ${JSON.stringify(workspace)}::jsonb)`
    : sql`coalesce(${heartbeatRuns.contextSnapshot}, '{}'::jsonb) - 'paperclipPmWorkspace'`;
  const [updated] = await db
    .update(heartbeatRuns)
    .set({ contextSnapshot, updatedAt: new Date() })
    .where(and(eq(heartbeatRuns.id, run.id), eq(heartbeatRuns.status, "running")))
    .returning();
  return updated ?? run;
}
