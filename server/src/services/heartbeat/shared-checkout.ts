import fs from "node:fs/promises";
import path from "node:path";
import { execFile as execFileCallback } from "node:child_process";
import { promisify } from "node:util";
import { hostname } from "node:os";
import { createHash } from "node:crypto";
import { and, eq, sql } from "drizzle-orm";
import { heartbeatRuns, type Db } from "@paperclipai/db";
import { WorkspaceValidationFailure } from "./workspaces.js";
import { logger } from "../../middleware/logger.js";

const execFile = promisify(execFileCallback);
export type SharedCheckoutClaim = { version: 1; host: string; path: string; issueId: string; acquiredAt: string; kind?: "git" | "directory" | "storage"; executionCwd?: string;
  /** Logged-only workspace mismatches (liveness-first rule 3); never a refusal. */
  mismatches?: string[] };

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

/** Server-recorded observation that a non-shared execution host rebooted after a
 * historical holder finished (written only by workspace-holder reconciliation).
 * Liveness-first: diagnostic evidence only; it no longer gates anything. */
export const REMOTE_HOST_REBOOT_EVENT = "workspace.remote_host_rebooted";
export const REMOTE_HOST_REBOOT_SCHEMA = "paperclip.remote-host-boot-boundary.v1";

/** Terminal run statuses. Liveness-first rule 2: a terminal run releases every
 * gate at once (workspace holders, claims, retirement). Stop evidence and
 * cleanup receipts are collected in the background (stop-settlement.ts) and are
 * never required here. Terminal status still never authorizes deleting files. */
export const TERMINAL_RUN_STATUSES = ["succeeded", "failed", "cancelled", "timed_out", "interrupted"] as const;

// Recovery services share this predicate; alias r is the holder heartbeat_runs row.
const settledSharedCheckoutSql = () => sql`r.status in (${sql.join(TERMINAL_RUN_STATUSES.map(status => sql`${status}`), sql`, `)})`;

/** "Settled" == "terminal". Kept as a named check for holder reconciliation callers. */
export async function sharedCheckoutHolderSettled(db: Db, companyId: string, runId: string) {
  const rows = await db.execute(sql`select 1 from heartbeat_runs r where r.id = ${runId}::uuid
    and r.company_id = ${companyId}::uuid and (${settledSharedCheckoutSql()})`);
  return rows.length === 1;
}

type HolderExecutor = Pick<Db, "execute">;
export interface UnsettledWorkspaceHolder {
  id: string; company_id: string; agent_id: string; issue_id: string;
  /** explicit: recorded sharedCheckoutClaim; prior: admitted before physical claims, keyed by its recorded cwd. */
  kind: "explicit" | "prior";
}
/** Non-terminal (live or pending) runs using an equal, parent or child path on one
 * claim host. Read-only: used by worktree retirement and holder reconciliation for
 * display and safety, never by dispatch admission. Terminal runs are never holders. */
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
          ${settledSharedCheckoutSql()}
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
      and not coalesce((${settledSharedCheckoutSql()}), false) order by r.created_at, r.id`);
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

function claimMismatchReason(error: unknown) {
  const validation = (error as { resultJson?: { workspaceValidation?: { reason?: unknown } } })?.resultJson?.workspaceValidation;
  if (typeof validation?.reason === "string") return validation.reason;
  const code = (error as NodeJS.ErrnoException)?.code;
  return typeof code === "string" ? `shared_workspace_${code.toLowerCase()}` : "shared_workspace_unresolved";
}

/** Liveness-first rule 3 (workspace = directory): always granted. The claim only
 * records the execution directory for display; other runs, aliases, parent/child
 * paths, historical cleanup, Git expectations and remote path shape never refuse
 * or park a run. Mismatches are logged and recorded on the claim (`mismatches`). */
export async function claimSharedCheckout(db: Db, input: {
  companyId: string; agentId: string; runId: string; issueId: string;
  projectWorkspaceId: string | null; cwd: string; deferralAttempt: number;
  wasIssueAssignee?: boolean;
  /** Advisory only: a non-Git directory is logged, never refused. */
  requireGit?: boolean;
  /** The runtime's worktree creation callback may record a not-yet-created path. */
  preparingWorktree?: boolean;
  /** Legacy caller hint retained in input until workspace preparation is migrated.
   * It cannot establish exclusive ownership or reject collaborator changes. */
  checkSourceHandoff?: boolean;
  /** Server-owned durable provider namespace and storage reference, never cwd. */
  storageIdentity?: { namespace: string; workspaceRef: string };
  /** A CC Pocket Bridge host other than the controller. Its filesystem is not visible here: the claim
   * records that host and the given path, and the remote Bridge creates/verifies the directory. */
  remoteHostId?: string | null;
  context: Record<string, unknown>;
}): Promise<SharedCheckoutClaim> {
  const remote = input.remoteHostId ?? null;
  const mismatches: string[] = [];
  const validStorage = input.storageIdentity && input.storageIdentity.namespace && input.storageIdentity.workspaceRef && !remote;
  if (input.storageIdentity && !validStorage) mismatches.push("workspace_storage_identity_invalid");
  const storage = validStorage ? input.storageIdentity! : null;
  const source = remote || storage ? null : await sharedSource(input.cwd).catch(async error => {
    mismatches.push(claimMismatchReason(error));
    const planned = await plannedDirectory(input.cwd).catch(() => path.resolve(input.cwd));
    return { path: planned, kind: "directory" as const };
  });
  if (remote && (!input.cwd.startsWith("/") || path.posix.normalize(input.cwd) !== input.cwd || (input.cwd.length > 1 && input.cwd.endsWith("/"))))
    mismatches.push("remote_worker_path_invalid");
  if (input.requireGit && !remote && !storage && source?.kind !== "git") mismatches.push("shared_workspace_git_required");
  const claim: SharedCheckoutClaim = { version: 1, ...(storage
    ? { host: `storage:${storage.namespace}`, path: `/${createHash("sha256").update(storage.workspaceRef).digest("hex")}`, kind: "storage" as const }
    : source ? { host: hostname(), ...source } : { host: `ccpocket:${remote}`, path: input.cwd }),
    issueId: input.issueId, executionCwd: input.cwd, acquiredAt: new Date().toISOString(),
    ...(mismatches.length ? { mismatches } : {}) };
  if (mismatches.length) logger.warn({ runId: input.runId, issueId: input.issueId, cwd: input.cwd, remoteHostId: remote, mismatches },
    "workspace directory mismatch recorded; the run continues in its resolved directory");
  // Display record only, written while the run is still running. Nothing reads it as a lock.
  await db.update(heartbeatRuns).set({ contextSnapshot: sql`coalesce(${heartbeatRuns.contextSnapshot}, '{}'::jsonb)
    || jsonb_build_object('sharedCheckoutClaim', ${JSON.stringify(claim)}::jsonb)`, updatedAt: new Date() })
    .where(and(eq(heartbeatRuns.companyId, input.companyId), eq(heartbeatRuns.id, input.runId),
      eq(heartbeatRuns.agentId, input.agentId), eq(heartbeatRuns.status, "running")));
  input.context.sharedCheckoutClaim = claim;
  return claim;
}
