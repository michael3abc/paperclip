import path from "node:path";
import { and, eq, sql } from "drizzle-orm";
import { companyMemberships, environmentLeases, heartbeatRuns, issues, projects, projectWorkspaces, type Db } from "@paperclipai/db";
import type { AdapterRemoteHostBootObservation } from "@paperclipai/adapter-utils";
import { conflict, forbidden } from "../../errors.js";
import { issueTreeControlService } from "../issue-tree-control.js";
import { adapterExecutionControls } from "../adapter-execution-control.js";
import {
  REMOTE_HOST_REBOOT_EVENT, REMOTE_HOST_REBOOT_SCHEMA, sharedCheckoutHolderSettled, unsettledWorkspaceHolders,
} from "../heartbeat/shared-checkout.js";
import { appendHeartbeatRunEvent } from "../heartbeat-run-events.js";
import { logActivity } from "../activity-log.js";
import { notifyRunStopSettlement } from "../run-stop-settlement-notifications.js";
import { record } from "./workspace-creator.js";

/** Boot-time slack for the server clock reading around the remote uptime read. */
export const REMOTE_BOOT_CLOCK_MARGIN_MS = 2_000;
const TERMINAL = ["succeeded", "failed", "cancelled", "timed_out", "interrupted"];
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const HOST_ID = /^[A-Za-z0-9._-]{1,128}$/;

export interface RemoteHostRebootDeps {
  /** Read-only boot observation through the registered host catalog (Bridge adapter). */
  observe?: (hostId: string) => Promise<AdapterRemoteHostBootObservation>;
  now?: () => number;
  /** True unless the local pid/process group is definitely absent (ESRCH). */
  processExists?: (id: number, group: boolean) => boolean;
}

export type RemoteHolderReason =
  | "proven" | "holder_not_terminal" | "holder_controlled" | "holder_task_held" | "local_process_present"
  | "unsupported_environment" | "endpoint_mismatch" | "unsupported_execution" | "boot_not_after_finish"
  | "other_settlement_pending";

export interface RemoteHolderActor {
  type: string; agentId?: string | null; runId?: string | null; userId?: string | null;
  isInstanceAdmin?: boolean | null; source?: string | null;
}

function defaultProcessExists(id: number, group: boolean) {
  try { process.kill(group ? -id : id, 0); return true; } catch (error) {
    return (error as NodeJS.ErrnoException).code !== "ESRCH";
  }
}

function validObservation(value: AdapterRemoteHostBootObservation | null | undefined, hostId: string) {
  const endpoint = record(value?.endpoint);
  return value?.schema === "ccpocket.remote-host-boot.v1" && value.hostId === hostId && UUID.test(String(value.bootId))
    && typeof value.uptimeSeconds === "number" && Number.isFinite(value.uptimeSeconds) && value.uptimeSeconds > 0
    && typeof endpoint.host === "string" && endpoint.host.length > 0 && typeof endpoint.username === "string"
    && endpoint.username.length > 0 && Number.isInteger(endpoint.port) && Number(endpoint.port) > 0;
}

/**
 * Holderless workspace waits (busy.holderRunId withheld or absent) on a non-shared
 * remote host. Discovers the unsettled owners through the same admission query and
 * may record one server-observed boot boundary per terminal owner: the remote
 * host's current boot began after the owner finished, so none of its processes can
 * still run. Never cancels, rewrites outcomes, removes claims or wakes work.
 */
export async function reconcileRemoteHostRebootHolders(db: Db, input: {
  companyId: string; issueId: string; waitingRunId: string; expectedBindingRevision: number;
  actor: RemoteHolderActor;
}, deps: RemoteHostRebootDeps) {
  // The real company Owner (or instance admin / local implicit operator) only; checked
  // before any remote observation or mutation. Ordinary members and viewers are refused.
  if (input.actor.type !== "board") throw forbidden("Holderless workspace reconciliation is Owner-only");
  if (!input.actor.isInstanceAdmin && input.actor.source !== "local_implicit") {
    const [membership] = input.actor.userId ? await db.select({ id: companyMemberships.id }).from(companyMemberships).where(and(
      eq(companyMemberships.companyId, input.companyId), eq(companyMemberships.principalType, "user"),
      eq(companyMemberships.principalId, input.actor.userId), eq(companyMemberships.status, "active"),
      eq(companyMemberships.membershipRole, "owner"))) : [];
    if (!membership) throw forbidden("Holderless workspace reconciliation is Owner-only");
  }
  const controls = issueTreeControlService(db);
  async function scope() {
    const [task] = await db.select().from(issues).where(and(eq(issues.id, input.issueId), eq(issues.companyId, input.companyId)));
    if (!task?.projectId || task.workspaceBindingRevision !== input.expectedBindingRevision || ["done", "cancelled"].includes(task.status))
      throw conflict("The waiting task or workspace revision changed");
    const [project] = await db.select().from(projects).where(and(eq(projects.id, task.projectId), eq(projects.companyId, input.companyId)));
    if (project?.pausedAt || await controls.getActivePauseHoldGate(input.companyId, task.id)) throw conflict("The project or task is held");
    const [wait] = await db.select().from(heartbeatRuns).where(and(eq(heartbeatRuns.id, input.waitingRunId), eq(heartbeatRuns.companyId, input.companyId)));
    const busy = record(wait?.resultJson?.workspaceBusy);
    if (!wait || (wait.issueId ?? wait.nativeIssueId ?? wait.contextSnapshot?.issueId) !== task.id ||
        wait.agentId !== task.assigneeAgentId || wait.errorCode !== "workspace_busy" || busy.holderRunId != null ||
        busy.executionWorkspaceId != null || typeof busy.projectWorkspaceId !== "string" ||
        record(wait.resultJson?.executionRecovery).providerWorkStarted !== false)
      throw conflict("The waiting run is not a holderless project-workspace wait for this task");
    const [workspace] = await db.select().from(projectWorkspaces).where(and(eq(projectWorkspaces.id, busy.projectWorkspaceId),
      eq(projectWorkspaces.companyId, input.companyId), eq(projectWorkspaces.projectId, task.projectId)));
    const hostId = record(workspace?.metadata).hostId;
    const cwd = workspace?.cwd;
    if (!workspace || workspace.sourceType !== "remote_managed" || typeof hostId !== "string" || !HOST_ID.test(hostId) ||
        typeof cwd !== "string" || !cwd.startsWith("/") || path.posix.normalize(cwd).replace(/(.)\/$/, "$1") !== cwd)
      throw conflict("Boot-boundary settlement is limited to a canonical remote-managed project workspace");
    const holders = await unsettledWorkspaceHolders(db, { host: `ccpocket:${hostId}`, path: cwd, remote: true });
    return { task, workspace, hostId, cwd, holders };
  }

  const before = await scope();
  const results: { runId: string; issueId: string | null; state: "settled" | "unverified"; reason: RemoteHolderReason }[] = [];
  let undisclosedHolders = 0;
  let observation: { hostId: string; bootId: string; bootStartedAtLowerBound: string } | null = null;
  if (before.holders.length) {
    const observe = deps.observe;
    if (!observe) throw conflict("The registered host catalog cannot observe remote boot state");
    const now = deps.now ?? Date.now;
    const sentAt = now();
    const observed = await observe(before.hostId);
    const receivedAt = now();
    if (!validObservation(observed, before.hostId)) throw conflict("The remote boot observation is invalid");
    const lowerBound = sentAt - observed.uptimeSeconds * 1000 - REMOTE_BOOT_CLOCK_MARGIN_MS;
    observation = { hostId: before.hostId, bootId: observed.bootId, bootStartedAtLowerBound: new Date(lowerBound).toISOString() };
    const after = await scope();
    if (after.hostId !== before.hostId || after.cwd !== before.cwd) throw conflict("The busy workspace changed during observation");
    const processExists = deps.processExists ?? defaultProcessExists;
    for (const owner of after.holders) {
      if (owner.company_id !== input.companyId) { undisclosedHolders += 1; continue; }
      const [holder] = await db.select().from(heartbeatRuns).where(and(eq(heartbeatRuns.id, owner.id), eq(heartbeatRuns.companyId, input.companyId)));
      const issueId = owner.issue_id ?? null;
      let reason: RemoteHolderReason = "proven";
      const leases = holder ? await db.select().from(environmentLeases).where(eq(environmentLeases.heartbeatRunId, holder.id)) : [];
      const adapterType = record(record(holder?.runnerProfileJson).adapterDispatch).adapterType;
      if (!holder || !TERMINAL.includes(holder.status) || !holder.finishedAt) reason = "holder_not_terminal";
      else if (adapterExecutionControls.has(holder.id)) reason = "holder_controlled";
      else if (issueId && await controls.getActivePauseHoldGate(input.companyId, issueId)) reason = "holder_task_held";
      else if ((holder.processPid != null && processExists(holder.processPid, false))
        || (holder.processGroupId != null && processExists(holder.processGroupId, true))) reason = "local_process_present";
      else if (leases.some(lease => {
        if (lease.provider === "ssh") return false;
        // A Bridge run executes through the host catalog entry; its local lease
        // records no remote realization and must already be released.
        return !(adapterType === "ccpocket_bridge" && lease.provider === "local" && lease.releasedAt
          && record(record(record(lease.metadata).workspaceRealization).remote).host == null);
      })) reason = "unsupported_environment";
      else if (leases.some(lease => {
        if (lease.provider !== "ssh") return false;
        const remote = record(record(record(lease.metadata).workspaceRealization).remote);
        return remote.host !== observed.endpoint.host || Number(remote.port) !== observed.endpoint.port
          || remote.username !== observed.endpoint.username;
      })) reason = "endpoint_mismatch";
      else if (adapterType !== "ccpocket_bridge" && !leases.some(lease => lease.provider === "ssh")) reason = "unsupported_execution";
      else if (holder.finishedAt.getTime() >= lowerBound) reason = "boot_not_after_finish";
      if (reason === "proven" && holder) {
        await db.transaction(async tx => {
          // Full-precision timestamp: the settlement predicate compares it exactly.
          const [locked] = await tx.execute<{ finished: string | null }>(sql`select to_json(finished_at)#>>'{}' as finished
            from heartbeat_runs where id = ${holder.id}::uuid and date_trunc('milliseconds', finished_at) = ${holder.finishedAt!.toISOString()}::timestamptz for update`);
          const finishedAt = locked?.finished;
          if (!finishedAt) throw conflict("The holder changed during observation");
          const existing = await tx.execute(sql`select 1 from heartbeat_run_events where run_id = ${holder.id}::uuid
            and event_type = ${REMOTE_HOST_REBOOT_EVENT} and payload->>'bootId' = ${observed.bootId}
            and payload->>'runFinishedAt' = ${finishedAt} limit 1`);
          if (existing.length) return;
          await notifyRunStopSettlement(tx, { companyId: input.companyId, runId: holder.id });
          await appendHeartbeatRunEvent(tx as unknown as Db, {
            companyId: input.companyId, runId: holder.id, agentId: holder.agentId, eventType: REMOTE_HOST_REBOOT_EVENT,
            stream: "system", level: "info",
            message: `Remote host ${before.hostId} booted after this run finished; no process from this run can remain.`,
            payload: {
              schema: REMOTE_HOST_REBOOT_SCHEMA, hostId: before.hostId, bootId: observed.bootId,
              bootStartedAtLowerBound: observation!.bootStartedAtLowerBound, observedAt: new Date(sentAt).toISOString(),
              runFinishedAt: finishedAt, endpoint: observed.endpoint, roundTripMs: Math.max(0, receivedAt - sentAt),
              localProcess: holder.processPid != null || holder.processGroupId != null ? "absent" : "not_recorded",
              waitingRunId: input.waitingRunId, issueId: input.issueId,
            },
          });
        });
      }
      const settled = holder ? await sharedCheckoutHolderSettled(db, input.companyId, holder.id) : false;
      if (reason === "proven" && !settled) reason = "other_settlement_pending";
      results.push({ runId: owner.id, issueId, state: settled ? "settled" : "unverified", reason });
    }
  }
  const remaining = (await scope()).holders;
  const settled = remaining.length === 0;
  await logActivity(db, { companyId: input.companyId, actorType: "user", actorId: input.actor.userId ?? "board",
    action: "issue.workspace_holder_reconciled", entityType: "issue", entityId: input.issueId,
    details: { mode: "remote_host_reboot", waitingRunId: input.waitingRunId, projectWorkspaceId: before.workspace.id,
      observation, holders: results, undisclosedHolders, settled } });
  return {
    holderRunId: null, state: settled ? "settled" as const : "unverified" as const, holders: results, undisclosedHolders, observation,
    nextAction: settled ? "The original waiting task retains its scheduled admission; workspace checks still apply."
      : "At least one workspace owner remains without stop and cleanup evidence. Owner intervention is required.",
  };
}
