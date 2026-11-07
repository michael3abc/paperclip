import fs from "node:fs/promises";
import { execFile as execFileCallback } from "node:child_process";
import { promisify } from "node:util";
import { hostname } from "node:os";
import { and, eq, sql } from "drizzle-orm";
import { heartbeatRuns, type Db } from "@paperclipai/db";
import { WorkspaceBusyDeferral } from "./retries.js";
import { WorkspaceValidationFailure } from "./workspaces.js";
import { workspaceProcessConsumers } from "../workspace-process-consumers.js";

const execFile = promisify(execFileCallback);
export type SharedCheckoutClaim = { version: 1; host: string; path: string; issueId: string; acquiredAt: string };

/** Canonical checkout identity includes aliases/subdirectories but not sibling worktrees. */
export async function sharedCheckoutPath(cwd: string): Promise<string> {
  const real = await fs.realpath(cwd);
  const { stdout } = await execFile("git", ["-C", real, "rev-parse", "--show-toplevel"],
    { timeout: 10_000, maxBuffer: 16 * 1024 });
  return fs.realpath(stdout.trim());
}

/** Durable run ownership, acquired before provisioning can mutate the checkout.
 * A transaction advisory lock serializes claims across processes. Terminal status,
 * silence or a controller timeout alone never frees an admitted provider's files.
 * No idle scanner: the next queued admission inspects its exact checkout only.
 */
export async function claimSharedCheckout(db: Db, input: {
  companyId: string; agentId: string; runId: string; issueId: string;
  projectWorkspaceId: string; cwd: string; deferralAttempt: number;
  context: Record<string, unknown>;
}): Promise<SharedCheckoutClaim> {
  const claim: SharedCheckoutClaim = { version: 1, host: hostname(),
    path: await sharedCheckoutPath(input.cwd), issueId: input.issueId, acquiredAt: new Date().toISOString() };
  await db.transaction(async tx => {
    await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${`shared-checkout:${claim.host}:${claim.path}`}, 0))`);
    claim.acquiredAt = new Date().toISOString();
    const [current] = await tx.select({ status: heartbeatRuns.status }).from(heartbeatRuns)
      .where(and(eq(heartbeatRuns.companyId, input.companyId), eq(heartbeatRuns.id, input.runId),
        eq(heartbeatRuns.agentId, input.agentId))).for("update");
    if (current?.status !== "running") throw new Error("shared_checkout_run_not_running");
    const services = await tx.execute(sql`select 1 from workspace_runtime_services
      where status <> 'stopped' and (cwd = ${claim.path} or left(cwd, length(${claim.path}) + 1) = ${claim.path} || '/') limit 1`);
    if (services.length) throw new WorkspaceValidationFailure(
      "This checkout serves a running service. Configure a separate fixed development checkout before dispatch.",
      { reason: "project_checkout_serves_running_service" });
    const holders = await tx.execute<{ id: string; company_id: string; agent_id: string; issue_id: string }>(sql`
      select r.id, r.company_id, r.agent_id, r.context_snapshot->'sharedCheckoutClaim'->>'issueId' as issue_id
      from heartbeat_runs r
      where r.id <> ${input.runId} and r.context_snapshot->'sharedCheckoutClaim'->>'host' = ${claim.host}
        and r.context_snapshot->'sharedCheckoutClaim'->>'path' = ${claim.path}
        and not (
          r.status in ('succeeded', 'failed', 'cancelled', 'timed_out', 'interrupted') and r.finished_at is not null
          and (exists (select 1 from agent_instruction_working_copies c where c.run_id = r.id and c.process_stopped_at is not null)
            or (r.process_pid is null and r.process_group_id is null and r.process_started_at is null and r.native_session_id is null and r.session_id_after is null
              and not (coalesce(r.runner_profile_json, '{}'::jsonb) ? 'nativeExecutionInput')
              and not exists (select 1 from heartbeat_run_events e where e.run_id = r.id
                and (e.source_event_id is not null or e.event_type in ('adapter.invoke', 'native.process_start_requested', 'native.process_identity_recorded', 'harness.ready', 'session.started', 'session.resumed', 'session.updated', 'turn.started', 'provider.event', 'provider.rpc_result', 'tool.execution.started')))))
          and not exists (select 1 from native_run_finalizations f where f.run_id = r.id
            and (f.lease_owner is not null or f.phase <> 'committed'))
          and not exists (select 1 from environment_leases l where l.heartbeat_run_id = r.id
            and (l.status = 'pending_cleanup' or l.cleanup_status = 'failed' or l.metadata ? 'nativeWorkspaceExportResume'
              or (l.released_at is null and not coalesce(l.status = 'retained' and l.lease_policy = 'reuse_by_environment' and l.cleanup_status = 'success', false))))
        ) order by r.created_at, r.id limit 1`);
    const holder = holders[0];
    if (holder) {
      if (holder.company_id !== input.companyId) throw new WorkspaceValidationFailure(
        "This checkout has another active owner; select a dedicated development source.", { reason: "shared_checkout_owned_elsewhere" });
      throw new WorkspaceBusyDeferral({ holder: { runId: holder.id, agentId: holder.agent_id,
        issueId: holder.issue_id, issueIdentifier: null }, projectWorkspaceId: input.projectWorkspaceId,
        deferralAttempt: input.deferralAttempt, wasIssueAssignee: true });
    }
    if ((await workspaceProcessConsumers(claim.path)).length) throw new WorkspaceValidationFailure(
      "Another local process still uses this checkout. Release that writer or service; production needs a separate fixed development checkout.",
      { reason: "shared_checkout_process_active" });
    const { stdout: dirty } = await execFile("git", ["-C", claim.path, "status", "--porcelain=v1", "--untracked-files=normal"],
      { timeout: 10_000, maxBuffer: 1024 * 1024 });
    const prior = await tx.execute<{ issue_id: string }>(sql`select r.context_snapshot->'sharedCheckoutClaim'->>'issueId' as issue_id from heartbeat_runs r
      where r.company_id = ${input.companyId}
        and r.context_snapshot->'sharedCheckoutClaim'->>'host' = ${claim.host}
        and r.context_snapshot->'sharedCheckoutClaim'->>'path' = ${claim.path}
      order by r.context_snapshot->'sharedCheckoutClaim'->>'acquiredAt' desc, r.created_at desc limit 1`);
    if (dirty && prior[0]?.issue_id !== input.issueId) throw new WorkspaceValidationFailure(
      "This checkout contains unsaved work from another owner. Preserve and settle those changes before a new writing task takes ownership.",
      { reason: "shared_checkout_unsaved_changes" });
    await tx.update(heartbeatRuns).set({ contextSnapshot: sql`coalesce(${heartbeatRuns.contextSnapshot}, '{}'::jsonb)
      || jsonb_build_object('sharedCheckoutClaim', ${JSON.stringify(claim)}::jsonb)`, updatedAt: new Date() })
      .where(eq(heartbeatRuns.id, input.runId));
  });
  input.context.sharedCheckoutClaim = claim;
  return claim;
}
