/**
 * One-time liveness-first reset.
 *
 * Policy: /home/michael/services/docs/agents/liveness-first.md (rules 1, 2, 4, 6).
 * Plan: section 3f "一次性清理".
 *
 * `planLivenessReset` is read-only and returns every row it would change.
 * `applyLivenessReset` recomputes the same plan under row locks and performs
 * every change in ONE transaction, returning before/after per row.
 *
 * What it changes:
 * - Non-terminal runs that no process owns -> `failed` /
 *   `abandoned_liveness_reset` (transient). `running` rows are orphans only
 *   when the caller asserts the server is stopped; otherwise only rows already
 *   flagged by an open reconciliation/watchdog recovery action qualify, and a
 *   flagged `running` row also needs 30 minutes of silence and no live
 *   controller lease. Runs named live by the caller are never touched.
 * - `scheduled_retry` runs whose source failure code is deterministic -> `cancelled`.
 * - Wakeup requests owned by those runs are settled with them.
 * - Open recovery actions superseded by the policy (active-run watchdog,
 *   stranded/Owner hand-offs, workspace selection/binding validation and the
 *   legacy/native reconciliation causes) -> `cancelled`, resolution note
 *   prefixed `superseded_liveness_reset`.
 * - Issues `blocked` only by such an action -> `todo`.
 * - Issue execution/checkout locks that point at a terminal (or missing) run.
 * - System pause holds (default: `system`) are lifted; manual Owner pauses,
 *   setup drafts and company holds are never lifted.
 *
 * What it keeps (policy rule 7 and history):
 * - Recovery actions that protect workspace files (restore failures, sync-out
 *   export failures, snapshots): a fresh model turn cannot restore those files.
 * - Timed provider-quota waits, configuration and workflow recovery actions.
 * - Persisted native finalizations still in progress (the server reconciler owns them).
 * - Run evidence, events, context snapshots and receipts. Nothing is deleted.
 *
 * Workspace holders and shared-checkout claims are released by making the
 * holder run terminal: since liveness-first a terminal run is never a holder
 * (heartbeat/shared-checkout.ts). Claims recorded on terminal runs are left
 * in place as history.
 *
 * Receipts carry ids, statuses, codes, timestamps and hold names only: never a
 * database URL, token, run error text, prompt or evidence payload.
 */
import { randomUUID } from "node:crypto";
import { open, unlink } from "node:fs/promises";
import path from "node:path";
import { and, asc, eq, inArray, isNotNull, notInArray, or, sql } from "drizzle-orm";
import { alias, type PgTable } from "drizzle-orm/pg-core";
import {
  agentWakeupRequests,
  agents,
  createDb,
  heartbeatRuns,
  issueRecoveryActions,
  issueRelations,
  issues,
  type Db,
} from "@paperclipai/db";
import type { AgentLifecycleOperation, AgentLifecycleState } from "@paperclipai/shared";
import { logActivity } from "../activity-log.js";
import { isExplicitContinuationRetryClaim } from "../explicit-continuation-retry-claim.js";
import { nativeManualAdmissionHoldsExecution } from "../native-runtime/native-runner-ownership.js";
import { ABANDONED_LIVENESS_RESET_ERROR_CODE, classifyRunFailure } from "./failure-classification.js";

export const LIVENESS_RESET_SCHEMA = "paperclip.liveness-reset.v1";
export const LIVENESS_RESET_SUPERSEDED_MARKER = "superseded_liveness_reset";
export const LIVENESS_RESET_ACTOR_ID = "liveness_reset";

/** A flagged `running` row is abandoned only after this much silence (policy rule 5). */
export const LIVENESS_RESET_FLAGGED_RUN_SILENCE_MS = 30 * 60_000;

export const LIVENESS_RESET_SUPERSEDED_RECOVERY_KINDS: readonly string[] = [
  "active_run_watchdog",
  "stranded_assigned_issue",
  "workspace_validation",
];
export const LIVENESS_RESET_SUPERSEDED_RECOVERY_CAUSES: readonly string[] = [
  "legacy_execution_requires_reconciliation",
  "native_continuation_requires_reconciliation",
];
/** Kept: these protect workspace files that a resend cannot restore (policy rule 7). */
const WORKSPACE_DATA_RECOVERY_CAUSES: ReadonlySet<string> = new Set([
  "native_workspace_sync_out_unrecoverable",
  "native_workspace_sync_out_retry_exhausted",
  "native_workspace_sync_out_unsafe_archive",
  "native_workspace_finalization_owner_unverified",
  "workspace_finalization_failed",
  "workspace_recovery",
]);
const WORKSPACE_DATA_EVIDENCE_KEYS = ["workspaceRestoreRecovery", "workspaceRestoreFailure", "snapshotId", "workspaceRecovery"];
/** Kept: a timed provider wait already retries on its own schedule. */
const TIMED_WAIT_RECOVERY_CAUSES: ReadonlySet<string> = new Set(["provider_quota"]);

export const LIVENESS_RESET_DEFAULT_LIFT_PAUSE_HOLDS: readonly string[] = ["system"];
/** Owner pauses, setup drafts and company state are never lifted by the reset. */
export const LIVENESS_RESET_NEVER_LIFTED_PAUSE_HOLDS: readonly string[] = [
  "manual",
  "setup",
  "company_paused",
  "company_archived",
];

const TERMINAL_RUN_STATUSES: ReadonlySet<string> = new Set(["succeeded", "interrupted", "failed", "cancelled", "timed_out"]);
const SETTLED_WAKEUP_STATUSES = ["completed", "failed", "cancelled", "skipped", "coalesced"];
const OPEN_RECOVERY_ACTION_STATUSES = ["active", "escalated"];
const CLOSED_ISSUE_STATUSES = ["done", "cancelled"];
const LIFECYCLE_STATES_WITHOUT_LIFT: ReadonlySet<string> = new Set([
  "pending_approval", "terminating", "cleaning_up", "terminated", "rejected",
]);

const ABANDON_ERROR_MESSAGE =
  "Abandoned by the one-time liveness-first reset: no live process owned this run. The task is free for a new run.";
const CANCEL_RETRY_ERROR_MESSAGE =
  "Cancelled by the one-time liveness-first reset: the source failure is deterministic and a retry cannot fix it.";
const RESOLUTION_NOTE =
  `${LIVENESS_RESET_SUPERSEDED_MARKER}: closed by the one-time liveness-first reset; automatic retry replaces this recovery hold.`;

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export interface LivenessResetRunIdentity {
  id: string;
  companyId: string;
  agentId: string;
  status: string;
}

export interface LivenessResetOptions {
  now?: Date;
  /** Operator assertion that no Paperclip server process is running against this database. */
  serverStopped?: boolean;
  /** Runs a live process still owns; never changed. */
  liveRunIds?: Iterable<string>;
  /** Additional live-process predicate; a `true` result keeps the run. */
  isRunLive?: (run: LivenessResetRunIdentity) => boolean;
  /** System pause holds to lift. Defaults to `system`; never-lifted holds are rejected. */
  liftPauseHolds?: readonly string[];
  /** Limit the reset to one company. */
  companyId?: string;
}

type ResolvedOptions = {
  now: Date;
  serverStopped: boolean;
  liveRunIds: ReadonlySet<string>;
  isRunLive?: (run: LivenessResetRunIdentity) => boolean;
  liftPauseHolds: readonly string[];
  companyId: string | null;
};

type RunState = { status: string; errorCode: string | null; finishedAt: string | null };
type WakeupState = { status: string; finishedAt: string | null };
type RecoveryActionState = { status: string; outcome: string | null; resolutionNote: string | null; resolvedAt: string | null };
type IssueStatusState = { status: string };
type IssueLockState = {
  executionRunId: string | null;
  checkoutRunId: string | null;
  executionLockedAt: string | null;
  executionAgentNameKey: string | null;
};
type AgentState = {
  status: string;
  lifecycleState: string;
  lifecycleHolds: string[];
  pauseReason: string | null;
};

export interface LivenessResetRunChange {
  id: string;
  companyId: string;
  agentId: string;
  action: "abandon" | "cancel_deterministic_retry";
  reason: string;
  sourceErrorCode?: string | null;
  before: RunState;
  after: RunState;
}
export interface LivenessResetWakeupChange {
  id: string;
  companyId: string;
  runId: string;
  before: WakeupState;
  after: WakeupState;
}
export interface LivenessResetRecoveryActionChange {
  id: string;
  companyId: string;
  sourceIssueId: string;
  recoveryIssueId: string | null;
  kind: string;
  cause: string;
  ownerType: string;
  evidenceRunId: string | null;
  before: RecoveryActionState;
  after: RecoveryActionState;
}
export interface LivenessResetIssueStatusChange {
  id: string;
  companyId: string;
  identifier: string | null;
  closedRecoveryActionIds: string[];
  before: IssueStatusState;
  after: IssueStatusState;
}
export interface LivenessResetIssueLockChange {
  id: string;
  companyId: string;
  identifier: string | null;
  before: IssueLockState;
  after: IssueLockState;
}
export interface LivenessResetAgentChange {
  id: string;
  companyId: string;
  name: string;
  liftedHolds: string[];
  before: AgentState;
  after: AgentState;
}
export interface LivenessResetKeptRow {
  table: "heartbeat_runs" | "issue_recovery_actions" | "issues" | "agents";
  id: string;
  companyId: string;
  reason: string;
  detail?: Record<string, string | string[] | null>;
}

export interface LivenessResetCounts {
  runsAbandoned: number;
  scheduledRetriesCancelled: number;
  scheduledRetriesKept: number;
  wakeupsSettled: number;
  recoveryActionsClosed: number;
  issuesUnblocked: number;
  issueLocksCleared: number;
  agentPausesLifted: number;
  kept: number;
}

export interface LivenessResetResult {
  schema: typeof LIVENESS_RESET_SCHEMA;
  mode: "dry-run" | "apply";
  generatedAt: string;
  options: {
    serverStopped: boolean;
    liveRunIds: string[];
    liftPauseHolds: string[];
    companyId: string | null;
  };
  counts: LivenessResetCounts;
  changes: {
    runs: LivenessResetRunChange[];
    wakeups: LivenessResetWakeupChange[];
    recoveryActions: LivenessResetRecoveryActionChange[];
    issueStatuses: LivenessResetIssueStatusChange[];
    issueLocks: LivenessResetIssueLockChange[];
    agents: LivenessResetAgentChange[];
  };
  kept: LivenessResetKeptRow[];
}

export class LivenessResetConflict extends Error {
  constructor(message: string) {
    super(message);
    this.name = "LivenessResetConflict";
  }
}

function iso(value: Date | string | null | undefined): string | null {
  if (value === null || value === undefined) return null;
  return value instanceof Date ? value.toISOString() : new Date(value).toISOString();
}

function resolveOptions(options: LivenessResetOptions = {}): ResolvedOptions {
  const liftPauseHolds = [...new Set((options.liftPauseHolds ?? LIVENESS_RESET_DEFAULT_LIFT_PAUSE_HOLDS)
    .map(hold => hold.trim()).filter(Boolean))].sort();
  const forbidden = liftPauseHolds.filter(hold => LIVENESS_RESET_NEVER_LIFTED_PAUSE_HOLDS.includes(hold));
  if (forbidden.length) throw new Error(`The liveness reset never lifts these pause holds: ${forbidden.join(", ")}`);
  const liveRunIds = new Set([...(options.liveRunIds ?? [])]);
  for (const id of [...liveRunIds, ...(options.companyId ? [options.companyId] : [])]) {
    if (!UUID_PATTERN.test(id)) throw new Error(`Invalid UUID: ${id}`);
  }
  return {
    now: options.now ?? new Date(),
    serverStopped: options.serverStopped === true,
    liveRunIds,
    isRunLive: options.isRunLive,
    liftPauseHolds,
    companyId: options.companyId ?? null,
  };
}

function hasWorkspaceDataHold(action: { cause: string; evidence: Record<string, unknown> | null }) {
  if (WORKSPACE_DATA_RECOVERY_CAUSES.has(action.cause)) return true;
  const evidence = action.evidence ?? {};
  return WORKSPACE_DATA_EVIDENCE_KEYS.some(key => evidence[key] !== undefined && evidence[key] !== null);
}

function recoveryActionKeepReason(action: { kind: string; cause: string; evidence: Record<string, unknown> | null }) {
  if (hasWorkspaceDataHold(action)) return "workspace_data_hold";
  if (TIMED_WAIT_RECOVERY_CAUSES.has(action.cause)) return "timed_provider_wait";
  if (LIVENESS_RESET_SUPERSEDED_RECOVERY_KINDS.includes(action.kind)
    || LIVENESS_RESET_SUPERSEDED_RECOVERY_CAUSES.includes(action.cause)) return null;
  return "not_superseded_by_policy";
}

function liftedAgentState(agent: AgentState, liftable: readonly string[]) {
  const holds = agent.lifecycleHolds.filter(hold => !liftable.includes(hold));
  const lifted = agent.lifecycleHolds.filter(hold => liftable.includes(hold));
  // Same transition as the lifecycle module's resume: a fully released paused
  // agent resumes; a pausing agent completes to resuming through its worker.
  const lifecycleState = !holds.length && agent.lifecycleState === "paused" ? "resuming" : agent.lifecycleState;
  return { lifted, after: { ...agent, lifecycleHolds: holds, lifecycleState, pauseReason: holds[0] ?? null } };
}

type LockableQuery<T> = PromiseLike<T> & { for(strength: "update", config?: { of: PgTable }): PromiseLike<T> };

/** Apply locks the rows it plans to change, so the plan cannot move under the writes. */
function lockedRows<T>(query: LockableQuery<T>, lock: boolean, of?: PgTable): PromiseLike<T> {
  return lock ? query.for("update", of ? { of } : undefined) : query;
}

type Collected = Omit<LivenessResetResult, "mode" | "generatedAt" | "counts"> & {
  agentRows: Map<string, typeof agents.$inferSelect>;
  /** Transient or unknown retries are expected and only counted. */
  scheduledRetriesKept: number;
};

async function collect(db: Db, options: ResolvedOptions, lock: boolean): Promise<Collected> {
  const { now, companyId } = options;
  const nowIso = now.toISOString();
  const kept: LivenessResetKeptRow[] = [];

  // 1. Open recovery actions.
  const openActions = await lockedRows(db.select({
    id: issueRecoveryActions.id,
    companyId: issueRecoveryActions.companyId,
    sourceIssueId: issueRecoveryActions.sourceIssueId,
    recoveryIssueId: issueRecoveryActions.recoveryIssueId,
    kind: issueRecoveryActions.kind,
    cause: issueRecoveryActions.cause,
    status: issueRecoveryActions.status,
    outcome: issueRecoveryActions.outcome,
    ownerType: issueRecoveryActions.ownerType,
    evidence: issueRecoveryActions.evidence,
    resolutionNote: issueRecoveryActions.resolutionNote,
    resolvedAt: issueRecoveryActions.resolvedAt,
  }).from(issueRecoveryActions).where(and(
    inArray(issueRecoveryActions.status, OPEN_RECOVERY_ACTION_STATUSES),
    companyId ? eq(issueRecoveryActions.companyId, companyId) : undefined,
  )).orderBy(asc(issueRecoveryActions.createdAt), asc(issueRecoveryActions.id)), lock);

  const recoveryActions: LivenessResetRecoveryActionChange[] = [];
  const keptActionIssueIds = new Set<string>();
  for (const action of openActions) {
    const keepReason = recoveryActionKeepReason(action);
    if (keepReason) {
      keptActionIssueIds.add(action.sourceIssueId);
      kept.push({ table: "issue_recovery_actions", id: action.id, companyId: action.companyId, reason: keepReason,
        detail: { kind: action.kind, cause: action.cause, sourceIssueId: action.sourceIssueId } });
      continue;
    }
    const evidenceRunId = typeof action.evidence?.runId === "string" && UUID_PATTERN.test(action.evidence.runId)
      ? action.evidence.runId : null;
    recoveryActions.push({
      id: action.id, companyId: action.companyId, sourceIssueId: action.sourceIssueId,
      recoveryIssueId: action.recoveryIssueId, kind: action.kind, cause: action.cause, ownerType: action.ownerType,
      evidenceRunId,
      before: { status: action.status, outcome: action.outcome, resolutionNote: action.resolutionNote,
        resolvedAt: iso(action.resolvedAt) },
      after: { status: "cancelled", outcome: "cancelled", resolutionNote: RESOLUTION_NOTE, resolvedAt: nowIso },
    });
  }
  const flaggedRunIds = new Set(recoveryActions.map(action => action.evidenceRunId).filter((id): id is string => Boolean(id)));

  // 2. Non-terminal runs that no process owns. Single-table selects render
  // columns unqualified, so correlated subqueries name the outer row explicitly.
  const silenceCutoff = new Date(now.getTime() - LIVENESS_RESET_FLAGGED_RUN_SILENCE_MS).toISOString();
  const outerRunId = sql.raw(`"heartbeat_runs"."id"`);
  const activeRuns = await lockedRows(db.select({
    id: heartbeatRuns.id,
    companyId: heartbeatRuns.companyId,
    agentId: heartbeatRuns.agentId,
    status: heartbeatRuns.status,
    errorCode: heartbeatRuns.errorCode,
    finishedAt: heartbeatRuns.finishedAt,
    wakeupRequestId: heartbeatRuns.wakeupRequestId,
    controllerLeaseActive: sql<boolean>`coalesce(${heartbeatRuns.controllerLeaseExpiresAt} > ${nowIso}::timestamptz, false)`,
    recentlyActive: sql<boolean>`greatest(
      coalesce(${heartbeatRuns.lastOutputAt}, '-infinity'::timestamptz),
      coalesce(${heartbeatRuns.lastUsefulActionAt}, '-infinity'::timestamptz),
      coalesce(${heartbeatRuns.processStartedAt}, '-infinity'::timestamptz),
      coalesce(${heartbeatRuns.startedAt}, ${heartbeatRuns.createdAt}),
      coalesce((select max(e.created_at) from heartbeat_run_events e where e.run_id = ${outerRunId}), '-infinity'::timestamptz)
    ) > ${silenceCutoff}::timestamptz`,
    nativeFinalizationPending: sql<boolean>`exists (select 1 from native_run_finalizations f
      where f.run_id = ${outerRunId} and (f.lease_owner is not null or f.phase not in ('committed', 'terminal_failure')))`,
  }).from(heartbeatRuns).where(and(
    inArray(heartbeatRuns.status, ["queued", "running"]),
    companyId ? eq(heartbeatRuns.companyId, companyId) : undefined,
  )).orderBy(asc(heartbeatRuns.createdAt), asc(heartbeatRuns.id)), lock, heartbeatRuns);

  const runs: LivenessResetRunChange[] = [];
  const runWakeups = new Map<string, { wakeupRequestId: string; status: "failed" | "cancelled" }>();
  for (const run of activeRuns) {
    const orphanedByStop = run.status === "running" && options.serverStopped;
    const flagged = flaggedRunIds.has(run.id);
    if (!orphanedByStop && !flagged) continue;
    const identity = { id: run.id, companyId: run.companyId, agentId: run.agentId, status: run.status };
    let keepReason: string | null = null;
    if (options.liveRunIds.has(run.id) || options.isRunLive?.(identity)) keepReason = "live_process";
    else if (run.nativeFinalizationPending) keepReason = "native_finalization_pending";
    else if (!orphanedByStop && run.status === "running" && run.controllerLeaseActive) keepReason = "controller_lease_active";
    else if (!orphanedByStop && run.status === "running" && run.recentlyActive) keepReason = "recent_activity";
    if (keepReason) {
      kept.push({ table: "heartbeat_runs", id: run.id, companyId: run.companyId, reason: keepReason,
        detail: { status: run.status } });
      continue;
    }
    runs.push({
      id: run.id, companyId: run.companyId, agentId: run.agentId, action: "abandon",
      reason: orphanedByStop ? "server_stopped_orphan" : "flagged_by_recovery_action",
      before: { status: run.status, errorCode: run.errorCode, finishedAt: iso(run.finishedAt) },
      after: { status: "failed", errorCode: ABANDONED_LIVENESS_RESET_ERROR_CODE, finishedAt: nowIso },
    });
    if (run.wakeupRequestId) runWakeups.set(run.id, { wakeupRequestId: run.wakeupRequestId, status: "failed" });
  }

  // 3. Scheduled retries of deterministic failures.
  const sourceRun = alias(heartbeatRuns, "liveness_reset_source_run");
  const scheduled = await lockedRows(db.select({
    id: heartbeatRuns.id,
    companyId: heartbeatRuns.companyId,
    agentId: heartbeatRuns.agentId,
    status: heartbeatRuns.status,
    errorCode: heartbeatRuns.errorCode,
    finishedAt: heartbeatRuns.finishedAt,
    wakeupRequestId: heartbeatRuns.wakeupRequestId,
    sourceErrorCode: sourceRun.errorCode,
  }).from(heartbeatRuns)
    .leftJoin(sourceRun, eq(sourceRun.id, heartbeatRuns.retryOfRunId))
    .where(and(
      eq(heartbeatRuns.status, "scheduled_retry"),
      companyId ? eq(heartbeatRuns.companyId, companyId) : undefined,
    )).orderBy(asc(heartbeatRuns.createdAt), asc(heartbeatRuns.id)), lock, heartbeatRuns);
  let scheduledRetriesKept = 0;
  for (const retry of scheduled) {
    const code = retry.errorCode ?? retry.sourceErrorCode ?? null;
    const identity = { id: retry.id, companyId: retry.companyId, agentId: retry.agentId, status: retry.status };
    if (classifyRunFailure(code) !== "deterministic" || options.liveRunIds.has(retry.id) || options.isRunLive?.(identity)) {
      scheduledRetriesKept += 1;
      continue;
    }
    runs.push({
      id: retry.id, companyId: retry.companyId, agentId: retry.agentId, action: "cancel_deterministic_retry",
      reason: "deterministic_source_failure", sourceErrorCode: code,
      before: { status: retry.status, errorCode: retry.errorCode, finishedAt: iso(retry.finishedAt) },
      after: { status: "cancelled", errorCode: code, finishedAt: nowIso },
    });
    if (retry.wakeupRequestId) runWakeups.set(retry.id, { wakeupRequestId: retry.wakeupRequestId, status: "cancelled" });
  }
  const changedRunStatus = new Map(runs.map(run => [run.id, run.after.status]));

  // 4. Wakeup requests owned by changed runs.
  const wakeups: LivenessResetWakeupChange[] = [];
  const wakeupIds = [...runWakeups.values()].map(entry => entry.wakeupRequestId);
  if (wakeupIds.length) {
    const rows = await lockedRows(db.select({
      id: agentWakeupRequests.id, companyId: agentWakeupRequests.companyId, status: agentWakeupRequests.status,
      finishedAt: agentWakeupRequests.finishedAt,
    }).from(agentWakeupRequests).where(and(
      inArray(agentWakeupRequests.id, wakeupIds),
      notInArray(agentWakeupRequests.status, SETTLED_WAKEUP_STATUSES),
    )).orderBy(asc(agentWakeupRequests.id)), lock);
    const byId = new Map(rows.map(row => [row.id, row]));
    for (const [runId, entry] of runWakeups) {
      const row = byId.get(entry.wakeupRequestId);
      if (!row) continue;
      wakeups.push({ id: row.id, companyId: row.companyId, runId,
        before: { status: row.status, finishedAt: iso(row.finishedAt) },
        after: { status: entry.status, finishedAt: nowIso } });
    }
  }

  // 5. Issues blocked only by a superseded recovery action.
  const issueStatuses: LivenessResetIssueStatusChange[] = [];
  const closedByIssue = new Map<string, string[]>();
  for (const action of recoveryActions) {
    closedByIssue.set(action.sourceIssueId, [...(closedByIssue.get(action.sourceIssueId) ?? []), action.id]);
  }
  if (closedByIssue.size) {
    const blocked = await lockedRows(db.select({
      id: issues.id, companyId: issues.companyId, identifier: issues.identifier, status: issues.status,
      unblockDescriptor: issues.unblockDescriptor,
    }).from(issues).where(and(
      inArray(issues.id, [...closedByIssue.keys()]),
      eq(issues.status, "blocked"),
    )).orderBy(asc(issues.id)), lock);
    const blockerRows = blocked.length ? await db.select({ blockedIssueId: issueRelations.relatedIssueId })
      .from(issueRelations)
      .innerJoin(issues, and(eq(issues.companyId, issueRelations.companyId), eq(issues.id, issueRelations.issueId)))
      .where(and(
        inArray(issueRelations.relatedIssueId, blocked.map(issue => issue.id)),
        eq(issueRelations.type, "blocks"),
        notInArray(issues.status, CLOSED_ISSUE_STATUSES),
      )) : [];
    const withBlockers = new Set(blockerRows.map(row => row.blockedIssueId));
    for (const issue of blocked) {
      const keepReason = keptActionIssueIds.has(issue.id) ? "other_open_recovery_action"
        : issue.unblockDescriptor ? "explicit_unblock_request"
          : withBlockers.has(issue.id) ? "unresolved_blockers" : null;
      if (keepReason) {
        kept.push({ table: "issues", id: issue.id, companyId: issue.companyId, reason: keepReason,
          detail: { identifier: issue.identifier, status: issue.status } });
        continue;
      }
      issueStatuses.push({ id: issue.id, companyId: issue.companyId, identifier: issue.identifier,
        closedRecoveryActionIds: closedByIssue.get(issue.id) ?? [],
        before: { status: issue.status }, after: { status: "todo" } });
    }
  }

  // 6. Execution and checkout locks that point at a terminal or missing run.
  const executionRun = alias(heartbeatRuns, "liveness_reset_execution_run");
  const checkoutRun = alias(heartbeatRuns, "liveness_reset_checkout_run");
  const locked = await lockedRows(db.select({
    id: issues.id, companyId: issues.companyId, identifier: issues.identifier,
    executionRunId: issues.executionRunId, checkoutRunId: issues.checkoutRunId,
    executionLockedAt: issues.executionLockedAt, executionAgentNameKey: issues.executionAgentNameKey,
    executionRunStatus: executionRun.status, executionRunCompanyId: executionRun.companyId,
    executionRunRuntimeMode: executionRun.runtimeMode, executionRunContext: executionRun.contextSnapshot,
    checkoutRunStatus: checkoutRun.status,
  }).from(issues)
    .leftJoin(executionRun, eq(executionRun.id, issues.executionRunId))
    .leftJoin(checkoutRun, eq(checkoutRun.id, issues.checkoutRunId))
    .where(and(
      or(isNotNull(issues.executionRunId), isNotNull(issues.checkoutRunId)),
      notInArray(issues.status, CLOSED_ISSUE_STATUSES),
      companyId ? eq(issues.companyId, companyId) : undefined,
    )).orderBy(asc(issues.id)), lock, issues);
  const terminalAfterReset = (runId: string, status: string | null) => {
    const next = changedRunStatus.get(runId) ?? status;
    return next === null || TERMINAL_RUN_STATUSES.has(next);
  };
  const issueLocks: LivenessResetIssueLockChange[] = [];
  for (const issue of locked) {
    let executionStale = false;
    if (issue.executionRunId && terminalAfterReset(issue.executionRunId, issue.executionRunStatus)) {
      const run = issue.executionRunStatus === null ? null : {
        id: issue.executionRunId, companyId: issue.executionRunCompanyId ?? issue.companyId,
        runtimeMode: issue.executionRunRuntimeMode ?? "legacy",
        status: changedRunStatus.get(issue.executionRunId) ?? issue.executionRunStatus,
        contextSnapshot: issue.executionRunContext,
      };
      // Same adoption rules as issue checkout: keep an explicit user
      // continuation claim and a native run's manual admission hold.
      executionStale = !isExplicitContinuationRetryClaim(issue, run)
        && !(run?.runtimeMode === "native" && await nativeManualAdmissionHoldsExecution(db,
          { companyId: issue.companyId, runId: issue.executionRunId, issueId: issue.id }));
      if (!executionStale) {
        kept.push({ table: "issues", id: issue.id, companyId: issue.companyId, reason: "execution_claim_retained",
          detail: { identifier: issue.identifier, executionRunId: issue.executionRunId } });
      }
    }
    const checkoutStale = Boolean(issue.checkoutRunId && terminalAfterReset(issue.checkoutRunId, issue.checkoutRunStatus));
    if (!executionStale && !checkoutStale) continue;
    const before: IssueLockState = {
      executionRunId: issue.executionRunId, checkoutRunId: issue.checkoutRunId,
      executionLockedAt: iso(issue.executionLockedAt), executionAgentNameKey: issue.executionAgentNameKey,
    };
    issueLocks.push({ id: issue.id, companyId: issue.companyId, identifier: issue.identifier, before,
      after: {
        ...before,
        ...(executionStale ? { executionRunId: null, executionLockedAt: null, executionAgentNameKey: null } : {}),
        ...(checkoutStale ? { checkoutRunId: null } : {}),
      } });
  }

  // 7. System pause holds.
  const pausedAgents = await lockedRows(db.select().from(agents).where(and(
    or(sql`jsonb_array_length(${agents.lifecycleHolds}) > 0`, isNotNull(agents.pauseReason)),
    companyId ? eq(agents.companyId, companyId) : undefined,
  )).orderBy(asc(agents.id)), lock);
  const agentChanges: LivenessResetAgentChange[] = [];
  const agentRows = new Map<string, typeof agents.$inferSelect>();
  for (const agent of pausedAgents) {
    const before: AgentState = { status: agent.status, lifecycleState: agent.lifecycleState,
      lifecycleHolds: [...agent.lifecycleHolds], pauseReason: agent.pauseReason };
    const { lifted, after } = liftedAgentState(before, options.liftPauseHolds);
    const keepReason = !lifted.length
      ? agent.lifecycleHolds.length ? "non_liftable_hold"
        : agent.pauseReason && options.liftPauseHolds.includes(agent.pauseReason) ? "legacy_pause_without_lifecycle_hold" : null
      : LIFECYCLE_STATES_WITHOUT_LIFT.has(agent.lifecycleState) ? "lifecycle_state" : null;
    if (keepReason) {
      kept.push({ table: "agents", id: agent.id, companyId: agent.companyId, reason: keepReason,
        detail: { lifecycleState: agent.lifecycleState, holds: [...agent.lifecycleHolds] } });
      continue;
    }
    if (!lifted.length) continue;
    agentRows.set(agent.id, agent);
    agentChanges.push({ id: agent.id, companyId: agent.companyId, name: agent.name, liftedHolds: lifted, before, after });
  }

  return {
    schema: LIVENESS_RESET_SCHEMA,
    options: {
      serverStopped: options.serverStopped,
      liveRunIds: [...options.liveRunIds].sort(),
      liftPauseHolds: [...options.liftPauseHolds],
      companyId: options.companyId,
    },
    changes: { runs, wakeups, recoveryActions, issueStatuses, issueLocks, agents: agentChanges },
    kept,
    agentRows,
    scheduledRetriesKept,
  };
}

function finish(collected: Collected, mode: LivenessResetResult["mode"], now: Date): LivenessResetResult {
  const { agentRows: _agentRows, scheduledRetriesKept, ...rest } = collected;
  const { changes } = rest;
  return {
    ...rest,
    mode,
    generatedAt: now.toISOString(),
    counts: {
      runsAbandoned: changes.runs.filter(run => run.action === "abandon").length,
      scheduledRetriesCancelled: changes.runs.filter(run => run.action === "cancel_deterministic_retry").length,
      scheduledRetriesKept,
      wakeupsSettled: changes.wakeups.length,
      recoveryActionsClosed: changes.recoveryActions.length,
      issuesUnblocked: changes.issueStatuses.length,
      issueLocksCleared: changes.issueLocks.length,
      agentPausesLifted: changes.agents.length,
      kept: rest.kept.length,
    },
  };
}

/** Read-only: returns every row the reset would change, with projected after-state. */
export async function planLivenessReset(db: Db, options: LivenessResetOptions = {}): Promise<LivenessResetResult> {
  const resolved = resolveOptions(options);
  return finish(await collect(db, resolved, false), "dry-run", resolved.now);
}

/** Applies the reset in one transaction; any failed write rolls back every change. */
export async function applyLivenessReset(db: Db, options: LivenessResetOptions = {}): Promise<LivenessResetResult> {
  const resolved = resolveOptions(options);
  const { now } = resolved;
  return db.transaction(async (transaction) => {
    const tx = transaction as unknown as Db;
    // Fail fast instead of waiting behind a live server; nothing is written then.
    await tx.execute(sql`select set_config('lock_timeout', '5000', true), set_config('statement_timeout', '300000', true)`);
    const collected = await collect(tx, resolved, true);
    const { changes } = collected;
    const conflict = (what: string, id: string) => {
      throw new LivenessResetConflict(`${what} ${id} changed while the liveness reset held its lock`);
    };

    for (const change of changes.runs) {
      const marker = {
        livenessReset: {
          schema: LIVENESS_RESET_SCHEMA, action: change.action, reason: change.reason,
          previousStatus: change.before.status, sourceErrorCode: change.sourceErrorCode ?? null, at: now.toISOString(),
        },
      };
      const [updated] = await tx.update(heartbeatRuns).set({
        status: change.after.status,
        errorCode: change.after.errorCode,
        error: change.action === "abandon" ? ABANDON_ERROR_MESSAGE : CANCEL_RETRY_ERROR_MESSAGE,
        finishedAt: now,
        updatedAt: now,
        // Publish the terminal status to live views and worker cards.
        executionStatusDeliveryId: randomUUID(),
        resultJson: sql`coalesce(${heartbeatRuns.resultJson}, '{}'::jsonb) || ${JSON.stringify(marker)}::jsonb`,
      }).where(and(eq(heartbeatRuns.id, change.id), eq(heartbeatRuns.status, change.before.status)))
        .returning({ status: heartbeatRuns.status, errorCode: heartbeatRuns.errorCode, finishedAt: heartbeatRuns.finishedAt });
      if (!updated) conflict("Run", change.id);
      change.after = { status: updated.status, errorCode: updated.errorCode, finishedAt: iso(updated.finishedAt) };
    }

    for (const change of changes.wakeups) {
      const [updated] = await tx.update(agentWakeupRequests).set({
        status: change.after.status, finishedAt: now, updatedAt: now,
        error: change.after.status === "failed" ? ABANDON_ERROR_MESSAGE : CANCEL_RETRY_ERROR_MESSAGE,
      }).where(and(eq(agentWakeupRequests.id, change.id), eq(agentWakeupRequests.status, change.before.status)))
        .returning({ status: agentWakeupRequests.status, finishedAt: agentWakeupRequests.finishedAt });
      if (!updated) conflict("Wakeup request", change.id);
      change.after = { status: updated.status, finishedAt: iso(updated.finishedAt) };
    }

    for (const change of changes.recoveryActions) {
      const [updated] = await tx.update(issueRecoveryActions).set({
        status: "cancelled", outcome: "cancelled", resolutionNote: RESOLUTION_NOTE, resolvedAt: now, updatedAt: now,
      }).where(and(eq(issueRecoveryActions.id, change.id), eq(issueRecoveryActions.status, change.before.status)))
        .returning({ status: issueRecoveryActions.status, outcome: issueRecoveryActions.outcome,
          resolutionNote: issueRecoveryActions.resolutionNote, resolvedAt: issueRecoveryActions.resolvedAt });
      if (!updated) conflict("Recovery action", change.id);
      change.after = { status: updated.status, outcome: updated.outcome, resolutionNote: updated.resolutionNote,
        resolvedAt: iso(updated.resolvedAt) };
    }

    for (const change of changes.issueStatuses) {
      const [updated] = await tx.update(issues).set({
        status: "todo", unblockDescriptor: null, blockedTransitionAt: null, blockedOwnerNotifiedAt: null, updatedAt: now,
      }).where(and(eq(issues.id, change.id), eq(issues.status, "blocked")))
        .returning({ status: issues.status });
      if (!updated) conflict("Issue", change.id);
      change.after = { status: updated.status };
      await logActivity(tx, {
        companyId: change.companyId, actorType: "system", actorId: LIVENESS_RESET_ACTOR_ID,
        action: "issue.updated", entityType: "issue", entityId: change.id,
        details: { source: LIVENESS_RESET_ACTOR_ID, status: "todo", previousStatus: "blocked",
          closedRecoveryActionIds: change.closedRecoveryActionIds },
      }, []);
    }

    for (const change of changes.issueLocks) {
      const patch: Partial<typeof issues.$inferInsert> = {};
      if (change.after.executionRunId === null && change.before.executionRunId !== null) {
        Object.assign(patch, { executionRunId: null, executionLockedAt: null, executionAgentNameKey: null });
      }
      if (change.after.checkoutRunId === null && change.before.checkoutRunId !== null) patch.checkoutRunId = null;
      const [updated] = await tx.update(issues).set({ ...patch, updatedAt: now }).where(eq(issues.id, change.id))
        .returning({ executionRunId: issues.executionRunId, checkoutRunId: issues.checkoutRunId,
          executionLockedAt: issues.executionLockedAt, executionAgentNameKey: issues.executionAgentNameKey });
      if (!updated) conflict("Issue", change.id);
      change.after = { executionRunId: updated.executionRunId, checkoutRunId: updated.checkoutRunId,
        executionLockedAt: iso(updated.executionLockedAt), executionAgentNameKey: updated.executionAgentNameKey };
    }

    for (const change of changes.agents) {
      const agent = collected.agentRows.get(change.id)!;
      const stateChanged = change.after.lifecycleState !== agent.lifecycleState;
      const operation: AgentLifecycleOperation | undefined = stateChanged ? {
        responsibleUserId: agent.lifecycleOperation?.responsibleUserId,
        id: randomUUID(), hostComplete: false, completedPluginIds: [], attempts: 0,
        resumeState: agent.lifecycleOperation?.resumeState,
      } : undefined;
      const [updated] = await tx.update(agents).set({
        lifecycleHolds: change.after.lifecycleHolds,
        pauseReason: change.after.pauseReason,
        ...(stateChanged ? {
          lifecycleState: change.after.lifecycleState as AgentLifecycleState,
          lifecycleVersion: agent.lifecycleVersion + 1,
          lifecycleError: null,
          lifecycleOperation: operation,
        } : {}),
        updatedAt: now,
      }).where(and(eq(agents.id, change.id), eq(agents.lifecycleVersion, agent.lifecycleVersion)))
        .returning({ status: agents.status, lifecycleState: agents.lifecycleState,
          lifecycleHolds: agents.lifecycleHolds, pauseReason: agents.pauseReason });
      if (!updated) conflict("Agent", change.id);
      change.after = { status: updated.status, lifecycleState: updated.lifecycleState,
        lifecycleHolds: [...updated.lifecycleHolds], pauseReason: updated.pauseReason };
    }

    return finish(collected, "apply", now);
  });
}

// ---------------------------------------------------------------------------
// Command runner shared by `paperclipai ops liveness-reset` and
// server/scripts/liveness-reset.ts.

export interface LivenessResetCommandInput {
  mode: "dry-run" | "apply";
  receiptPath: string;
  serverStopped?: boolean;
  liveRunIds?: readonly string[];
  liftPauseHolds?: readonly string[];
  companyId?: string;
}

export interface LivenessResetReceipt extends LivenessResetResult {
  /** Label of how the connection was resolved (never the URL itself). */
  connectionSource: string;
}

const COMMAND_USAGE =
  "Usage: liveness-reset (--dry-run | --apply) --receipt <path> [--server-stopped] [--live-run <runId>]... [--lift-hold <hold>]... [--company <companyId>]";

/** Parses script arguments. The receipt is required and exactly one mode is allowed. */
export function parseLivenessResetArgs(argv: readonly string[]): LivenessResetCommandInput {
  const valued = new Set(["--receipt", "--live-run", "--lift-hold", "--company"]);
  const flags = new Set(["--dry-run", "--apply", "--server-stopped"]);
  let dryRun = false;
  let apply = false;
  let serverStopped = false;
  let receiptPath: string | undefined;
  let companyId: string | undefined;
  const liveRunIds: string[] = [];
  const liftPauseHolds: string[] = [];
  for (let index = 0; index < argv.length; index++) {
    const arg = argv[index]!;
    if (flags.has(arg)) {
      if (arg === "--dry-run") dryRun = true;
      else if (arg === "--apply") apply = true;
      else serverStopped = true;
      continue;
    }
    if (!valued.has(arg)) throw new Error(`Unknown liveness reset option: ${arg}\n${COMMAND_USAGE}`);
    const value = argv[++index];
    if (!value || value.startsWith("--")) throw new Error(`Missing value for ${arg}\n${COMMAND_USAGE}`);
    if (arg === "--receipt") receiptPath = value;
    else if (arg === "--company") companyId = value;
    else if (arg === "--live-run") liveRunIds.push(value);
    else liftPauseHolds.push(value);
  }
  return validateLivenessResetCommand({
    dryRun, apply, receiptPath, serverStopped, liveRunIds, companyId,
    liftPauseHolds: liftPauseHolds.length ? liftPauseHolds : undefined,
  });
}

export function validateLivenessResetCommand(input: {
  dryRun?: boolean; apply?: boolean; receiptPath?: string; serverStopped?: boolean;
  liveRunIds?: readonly string[]; liftPauseHolds?: readonly string[]; companyId?: string;
}): LivenessResetCommandInput {
  if (Boolean(input.dryRun) === Boolean(input.apply)) {
    throw new Error(`Choose exactly one of --dry-run or --apply.\n${COMMAND_USAGE}`);
  }
  if (!input.receiptPath?.trim()) throw new Error(`--receipt <path> is required.\n${COMMAND_USAGE}`);
  // Throws on invalid UUIDs and never-lifted holds before anything connects.
  resolveOptions({ liveRunIds: input.liveRunIds, liftPauseHolds: input.liftPauseHolds, companyId: input.companyId });
  return {
    mode: input.apply ? "apply" : "dry-run",
    receiptPath: path.resolve(input.receiptPath.trim()),
    serverStopped: input.serverStopped === true,
    liveRunIds: [...(input.liveRunIds ?? [])],
    ...(input.liftPauseHolds ? { liftPauseHolds: [...input.liftPauseHolds] } : {}),
    ...(input.companyId ? { companyId: input.companyId } : {}),
  };
}

/**
 * Reserves the receipt path exclusively (refusing an existing file), runs the
 * dry run or the single-transaction apply, and writes a secret-free receipt.
 * A failed apply rolls back every change and removes the empty reservation.
 */
export async function runLivenessResetCommand(input: LivenessResetCommandInput & {
  connectionString: string;
  connectionSource: string;
}): Promise<{ receipt: LivenessResetReceipt; receiptPath: string }> {
  const command = validateLivenessResetCommand({
    dryRun: input.mode === "dry-run", apply: input.mode === "apply", receiptPath: input.receiptPath,
    serverStopped: input.serverStopped, liveRunIds: input.liveRunIds, liftPauseHolds: input.liftPauseHolds,
    companyId: input.companyId,
  });
  let handle: Awaited<ReturnType<typeof open>>;
  try {
    handle = await open(command.receiptPath, "wx", 0o600);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "EEXIST") {
      throw new Error(`Receipt already exists: ${command.receiptPath}. Choose a new receipt path.`);
    }
    throw error;
  }
  let written = false;
  try {
    const db = createDb(input.connectionString);
    let result: LivenessResetResult;
    try {
      const options: LivenessResetOptions = {
        serverStopped: command.serverStopped, liveRunIds: command.liveRunIds,
        liftPauseHolds: command.liftPauseHolds, companyId: command.companyId,
      };
      result = command.mode === "apply" ? await applyLivenessReset(db, options) : await planLivenessReset(db, options);
    } finally {
      await db.$client.end({ timeout: 5 });
    }
    const receipt: LivenessResetReceipt = { ...result, connectionSource: input.connectionSource };
    await handle.writeFile(`${JSON.stringify(receipt, null, 2)}\n`, "utf8");
    written = true;
    return { receipt, receiptPath: command.receiptPath };
  } finally {
    await handle.close();
    if (!written) await unlink(command.receiptPath).catch(() => undefined);
  }
}
