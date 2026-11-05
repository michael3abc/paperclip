import type { CompactIssue } from "@paperclipai/shared";

/** Statuses that can sit above running work: an agent's parent task is usually
 * `blocked` or `todo` while its sub-task is `in_progress`. */
export const OPEN_WORK_STATUSES = "backlog,todo,in_progress,in_review,blocked";

/** A walk this deep means the parent chain is cyclic or corrupt; stop rather than loop. */
const MAX_ANCESTOR_DEPTH = 32;

export type AgentActivityIssue = Pick<CompactIssue, "id" | "parentId" | "status" | "assigneeAgentId">;

/**
 * Agents that currently have work running under them: the assignee of every
 * `in_progress` issue, plus the assignee of each of its ancestors (a PM whose
 * parent task is blocked on a running sub-task still counts as working).
 *
 * `ignoredIssueIds` are never a starting point. Chat conversations stay
 * `in_progress` for as long as they exist, so counting them would make every
 * agent with a chat look busy.
 */
export function agentIdsWithRunningWork(
  issues: readonly AgentActivityIssue[],
  ignoredIssueIds: ReadonlySet<string>,
): Set<string> {
  const byId = new Map(issues.map(issue => [issue.id, issue]));
  const working = new Set<string>();
  for (const start of issues) {
    if (start.status !== "in_progress" || ignoredIssueIds.has(start.id)) continue;
    const visited = new Set<string>();
    let current: AgentActivityIssue | undefined = start;
    for (let depth = 0; current && depth < MAX_ANCESTOR_DEPTH && !visited.has(current.id); depth += 1) {
      visited.add(current.id);
      if (current.assigneeAgentId) working.add(current.assigneeAgentId);
      current = current.parentId ? byId.get(current.parentId) : undefined;
    }
  }
  return working;
}
