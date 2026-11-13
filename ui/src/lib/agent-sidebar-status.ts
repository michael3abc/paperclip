import type { AttentionItem, AttentionSourceKind, Issue, PmWorkspaceListing } from "@paperclipai/shared";
import type { LiveRunForIssue } from "../api/heartbeats";

/**
 * Sidebar status for a project PM row.
 *
 * - `needs_input`: a request is waiting on the human Owner personally.
 * - `working`: a task of the PM's project (subtasks included) is executing, or
 *   an opted-in agent (`selfRunAgentIds`) is executing its own run.
 * - `waiting_for_task` (Coordinator chat rows only): the agent is not working
 *   itself, but a task its chat created is still live
 *   (see `deriveChatWaitingForTaskAgentIds`).
 *
 * `needs_input` outranks `working`: a person is the bottleneck, so that is the
 * signal worth interrupting the eye for. Both outrank `waiting_for_task`.
 */
export type AgentSidebarStatus = "working" | "needs_input" | "waiting_for_task";

/**
 * Execution phases that mean "work is actually happening now". Queued runs,
 * scheduled retries, recovery and answer/access waits are deliberately absent:
 * none of them is progress, and the last three are not the run's own work.
 */
const WORKING_PHASES: ReadonlySet<string> = new Set([
  "working",
  "waiting_for_provider",
  "reconnecting",
  "finishing",
]);

/**
 * Feed items that ask the Owner for input. The server feed already narrows
 * interactions to those addressed to this person (resolver policy, addressee
 * and delegation), so only the kind needs filtering here. Reviews, failed
 * runs, recoveries, blockers and alerts need attention, not an answer.
 */
const INPUT_REQUEST_KINDS: ReadonlySet<AttentionSourceKind> = new Set([
  "issue_thread_interaction",
  "approval",
  "decision",
]);

type LiveRunLike = Pick<LiveRunForIssue, "agentId" | "status" | "projectId" | "execution">;
type PmWorkspaceLike = Pick<PmWorkspaceListing, "agentId" | "projectId" | "status">;
type AttentionItemLike = Pick<AttentionItem, "sourceKind" | "project"> &
  Partial<Pick<AttentionItem, "shelf" | "archivedAt" | "dismissal" | "snoozedUntil">>;

export function isWorkingLiveRun(run: Pick<LiveRunForIssue, "status" | "execution">): boolean {
  if (run.status !== "running") return false;
  // Older servers and test fixtures may omit the projection; a running run
  // without one is still running.
  const phase = run.execution?.phase;
  if (phase === undefined) return true;
  // The server projects every queued run as phase "queued", and a `heartbeat.run.status`
  // live event only patches `status` of the cached row (live-runs-cache). A run that has
  // just started therefore reads `running` + "queued" until the next refetch. The server
  // never projects "queued" for a genuinely running run, so that pair means "just started".
  return phase === "queued" || WORKING_PHASES.has(phase);
}

export function isOwnerInputRequest(item: AttentionItemLike, now: number): boolean {
  if (!INPUT_REQUEST_KINDS.has(item.sourceKind)) return false;
  if (item.archivedAt || item.shelf) return false;
  if (item.dismissal?.isActive) return false;
  if (item.snoozedUntil) {
    const until = new Date(item.snoozedUntil).getTime();
    if (Number.isFinite(until) && until > now) return false;
  }
  return true;
}

export interface ProjectPmSidebarStatusInput {
  liveRuns: readonly LiveRunLike[] | null | undefined;
  pmWorkspaces: readonly PmWorkspaceLike[] | null | undefined;
  attentionItems: readonly AttentionItemLike[] | null | undefined;
  /**
   * Agents the viewer chose not to see a status on (their stored sidebar
   * preference). Absent or empty means every PM-bound agent shows its status.
   */
  excludedAgentIds?: readonly string[] | null;
  /**
   * Agents that are not project PMs but whose own readable working run marks
   * them `working` (the Coordinator lists project main agents, which do their
   * work in their own runs). Only `run.agentId` counts here: no project
   * attribution and no `needs_input`. PM-bound and excluded agents are ignored.
   */
  selfRunAgentIds?: readonly string[] | null;
  now?: number;
}

/**
 * Zero-slot project PMs run no implementation themselves; their project's work
 * executes on shared workers. So status is attributed by project, through the
 * PM workspace bindings, instead of by `run.agentId`. Agents that are not a
 * project PM, and PMs the viewer excluded in their sidebar preference, never
 * appear in the result, except that an agent listed in `selfRunAgentIds` (and
 * not excluded) is `working` while its own run executes.
 */
export function deriveProjectPmSidebarStatus({
  liveRuns,
  pmWorkspaces,
  attentionItems,
  excludedAgentIds,
  selfRunAgentIds,
  now = Date.now(),
}: ProjectPmSidebarStatusInput): Map<string, AgentSidebarStatus> {
  const result = new Map<string, AgentSidebarStatus>();
  if (!pmWorkspaces?.length && !selfRunAgentIds?.length) return result;
  const excluded = new Set(excludedAgentIds ?? []);

  const pmIdsByProject = new Map<string, Set<string>>();
  const pmIds = new Set<string>();
  // Every bound agent, terminated or excluded included, stays on the PM rules.
  const boundIds = new Set((pmWorkspaces ?? []).map(workspace => workspace.agentId));
  const selfIds = new Set((selfRunAgentIds ?? []).filter(id => !boundIds.has(id) && !excluded.has(id)));
  for (const workspace of pmWorkspaces ?? []) {
    if (workspace.status === "terminated" || !workspace.projectId) continue;
    // An excluded agent never joins either lookup, so none of the run or
    // attention paths below can reach it.
    if (excluded.has(workspace.agentId)) continue;
    pmIds.add(workspace.agentId);
    let ids = pmIdsByProject.get(workspace.projectId);
    if (!ids) {
      ids = new Set();
      pmIdsByProject.set(workspace.projectId, ids);
    }
    ids.add(workspace.agentId);
  }

  for (const run of liveRuns ?? []) {
    if (!isWorkingLiveRun(run)) continue;
    // Work of the project's tasks, wherever it executes, plus the PM's own runs.
    if (pmIds.has(run.agentId) || selfIds.has(run.agentId)) result.set(run.agentId, "working");
    const projectPms = run.projectId ? pmIdsByProject.get(run.projectId) : undefined;
    if (projectPms) for (const agentId of projectPms) result.set(agentId, "working");
  }

  for (const item of attentionItems ?? []) {
    const projectId = item.project?.id;
    if (!projectId || !isOwnerInputRequest(item, now)) continue;
    const projectPms = pmIdsByProject.get(projectId);
    if (projectPms) for (const agentId of projectPms) result.set(agentId, "needs_input");
  }

  return result;
}

/**
 * Agents whose chat row shows `waiting_for_task`: the server says a task the
 * chat created (current session) or a direct subtask has a queued, running or
 * scheduled-retry run (`hasLiveChildTasks`), and the agent has no working run of
 * its own. A working agent keeps its existing `working` indicator instead.
 * Native subagents are not tracked server-side, so they are not part of this.
 */
export function deriveChatWaitingForTaskAgentIds({
  chats,
  liveRuns,
}: {
  chats: readonly Pick<Issue, "conversationAgentId" | "hasLiveChildTasks">[] | null | undefined;
  liveRuns: readonly Pick<LiveRunForIssue, "agentId" | "status" | "execution">[] | null | undefined;
}): Set<string> {
  const working = new Set((liveRuns ?? []).flatMap(run => isWorkingLiveRun(run) ? [run.agentId] : []));
  return new Set((chats ?? []).flatMap(chat =>
    chat.hasLiveChildTasks === true && chat.conversationAgentId && !working.has(chat.conversationAgentId)
      ? [chat.conversationAgentId] : []));
}

/**
 * Presentation classes shared by both sidebar row variants, so the two stay in
 * lockstep. Blue is reserved for `working`, orange for `needs_input` and the
 * violet `--sidebar-waiting-*` tokens for `waiting_for_task`; no other row
 * state (selection, focus, hover) uses these hues.
 */
export interface AgentSidebarStatusStyle {
  /** Inset frame around the whole row. */
  frame: string;
  /** Label text color. */
  text: string;
  /** Status dot fill. */
  dot: string;
  /** Halo behind a pulsing dot; absent when the dot must stay still. */
  pulse?: string;
}

const STATUS_STYLES: Record<AgentSidebarStatus, AgentSidebarStatusStyle> = {
  working: {
    frame: "ring-1 ring-inset ring-blue-600/60 dark:ring-blue-400/60",
    text: "text-blue-600 dark:text-blue-400",
    dot: "bg-blue-600 dark:bg-blue-400",
    pulse: "motion-safe:animate-pulse bg-blue-600 dark:bg-blue-400",
  },
  needs_input: {
    frame: "ring-1 ring-inset ring-orange-500/70 dark:ring-orange-400/70",
    text: "text-orange-600 dark:text-orange-400",
    dot: "bg-orange-500 dark:bg-orange-400",
  },
  // A still dot: the chat itself is idle while its tasks run.
  waiting_for_task: {
    frame: "ring-1 ring-inset ring-(--sidebar-waiting-frame) bg-(--sidebar-waiting-background)",
    text: "text-(--sidebar-waiting-accent)",
    dot: "bg-(--sidebar-waiting-accent)",
  },
};

export function agentSidebarStatusStyle(status: AgentSidebarStatus): AgentSidebarStatusStyle {
  return STATUS_STYLES[status];
}

const STATUS_LABELS: Record<AgentSidebarStatus, string> = {
  working: "working",
  needs_input: "needs input",
  waiting_for_task: "waiting for task",
};

/** Visible label for a status. */
export function agentSidebarStatusLabel(status: AgentSidebarStatus): string {
  return STATUS_LABELS[status];
}

/** Screen-reader phrase appended to the row's accessible name. */
export function agentSidebarStatusAnnouncement(status: AgentSidebarStatus): string {
  return STATUS_LABELS[status];
}
