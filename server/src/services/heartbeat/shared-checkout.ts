import fs from "node:fs/promises";
import path from "node:path";
import { execFile as execFileCallback } from "node:child_process";
import { promisify } from "node:util";
import { hostname } from "node:os";
import { createHash } from "node:crypto";
import { and, eq, sql } from "drizzle-orm";
import { heartbeatRuns, issues, type Db } from "@paperclipai/db";
import { WorkspaceBusyDeferral } from "./retries.js";
import { WorkspaceValidationFailure } from "./workspaces.js";
import { workspaceProcessConsumers } from "../workspace-process-consumers.js";
import { suppressedDispositionRepairPredicate } from "../pre-dispatch-execution-wait.js";

const execFile = promisify(execFileCallback);
export type SharedCheckoutClaim = { version: 1; host: string; path: string; issueId: string; acquiredAt: string; kind?: "git" | "directory" | "storage"; executionCwd?: string };

/** Resolve a not-yet-created worktree through its nearest real ancestor. Never
 * collapse it to the source repository (or Git common directory). */
async function plannedDirectory(cwd: string): Promise<string> {
  if (!path.isAbsolute(cwd)) throw new Error("workspace_path_not_absolute");
  let current = path.resolve(cwd);
  const suffix: string[] = [];
  for (;;) {
    try { return path.join(await fs.realpath(current), ...suffix); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      const parent = path.dirname(current);
      if (parent === current) throw error;
      suffix.unshift(path.basename(current));
      current = parent;
    }
  }
}

/** Porcelain -z never quotes names. A rename has a second NUL-delimited name.
 * Paths are diagnostic data only; no file contents or shell commands are read. */
export function sharedCheckoutDirtyPaths(porcelain: string) {
  const records = porcelain.split("\0"), paths: string[] = [];
  for (let i = 0; i < records.length; i++) {
    const record = records[i];
    if (!record) continue;
    paths.push(record.slice(3));
    if (/^[RC]|^.[RC]/.test(record)) i++;
  }
  return { paths: paths.slice(0, 20), count: paths.length, truncated: paths.length > 20 };
}

async function sharedSource(cwd: string, options: { inspectOwnership?: boolean } = {}): Promise<{ path: string; kind: "git" | "directory" }> {
  const real = await fs.realpath(cwd);
  if (!(await fs.stat(real)).isDirectory()) throw new WorkspaceValidationFailure(
    "Select an existing project development directory.", { workspaceValidation: { reason: "shared_workspace_not_directory" } });
  if (process.env.GIT_DIR || process.env.GIT_WORK_TREE || process.env.GIT_COMMON_DIR) throw new WorkspaceValidationFailure(
    "Clear inherited Git directory overrides before claiming a project workspace.", { workspaceValidation: { reason: "shared_workspace_git_override" } });
  // Ordinary document folders need no Git executable. A local .git entry or
  // ancestor repository metadata keeps Git validation authoritative. Ancestor
  // ignore-only directories (for example ~/.git/info/exclude) are not repos.
  // The same exact ignore-only layout is valid at the selected root itself.
  // Empty, partial or additional metadata must still undergo Git validation.
  const entry = async (file: string) => fs.lstat(file).catch(error => {
    if (error.code === "ENOENT") return null;
    throw error;
  });
  let directory = real, git = false;
  for (;;) {
    const marker = path.join(directory, ".git"), metadata = await entry(marker);
    const localIgnoreOnly = directory === real && metadata?.isDirectory()
      && (await fs.readdir(marker)).join("\0") === "info"
      && (await entry(path.join(marker, "info")))?.isDirectory()
      && (await fs.readdir(path.join(marker, "info"))).join("\0") === "exclude"
      && (await entry(path.join(marker, "info", "exclude")))?.isFile();
    if ((metadata && ((directory === real && !localIgnoreOnly) || !metadata.isDirectory() ||
        await entry(path.join(marker, "HEAD")) || await entry(path.join(marker, "config")) ||
        await entry(path.join(marker, "objects")) || await entry(path.join(marker, "refs")))) ||
        (await entry(path.join(directory, "HEAD")) && await entry(path.join(directory, "objects")) &&
          await entry(path.join(directory, "refs")))) { git = true; break; }
    const parent = path.dirname(directory);
    if (parent === directory) break;
    directory = parent;
  }
  if (!git) return { path: real, kind: "directory" };
  // An admitted owner retains its physical scope even if its Git metadata was
  // damaged later. Inspecting that scope must not validate it as a new source
  // or let one broken historical checkout abort admissions elsewhere. New
  // provider admissions still require the Git check below.
  if (options.inspectOwnership) return { path: directory, kind: "git" };
  const { stdout } = await execFile("git", ["-C", real, "rev-parse", "--show-toplevel"],
    { timeout: 10_000, maxBuffer: 16 * 1024 });
  return { path: await fs.realpath(stdout.trim()), kind: "git" };
}

/** Git aliases/subdirectories share a checkout; ordinary folders use their real path. */
export async function sharedCheckoutPath(cwd: string): Promise<string> {
  return (await sharedSource(cwd)).path;
}

/** Durable run ownership, acquired before provisioning can mutate the checkout.
 * A transaction advisory lock serializes claims across processes. Terminal status,
 * silence or a controller timeout alone never frees an admitted provider's files.
 * No idle scanner: the next queued admission inspects its exact checkout only.
 */
/** Server-recorded proof that a non-shared execution host rebooted after a
 * historical holder finished (written only by workspace-holder reconciliation). */
export const REMOTE_HOST_REBOOT_EVENT = "workspace.remote_host_rebooted";
export const REMOTE_HOST_REBOOT_SCHEMA = "paperclip.remote-host-boot-boundary.v1";

/** Reuse an Owner-observed boot boundary for Bridge cleanup, never as a result
 * or a new cancellation ACK. Alias r is the original heartbeat_runs row.
 * The invocation binds the historical host; mutable project settings do not.
 * Only released local preparation leases qualify for this cleanup path. */
export const verifiedBridgeHostRebootSql = sql`r.runtime_mode = 'legacy'
  and r.runner_profile_json#>>'{adapterDispatch,adapterType}' = 'ccpocket_bridge'
  and r.process_pid is null and r.process_group_id is null and r.process_started_at is null
  and not exists (select 1 from environment_leases l where l.heartbeat_run_id = r.id
    and (l.company_id <> r.company_id or l.provider <> 'local' or l.released_at is null))
  and exists (select 1 from heartbeat_run_events boot where boot.run_id = r.id
    and boot.company_id = r.company_id and boot.agent_id = r.agent_id
    and boot.event_type = ${REMOTE_HOST_REBOOT_EVENT} and boot.stream = 'system'
    and boot.source_event_id is null and boot.source_instance_id is null
    and boot.payload->>'schema' = ${REMOTE_HOST_REBOOT_SCHEMA}
    and boot.payload->>'localProcess' in ('absent', 'not_recorded')
    and (boot.payload->>'runFinishedAt')::timestamptz = r.finished_at
    and (boot.payload->>'bootStartedAtLowerBound')::timestamptz > r.finished_at
    and boot.payload->>'hostId' = (select invoked.payload#>>'{context,hostId}'
      from heartbeat_run_events invoked where invoked.run_id = r.id
        and invoked.company_id = r.company_id and invoked.agent_id = r.agent_id
        and invoked.event_type = 'adapter.invoke' and invoked.source_event_id is null
        and invoked.payload->>'adapterType' = 'ccpocket_bridge'
      order by invoked.seq desc limit 1)
    and not exists (select 1 from heartbeat_run_events launched where launched.run_id = r.id
      and launched.event_type in ('adapter.invoke', 'native.process_start_requested', 'native.process_identity_recorded',
        'harness.ready', 'session.started', 'session.resumed', 'session.updated', 'turn.started')
      and (launched.seq > boot.seq or launched.created_at >= (boot.payload->>'bootStartedAtLowerBound')::timestamptz)))`;

const settledSharedCheckoutSql = sql`r.status in ('succeeded', 'failed', 'cancelled', 'timed_out', 'interrupted') and r.finished_at is not null
          and (r.result_json#>>'{stopSettlement,proof}' IS DISTINCT FROM 'remote_host_reboot_receipt'
            OR (${verifiedBridgeHostRebootSql}))
          and (r.error_code IS DISTINCT FROM 'legacy_disposition_repair_suppressed' OR EXISTS (
            select 1 from ${heartbeatRuns} where ${heartbeatRuns.id} = r.id and ${suppressedDispositionRepairPredicate()}))
          and (exists (select 1 from agent_instruction_working_copies c where c.run_id = r.id and c.process_stopped_at is not null)
            or (r.runtime_mode = 'legacy' and exists (select 1 from heartbeat_run_events stopped
              where stopped.run_id = r.id and stopped.company_id = r.company_id
                and stopped.source_event_id is null and stopped.stream = 'system'
                and stopped.event_type = 'execution.local_process_stopped'
                and stopped.payload->>'schema' = 'paperclip.local-process-stop.v1'
                and (stopped.payload->>'identitySeq')::integer =
                  (select max(e.seq) from heartbeat_run_events e where e.run_id = r.id
                    and e.event_type in ('native.process_start_requested', 'native.process_identity_recorded',
                      'turn.started', 'session.resumed'))))
            or (r.result_json#>>'{stopSettlement,schema}' = 'paperclip.run-stop-settlement.v1'
              and r.result_json#>>'{stopSettlement,state}' = 'settled' and r.result_json#>>'{stopSettlement,stopVerified}' = 'true'
              and (r.result_json#>>'{stopSettlement,processGeneration}')::integer =
                (select coalesce(max(e.seq), 0) from heartbeat_run_events e where e.run_id = r.id
                  and e.event_type in ('native.process_start_requested', 'native.process_identity_recorded',
                    'native.local_process_stopped', 'turn.started', 'session.resumed')))
            or (r.runtime_mode = 'legacy' and r.runner_profile_json#>>'{adapterDispatch,adapterType}' = 'ccpocket_bridge'
              and r.status in ('cancelled', 'timed_out')
              and r.result_json#>>'{executionCancellation,state}' = 'acknowledged'
              and r.result_json#>>'{executionCancellation,forced}' = 'false'
              and r.result_json#>>'{executionCancellation,acknowledgedAt}' is not null)
            or (r.process_pid is null and r.process_group_id is null and r.process_started_at is null and r.native_session_id is null and r.session_id_after is null
              and r.result_json->>'nativeSessionId' is null and r.result_json->>'bridgeSessionId' is null
              and not (coalesce(r.runner_profile_json, '{}'::jsonb) ? 'nativeExecutionInput')
              and not exists (select 1 from heartbeat_run_events e where e.run_id = r.id
                and (e.source_event_id is not null or e.event_type in ('adapter.invoke', 'native.process_start_requested', 'native.process_identity_recorded', 'harness.ready', 'session.started', 'session.resumed', 'session.updated', 'turn.started', 'provider.event', 'provider.rpc_result', 'tool.execution.started'))))
            or exists (select 1 from heartbeat_run_events e where e.run_id = r.id
              and e.event_type = ${REMOTE_HOST_REBOOT_EVENT} and e.stream = 'system' and e.source_event_id is null
              and e.payload->>'schema' = ${REMOTE_HOST_REBOOT_SCHEMA}
              and e.payload->>'runFinishedAt' is not null and e.payload->>'bootStartedAtLowerBound' is not null
              and (e.payload->>'runFinishedAt')::timestamptz = r.finished_at
              and (e.payload->>'bootStartedAtLowerBound')::timestamptz > r.finished_at
              and not exists (select 1 from heartbeat_run_events launched where launched.run_id = r.id
                and launched.event_type in ('adapter.invoke', 'native.process_start_requested', 'native.process_identity_recorded',
                  'harness.ready', 'session.started', 'session.resumed', 'session.updated', 'turn.started')
                and (launched.seq > e.seq or launched.created_at >= (e.payload->>'bootStartedAtLowerBound')::timestamptz))))
          and not exists (select 1 from native_run_finalizations f where f.run_id = r.id
            and (f.lease_owner is not null or (f.phase <> 'committed' and not (
              f.phase = 'terminal_failure' and f.next_attempt_at is null
              and f.control_deadline_at is null and f.recovery_request_id is null
              and coalesce(f.recovery_state, 'blocked') = 'blocked'
              and r.result_json->>'workspaceRestoreFailure' is null
              and coalesce(r.result_json->'workspaceRestoreRecovery', 'null'::jsonb) = 'null'::jsonb
              and (exists (select 1 from agent_instruction_working_copies c where c.run_id = r.id
                and c.process_stopped_at is not null) or r.result_json#>>'{stopSettlement,state}' = 'settled')
              and not exists (select 1 from agent_instruction_working_copies c where c.run_id = r.id
                and (c.process_stopped_at is null or c.state not in ('saved', 'unchanged', 'unavailable')
                  or (c.receipt->>'cleanupPending' = 'true' or (c.receipt->>'schema' = 'paperclip.agent-files.v1' and c.receipt->>'cleanupPending' is distinct from 'false'))
                  or c.receipt ? 'retainedByRunId'))
            ))))
          and not exists (select 1 from agent_instruction_working_copies c where c.run_id = r.id
            and (c.process_stopped_at is null or c.state not in ('saved', 'unchanged', 'unavailable')
              or (c.receipt->>'cleanupPending' = 'true' or (c.receipt->>'schema' = 'paperclip.agent-files.v1' and c.receipt->>'cleanupPending' is distinct from 'false')) or c.receipt ? 'retainedByRunId'))
          and not exists (select 1 from heartbeat_run_events e where e.run_id = r.id
            and ((e.source_event_id is null and e.event_type in ('native.process_start_requested', 'native.process_identity_recorded'))
              or e.event_type in ('adapter.invoke', 'harness.ready', 'session.started', 'session.updated', 'turn.started', 'session.resumed'))
            and not exists (select 1 from heartbeat_run_events stopped where stopped.run_id = r.id
              and stopped.source_event_id is null and stopped.event_type = 'native.local_process_stopped' and stopped.seq > e.seq)
            and exists (select 1 from agent_instruction_working_copies c where c.run_id = r.id and e.created_at > c.process_stopped_at))
          and (r.controller_lease_expires_at is null or r.controller_lease_expires_at <= now())
          and not exists (select 1 from workspace_operations o where o.heartbeat_run_id = r.id
            and o.status in ('running', 'queued', 'pending'))
          and not exists (select 1 from environment_leases l where l.heartbeat_run_id = r.id
            and (l.status = 'pending_cleanup' or l.cleanup_status = 'failed' or l.metadata ? 'nativeWorkspaceExportResume'
              or (l.released_at is null and not coalesce(l.status = 'retained' and l.lease_policy = 'reuse_by_environment' and l.cleanup_status = 'success', false))))`;

export async function sharedCheckoutHolderSettled(db: Db, companyId: string, runId: string) {
  const rows = await db.execute(sql`select 1 from heartbeat_runs r where r.id = ${runId}::uuid
    and r.company_id = ${companyId}::uuid and (${settledSharedCheckoutSql})`);
  return rows.length === 1;
}

type HolderExecutor = Pick<Db, "execute">;
export interface UnsettledWorkspaceHolder {
  id: string; company_id: string; agent_id: string; issue_id: string;
  /** explicit: recorded sharedCheckoutClaim; prior: admitted before physical claims, keyed by its recorded cwd. */
  kind: "explicit" | "prior";
}
/** Unsettled runs owning an equal, parent or child path on one claim host. Shared by
 * admission (first owner only) and read-only holder reconciliation (all owners). */
export async function unsettledWorkspaceHolders(db: HolderExecutor, input: {
  host: string; path: string; remote: boolean; storage?: boolean; excludeRunId?: string | null; first?: boolean;
}): Promise<UnsettledWorkspaceHolder[]> {
  const exclude = input.excludeRunId ?? "00000000-0000-0000-0000-000000000000";
  const explicit = await db.execute<{ id: string; company_id: string; agent_id: string; issue_id: string }>(sql`
      select r.id, r.company_id, r.agent_id, r.context_snapshot->'sharedCheckoutClaim'->>'issueId' as issue_id
      from heartbeat_runs r
      where r.id <> ${exclude} and r.context_snapshot->'sharedCheckoutClaim'->>'host' = ${input.host}
        and (r.context_snapshot->'sharedCheckoutClaim'->>'path' = ${input.path}
          or starts_with(r.context_snapshot->'sharedCheckoutClaim'->>'path', rtrim(${input.path}, '/') || '/')
          or starts_with(${input.path}, rtrim(r.context_snapshot->'sharedCheckoutClaim'->>'path', '/') || '/'))
        and not coalesce((
          ${settledSharedCheckoutSql}
        ), false) order by r.created_at, r.id ${input.first ? sql`limit 1` : sql``}`);
  const found: UnsettledWorkspaceHolder[] = explicit.map(row => ({ ...row, kind: "explicit" as const }));
  if ((input.first && found.length) || input.storage) return found;
  // Runs admitted before physical claims were introduced retain ownership.
  // Inspect their recorded execution directory, never their task prose or the
  // project's current default. Do not mutate or restart those runs on upgrade.
  const priorAdmissions = await db.execute<{
    id: string; company_id: string; agent_id: string; issue_id: string; cwd: string; host: string;
  }>(sql`select r.id, r.company_id, r.agent_id,
      coalesce(r.issue_id::text, r.native_issue_id::text, r.context_snapshot->>'issueId') as issue_id,
      r.context_snapshot#>>'{paperclipWorkspace,cwd}' as cwd,
      case when coalesce(r.context_snapshot#>>'{paperclipWorkspace,remoteHostId}',
        case when p.source_type = 'remote_managed' then p.metadata->>'hostId' end) is not null
        then 'ccpocket:' || coalesce(r.context_snapshot#>>'{paperclipWorkspace,remoteHostId}', p.metadata->>'hostId')
        else ${hostname()} end as host
    from heartbeat_runs r left join project_workspaces p
      on p.id::text = r.context_snapshot#>>'{paperclipWorkspace,workspaceId}'
      and p.company_id = r.company_id
    where r.id <> ${exclude} and r.context_snapshot->'sharedCheckoutClaim' is null
      and r.context_snapshot#>>'{paperclipWorkspace,cwd}' is not null
      and not coalesce((${settledSharedCheckoutSql}), false) order by r.created_at, r.id`);
  for (const previous of priorAdmissions) {
    if (previous.host !== input.host) continue;
    const previousPath = input.remote ? previous.cwd : await sharedSource(previous.cwd, { inspectOwnership: true }).then(source => source.path).catch(error => {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      return plannedDirectory(previous.cwd);
    });
    if (previousPath === input.path || previousPath.startsWith(input.path.replace(/\/$/, "") + "/")
      || input.path.startsWith(previousPath.replace(/\/$/, "") + "/")) {
      const { cwd: _cwd, host: _host, ...holder } = previous;
      found.push({ ...holder, kind: "prior" });
      if (input.first) break;
    }
  }
  return found;
}

export async function claimSharedCheckout(db: Db, input: {
  companyId: string; agentId: string; runId: string; issueId: string;
  projectWorkspaceId: string | null; cwd: string; deferralAttempt: number;
  wasIssueAssignee?: boolean;
  requireGit?: boolean;
  /** Only the runtime's worktree creation callback may reserve a missing path. */
  preparingWorktree?: boolean;
  /** Shared-source handoff additionally checks unmanaged processes and dirtiness.
   * Task-owned copies and resident sessions retain their runtime's own checks. */
  checkSourceHandoff?: boolean;
  /** Server-owned durable provider namespace and storage reference, never cwd. */
  storageIdentity?: { namespace: string; workspaceRef: string };
  /** A CC Pocket Bridge host other than the controller. Its filesystem is not visible here: claims key on
   * that host and the source's canonical registered path, and the remote Bridge verifies the directory. */
  remoteHostId?: string | null;
  context: Record<string, unknown>;
}): Promise<SharedCheckoutClaim> {
  const remote = input.remoteHostId ?? null;
  const storage = input.storageIdentity;
  if (storage && (!storage.namespace || !storage.workspaceRef || remote)) throw new Error("workspace_storage_identity_invalid");
  const source = remote || storage ? null : await sharedSource(input.cwd).catch(async error => {
    if (!input.preparingWorktree || (error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    return { path: await plannedDirectory(input.cwd), kind: "directory" as const };
  });
  if (remote && (!input.cwd.startsWith("/") || path.posix.normalize(input.cwd) !== input.cwd || (input.cwd.length > 1 && input.cwd.endsWith("/")))) {
    throw new WorkspaceValidationFailure("The remote project source path is not a canonical absolute path.", { workspaceValidation: { reason: "remote_worker_path_invalid" } });
  }
  if (input.requireGit && source?.kind !== "git") throw new WorkspaceValidationFailure(
    "This source declares a Git repository or revision but its directory is not a Git checkout. Repair that source or select an ordinary document directory without Git settings.",
    { workspaceValidation: { reason: "shared_workspace_git_required" } });
  const claim: SharedCheckoutClaim = { version: 1, ...(storage
    ? { host: `storage:${storage.namespace}`, path: `/${createHash("sha256").update(storage.workspaceRef).digest("hex")}`, kind: "storage" as const }
    : source ? { host: hostname(), ...source } : { host: `ccpocket:${remote}`, path: input.cwd }),
    issueId: input.issueId, executionCwd: input.cwd, acquiredAt: new Date().toISOString() };
  await db.transaction(async tx => {
    // Serialize only the admission transaction per host, so parent and child
    // directory claims cannot race. Independent admitted providers run in parallel.
    await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${`shared-checkout:${claim.host}`}, 0))`);
    claim.acquiredAt = new Date().toISOString();
    const [current] = await tx.select({ status: heartbeatRuns.status }).from(heartbeatRuns)
      .where(and(eq(heartbeatRuns.companyId, input.companyId), eq(heartbeatRuns.id, input.runId),
        eq(heartbeatRuns.agentId, input.agentId))).for("update");
    if (current?.status !== "running") throw new Error("shared_checkout_run_not_running");
    const services = remote || storage ? [] : await tx.execute(sql`select 1 from workspace_runtime_services
      where status <> 'stopped' and (cwd = ${claim.path} or starts_with(cwd, rtrim(${claim.path}, '/') || '/')
        or starts_with(${claim.path}, rtrim(cwd, '/') || '/')) limit 1`);
    if (services.length) throw new WorkspaceValidationFailure(
      "This checkout serves a running service. Configure a separate fixed development checkout before dispatch.",
      { workspaceValidation: { reason: "project_checkout_serves_running_service" } });
    const [owner] = await unsettledWorkspaceHolders(tx, { host: claim.host, path: claim.path,
      remote: Boolean(remote), storage: Boolean(storage), excludeRunId: input.runId, first: true });
    if (owner) {
      throw new WorkspaceBusyDeferral({ holder: { runId: owner.id, agentId: owner.agent_id,
        issueId: owner.issue_id, issueIdentifier: null }, projectWorkspaceId: input.projectWorkspaceId,
        discloseHolder: owner.company_id === input.companyId && owner.issue_id === input.issueId,
        deferralAttempt: input.deferralAttempt, wasIssueAssignee: input.wasIssueAssignee ?? true });
    }
    if (input.checkSourceHandoff !== false && !remote && !storage && (await workspaceProcessConsumers(claim.path)).length) throw new WorkspaceValidationFailure(
      "Another local process still uses this checkout. Release that writer or service; production needs a separate fixed development checkout.",
      { workspaceValidation: { reason: "shared_checkout_process_active" } });
    const dirty = input.checkSourceHandoff !== false && source?.kind === "git" ? (await execFile("git", ["-C", claim.path, "status", "--porcelain=v1", "-z", "--untracked-files=all"],
      { timeout: 10_000, maxBuffer: 1024 * 1024 })).stdout : "";
    const prior = await tx.execute<{ issue_id: string; run_id: string }>(sql`select r.id as run_id, r.context_snapshot->'sharedCheckoutClaim'->>'issueId' as issue_id from heartbeat_runs r
      where r.company_id = ${input.companyId}
        and r.context_snapshot->'sharedCheckoutClaim'->>'host' = ${claim.host}
        and r.context_snapshot->'sharedCheckoutClaim'->>'path' = ${claim.path}
      order by r.context_snapshot->'sharedCheckoutClaim'->>'acquiredAt' desc, r.created_at desc limit 1`);
    if (dirty && prior[0]?.issue_id !== input.issueId) {
      const [task] = await tx.select({ revision: issues.workspaceBindingRevision }).from(issues).where(and(
        eq(issues.id, input.issueId), eq(issues.companyId, input.companyId)));
      throw new WorkspaceValidationFailure(
      "This checkout contains unsaved work from another owner. Preserve and settle those changes before a new writing task takes ownership.",
      { workspaceValidation: { reason: "shared_checkout_unsaved_changes", projectWorkspaceId: input.projectWorkspaceId,
        cwd: claim.path, host: claim.host, previousIssueId: prior[0]?.issue_id ?? null,
        previousRunId: prior[0]?.run_id ?? null, bindingRevision: task?.revision ?? null,
        dirtyFiles: sharedCheckoutDirtyPaths(dirty),
        fingerprint: createHash("sha256").update(JSON.stringify([claim.host, claim.path,
          prior[0]?.issue_id ?? null, dirty])).digest("hex"),
      } });
    }
    await tx.update(heartbeatRuns).set({ contextSnapshot: sql`coalesce(${heartbeatRuns.contextSnapshot}, '{}'::jsonb)
      || jsonb_build_object('sharedCheckoutClaim', ${JSON.stringify(claim)}::jsonb)`, updatedAt: new Date() })
      .where(eq(heartbeatRuns.id, input.runId));
  });
  input.context.sharedCheckoutClaim = claim;
  return claim;
}
