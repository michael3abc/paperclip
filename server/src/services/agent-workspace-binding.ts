import { stat, realpath } from "node:fs/promises";
import path from "node:path";
import { isDeepStrictEqual } from "node:util";
import { and, eq, sql } from "drizzle-orm";
import { chatConversations, issues, type Db } from "@paperclipai/db";
import { agentWorkspaceBindingSchema, type AgentRuntimeConfig } from "@paperclipai/shared";

export type FixedWorkspaceBinding = NonNullable<AgentRuntimeConfig["workspaceBinding"]>;

function record(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

export function fixedWorkspaceMatchesRun(input: {
  binding: FixedWorkspaceBinding; environment: { driver: string; config: Record<string, unknown> } | null;
  run: { contextSnapshot: unknown; runnerProfileJson: unknown };
}): boolean {
  const context = record(input.run.contextSnapshot);
  const environment = record(context.paperclipEnvironment);
  const native = record(record(input.run.runnerProfileJson).nativeExecutionInput);
  const cwd = environment.remoteCwd ?? record(native.workspace).cwd ?? record(context.paperclipWorkspace).cwd;
  if (typeof cwd !== "string" || path.posix.normalize(cwd).replace(/\/$/, "") !== path.posix.normalize(input.binding.cwd).replace(/\/$/, "")) return false;
  if (environment.driver !== input.environment?.driver) return false;
  if (environment.driver === "local") return true;
  return environment.driver === "ssh" && ["host", "port", "username"].every(key =>
    environment[key] === (input.environment!.config[key] ?? (key === "port" ? 22 : undefined)));
}

/** Only a binding-only revision can reuse the previous configuration fingerprint. */
export function fixedBindingOnlyRevision(before: Record<string, unknown>, after: Record<string, unknown>): boolean {
  const strip = (config: Record<string, unknown>) => {
    const runtime = { ...record(config.runtimeConfig) };
    delete runtime.workspaceBinding;
    return { ...config, runtimeConfig: runtime };
  };
  return isDeepStrictEqual(strip(before), strip(after));
}

export function workspaceBindingConflict(reason: string, message: string): never {
  throw Object.assign(new Error(message), {
    code: "workspace_validation_failed",
    resultJson: { workspaceValidation: { reason: `fixed_workspace_${reason}` } },
  });
}

export function readWorkspaceBinding(runtimeConfig: Record<string, unknown> | undefined): FixedWorkspaceBinding | null {
  if (runtimeConfig?.workspaceBinding === undefined) return null;
  const parsed = agentWorkspaceBindingSchema.safeParse(runtimeConfig.workspaceBinding);
  if (!parsed.success) workspaceBindingConflict("invalid", "Fixed working directory must be an absolute path with mode=fixed.");
  return parsed.data;
}

/** Durable source evidence, independent of caller-provided wake or conversation flags. */
export async function isExternalWorkspaceTask(db: Db, companyId: string, issueId: string | null): Promise<boolean> {
  if (!issueId) return false;
  const [issue] = await db.select({
    external: sql<boolean>`${issues.originKind} = 'chat_channel' or exists (
      select 1 from ${chatConversations} c where c.issue_id = ${issues.id} and c.company_id = ${companyId}
    )`,
  }).from(issues).where(and(eq(issues.id, issueId), eq(issues.companyId, companyId))).limit(1);
  if (!issue) workspaceBindingConflict("issue_unavailable", "Fixed workspace task is unavailable in this company.");
  return issue.external;
}

/** Reject isolation and provisioning requests before any workspace can be created. */
export function assertFixedWorkspacePolicy(input: {
  binding: FixedWorkspaceBinding; environment: { driver: string; config: Record<string, unknown> } | null;
  trustPreset: string; mode: string; external: boolean; isDot: boolean; strategies: unknown[];
}): void {
  if (input.trustPreset === "low_trust_review" || input.external) {
    workspaceBindingConflict("isolation_required", "External chat and low-trust tasks require isolation and cannot use an agent's fixed working directory.");
  }
  if (["isolated_workspace", "operator_branch"].includes(input.mode)) {
    workspaceBindingConflict("policy_conflict", "This task requires an isolated workspace or branch, conflicting with the fixed working directory.");
  }
  const environment = input.environment;
  if (input.isDot || !environment || !["local", "ssh"].includes(environment.driver)) {
    workspaceBindingConflict("environment_conflict", "The selected environment does not support fixed in-place execution.");
  }
  if (environment.driver === "ssh" && (environment.config.workspaceMode !== "in_place" || environment.config.remoteWorkspacePath !== input.binding.cwd)) {
    workspaceBindingConflict("environment_conflict", "SSH fixed execution requires in_place mode and the exact configured remote workspace path.");
  }
  for (const value of input.strategies) {
    if (!value || typeof value !== "object") continue;
    const strategy = value as Record<string, unknown>;
    if ((strategy.type && strategy.type !== "project_primary") ||
        ["provisionCommand", "runtimeProvisionCommand", "teardownCommand", "cleanupCommand"].some(key => strategy[key])) {
      workspaceBindingConflict("provisioning_conflict", "Fixed working directories cannot use workspace provisioning, cleanup or worktree strategies.");
    }
  }
}

export function assertFixedProjectWorkspace(binding: FixedWorkspaceBinding, workspace: { cwd: string | null } | null, configured: boolean): void {
  if (configured && (!workspace?.cwd || path.posix.normalize(workspace.cwd).replace(/\/$/, "") !== path.posix.normalize(binding.cwd).replace(/\/$/, ""))) {
    workspaceBindingConflict("project_conflict", "The selected project's working directory differs from the agent's fixed working directory.");
  }
}

export async function validateFixedLocalDirectory(binding: FixedWorkspaceBinding): Promise<void> {
  try {
    if (!path.isAbsolute(binding.cwd) || !(await stat(binding.cwd)).isDirectory()) throw new Error("not a directory");
    if (await realpath(binding.cwd) !== path.resolve(binding.cwd)) {
      workspaceBindingConflict("path_alias", "Use the canonical absolute working directory; symbolic path aliases are not accepted.");
    }
  } catch (error) {
    if ((error as { code?: string }).code === "workspace_validation_failed") throw error;
    workspaceBindingConflict("path_unavailable", "The fixed working directory does not exist or is not accessible on the selected host. No directory was created.");
  }
}
