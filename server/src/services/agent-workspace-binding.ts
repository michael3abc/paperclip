import { mkdir, stat, realpath } from "node:fs/promises";
import path from "node:path";
import { isDeepStrictEqual } from "node:util";
import { and, asc, desc, eq, sql } from "drizzle-orm";
import { agents, chatConversations, issues, projects, projectWorkspaces, type Db } from "@paperclipai/db";
import {
  agentProjectPmWorkspaceBindingSchema,
  agentWorkspaceBindingSchema,
  type AgentFixedWorkspaceBinding,
  type AgentProjectPmWorkspaceBinding,
  type PaperclipPmWorkspaceContext,
  type ProjectPmRole,
} from "@paperclipai/shared";
import { HttpError } from "../errors.js";
import { resolveDefaultAgentWorkspaceDir } from "../home-paths.js";
import { logger } from "../middleware/logger.js";
import { isPendingExecutionReviewForAgent } from "./issue-execution-policy.js";
import { verifiedPmWatchdogSql } from "./task-watchdog-scope.js";

/**
 * The binding every workspace call site consumes. A `project_pm` binding is
 * projected onto this shape per run: its `cwd` is the role cwd resolved at claim.
 */
export type FixedWorkspaceBinding = AgentFixedWorkspaceBinding & {
  /** Present when the binding is a projection of a `project_pm` binding for one run. */
  projectPm?: PaperclipPmWorkspaceContext;
};

export type ProjectPmWorkspaceBinding = AgentProjectPmWorkspaceBinding;
export type ResolvedProjectPmWorkspaceBinding = Omit<AgentProjectPmWorkspaceBinding, "agentHome" | "inboxIssueId"> & {
  agentHome: string;
  inboxIssueId: string | null;
};

function record(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

/** A current formal reviewer keeps its configured home; it does not own the worker's task binding. */
export function isFixedMainReview(
  agent: { id: string; adapterType: string; adapterConfig: unknown; runtimeConfig: unknown },
  issue: { projectId?: string | null; assigneeAgentId?: string | null; status?: string; executionState?: unknown } | null,
): boolean {
  const config = record(agent.adapterConfig);
  return issue !== null && agent.adapterType === "ccpocket_bridge" && config.role === "main"
    && record(record(agent.runtimeConfig).workspaceBinding).mode === "fixed"
    && typeof config.projectId === "string" && config.projectId === issue?.projectId
    && issue.assigneeAgentId === agent.id && isPendingExecutionReviewForAgent(issue, agent.id);
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

/**
 * Liveness-first (Owner 2026-11-13, rule 3): a workspace mismatch never fails a
 * run. It is logged and the run keeps its resolved directory. Returns the reason.
 */
export function workspaceBindingConflict(reason: string, message: string, details?: Record<string, unknown>): string {
  const code = `fixed_workspace_${reason}`;
  logger.warn({ ...details, workspaceValidation: { reason: code } }, `Workspace mismatch ignored: ${message}`);
  return code;
}

function normalizedWorkspacePath(value: string) {
  return path.posix.normalize(value.trim()).replace(/(.)\/$/, "$1");
}

/** The session cwd a CC Pocket agent's adapter always launches in, or null. */
export function bridgeSessionCwd(agent: { adapterType: string; adapterConfig: unknown }): string | null {
  if (agent.adapterType !== "ccpocket_bridge") return null;
  const cwd = record(agent.adapterConfig).cwd;
  return typeof cwd === "string" && cwd.trim() ? cwd.trim() : null;
}

export type BridgeFixedBindingConflict = { reason: "missing" | "cwd_mismatch"; cwd: string; message: string };

/**
 * A CC Pocket agent with an adapter session cwd always runs there, so the
 * server must treat that directory as a fixed placement. runtimeConfig.workspaceBinding
 * is the single authority the server reads; it must exist and name the same
 * directory. A project PM binding has its own role rules and is not checked here.
 */
export function bridgeFixedBindingConflict(agent: {
  adapterType: string; adapterConfig: unknown; runtimeConfig: unknown;
}): BridgeFixedBindingConflict | null {
  const cwd = bridgeSessionCwd(agent);
  if (!cwd) return null;
  const binding = record(record(agent.runtimeConfig).workspaceBinding);
  if (binding.mode === "project_pm") return null;
  if (binding.mode !== "fixed" || typeof binding.cwd !== "string") {
    return { reason: "missing", cwd, message: `This CC Pocket agent always runs in ${cwd}; register the same directory as runtimeConfig.workspaceBinding {mode: "fixed", cwd} before saving.` };
  }
  if (normalizedWorkspacePath(binding.cwd) !== normalizedWorkspacePath(cwd)) {
    return { reason: "cwd_mismatch", cwd, message: `The adapter session cwd ${cwd} differs from the fixed working directory ${binding.cwd}; both must name the same directory.` };
  }
  return null;
}

/** Read-only startup audit: every non-terminated CC Pocket agent whose session cwd lacks its binding. */
export async function auditBridgeFixedBindings(db: Db) {
  const rows = await db.select({ id: agents.id, companyId: agents.companyId, name: agents.name, adapterType: agents.adapterType,
    adapterConfig: agents.adapterConfig, runtimeConfig: agents.runtimeConfig }).from(agents)
    .where(and(eq(agents.adapterType, "ccpocket_bridge"), sql`${agents.status} <> 'terminated'`));
  return rows.flatMap(row => {
    const conflict = bridgeFixedBindingConflict(row);
    return conflict ? [{ agentId: row.id, companyId: row.companyId, name: row.name, reason: conflict.reason, cwd: conflict.cwd }] : [];
  });
}

/**
 * The strategies that actually shape a fixed run. A project's workspaceStrategy
 * is its implementation workers' default: buildExecutionWorkspaceAdapterConfig
 * applies it only for isolated/branch modes or a storage provider, and then
 * mergedConfig already carries it. An unused worker default must not reject a
 * main agent's fixed directory; an explicit task or environment strategy still does.
 */
export function appliedFixedWorkspaceStrategies(input: {
  mode: string; mergedConfig: Record<string, unknown>; configSnapshot: unknown;
  projectPolicy: { workspaceStrategy?: unknown; storageProviderPluginId?: unknown } | null | undefined;
  issueStrategy: unknown; environmentStrategy: unknown;
}): unknown[] {
  const projectApplies = ["isolated_workspace", "operator_branch"].includes(input.mode)
    || Boolean(input.projectPolicy?.storageProviderPluginId);
  return [input.mergedConfig, input.mergedConfig.workspaceStrategy, input.configSnapshot,
    ...(projectApplies ? [input.projectPolicy?.workspaceStrategy] : []), input.issueStrategy, input.environmentStrategy];
}

/**
 * The directory for controller-local setup (Git context discovery, launchers).
 * A remote-host PM binding's run cwd (the worker root, or the native PM home)
 * and a remote-host fixed directory exist only on their registered host, so
 * controller probes use the agent's controller home instead.
 */
export function controllerLocalCwd(binding: FixedWorkspaceBinding | null | undefined, cwd: string, agentId: string): string {
  if (binding?.projectPm?.workerHostId) return binding.projectPm.agentHome;
  return binding?.hostId ? resolveDefaultAgentWorkspaceDir(agentId) : cwd;
}

/**
 * Read the binding that governs this run's working directory. A `project_pm`
 * binding needs the run context: its cwd is the role cwd recorded in
 * `context.paperclipPmWorkspace` at claim, never a caller-chosen path.
 */
export function readWorkspaceBinding(
  runtimeConfig: Record<string, unknown> | undefined,
  context?: Record<string, unknown> | null,
): FixedWorkspaceBinding | null {
  if (runtimeConfig?.workspaceBinding === undefined) return null;
  const parsed = agentWorkspaceBindingSchema.safeParse(runtimeConfig.workspaceBinding);
  if (!parsed.success) {
    if (record(runtimeConfig.workspaceBinding).mode === "project_pm") {
      projectPmConflict("invalid", "The project PM binding is invalid. Reconfigure it with an absolute worker root, a project and 0-4 worker slots.");
    }
    // An unusable fixed binding is skipped: the run falls back to the project
    // default directory or the agent home.
    workspaceBindingConflict("invalid", "Fixed working directory must be an absolute path with mode=fixed.");
    return null;
  }
  if (parsed.data.mode === "fixed") return parsed.data;
  const pmContext = readPaperclipPmWorkspaceContext(context?.paperclipPmWorkspace);
  if (!pmContext) {
    projectPmConflict("context_missing", "The project PM role was not resolved for this run.");
  }
  const binding = parsed.data;
  if (binding.workerSlots === 0 && pmContext.role === "worker") {
    projectPmConflict("worker_disabled", "This PM only coordinates and reviews. Assign implementation to a separate worker agent.");
  }
  // A whitelisted PM's worker runs in the issue project's workspace, which the
  // server resolved at claim; the context then names that project and root.
  const crossProjectWorker = binding.allowCrossProject === true && pmContext.role === "worker";
  const expectedCwd = pmContext.role === "worker"
    ? (crossProjectWorker ? pmContext.workerRoot : binding.workerRoot)
    : (binding.pmHome ?? binding.agentHome ?? pmContext.agentHome);
  if (
    (!crossProjectWorker && (pmContext.projectId !== binding.projectId || pmContext.workerRoot !== binding.workerRoot)) ||
    pmContext.workerHostId !== binding.workerHostId ||
    pmContext.pmHome !== binding.pmHome ||
    (binding.agentHome !== undefined && pmContext.agentHome !== binding.agentHome) ||
    pmContext.cwd !== expectedCwd
  ) {
    projectPmConflict("context_mismatch", "The run's project PM workspace does not match the agent's binding.");
  }
  return { mode: "fixed", cwd: pmContext.cwd, projectPm: pmContext };
}

/** Parse the stored `project_pm` binding, or null for any other (or invalid) binding. */
export function readProjectPmBinding(runtimeConfig: Record<string, unknown> | null | undefined): ProjectPmWorkspaceBinding | null {
  const raw = record(runtimeConfig?.workspaceBinding);
  if (raw.mode !== "project_pm") return null;
  const parsed = agentProjectPmWorkspaceBindingSchema.safeParse(raw);
  return parsed.success ? parsed.data : null;
}

export function readPaperclipPmWorkspaceContext(value: unknown): PaperclipPmWorkspaceContext | null {
  const ctx = record(value);
  if (ctx.version !== 1 || (ctx.role !== "pm" && ctx.role !== "worker")) return null;
  const strings = ["agentHome", "projectId", "workerRoot", "cwd"] as const;
  if (strings.some(key => typeof ctx[key] !== "string" || !(ctx[key] as string))) return null;
  if (ctx.workerIsolation !== "shared" && ctx.workerIsolation !== "worktree") return null;
  if (typeof ctx.workerSlots !== "number" || !Number.isInteger(ctx.workerSlots)) return null;
  if (ctx.workerHostId !== undefined && (typeof ctx.workerHostId !== 'string' || !/^[a-z0-9][a-z0-9_-]{0,63}$/.test(ctx.workerHostId))) return null;
  if (ctx.pmHome !== undefined && (typeof ctx.pmHome !== "string" || !ctx.pmHome.startsWith("/") || !ctx.workerHostId)) return null;
  return {
    version: 1,
    role: ctx.role,
    agentHome: ctx.agentHome as string,
    projectId: ctx.projectId as string,
    workerRoot: ctx.workerRoot as string,
    ...(ctx.workerHostId ? { workerHostId: ctx.workerHostId as string } : {}),
    ...(ctx.pmHome ? { pmHome: ctx.pmHome as string } : {}),
    workerIsolation: ctx.workerIsolation,
    workerSlots: ctx.workerSlots,
    cwd: ctx.cwd as string,
    issueId: typeof ctx.issueId === "string" ? ctx.issueId : null,
    inboxIssueId: typeof ctx.inboxIssueId === "string" ? ctx.inboxIssueId : null,
  };
}

/** Claim-time and write-time project PM failures use reasons prefixed `project_pm_`. */
export function projectPmConflict(reason: string, message: string): never {
  throw Object.assign(new HttpError(422, message, {
    code: "workspace_validation_failed",
    reason: `project_pm_${reason}`,
  }), {
    code: "workspace_validation_failed",
    resultJson: { workspaceValidation: { reason: `project_pm_${reason}` } },
  });
}

export const PROJECT_PM_OUT_OF_BOUNDS_ERROR_CODE = "project_pm_out_of_bounds";

export type ProjectPmIssueFacts = {
  id: string;
  projectId: string | null;
  parentId: string | null;
  assigneeAgentId: string | null;
  status?: string;
  executionState?: unknown;
  verifiedPmWatchdog?: boolean;
};

export type ProjectPmRoleDecision =
  | { outcome: "role"; role: ProjectPmRole }
  | { outcome: "out_of_bounds"; message: string };

/**
 * The authoritative role table: no issue or a top-level project issue is a PM
 * turn; a child issue assigned to the agent is a worker turn; a child issue
 * assigned to someone else is a PM turn; anything outside the project is
 * rejected, unless the binding whitelists `allowCrossProject` (then any issue
 * that belongs to some project is accepted; project-less issues stay rejected
 * because a worker would have no workspace).
 */
export function resolveProjectPmRole(input: {
  binding: Pick<ProjectPmWorkspaceBinding, "projectId" | "allowCrossProject" | "workerSlots">;
  agentId: string;
  issue: ProjectPmIssueFacts | null;
}): ProjectPmRoleDecision {
  const issue = input.issue;
  if (!issue) return { outcome: "role", role: "pm" };
  const crossProjectAllowed = input.binding.allowCrossProject === true && issue.projectId !== null;
  if (issue.projectId !== input.binding.projectId && !crossProjectAllowed) {
    return {
      outcome: "out_of_bounds",
      message: `Issue ${issue.id} is outside the PM agent's project; project PM agents only work on issues of project ${input.binding.projectId}.`,
    };
  }
  if (issue.parentId && issue.assigneeAgentId === input.agentId && !issue.verifiedPmWatchdog && !isPendingExecutionReviewForAgent(issue, input.agentId)) {
    if (input.binding.workerSlots === 0) return {
      outcome: "out_of_bounds",
      message: "This PM only coordinates and reviews. Assign implementation to a separate worker agent.",
    };
    return { outcome: "role", role: "worker" };
  }
  return { outcome: "role", role: "pm" };
}

export function buildPaperclipPmWorkspaceContext(
  binding: ResolvedProjectPmWorkspaceBinding,
  role: ProjectPmRole,
  issueId: string | null,
): PaperclipPmWorkspaceContext {
  return {
    version: 1,
    role,
    agentHome: binding.agentHome,
    projectId: binding.projectId,
    workerRoot: binding.workerRoot,
    ...(binding.workerHostId ? { workerHostId: binding.workerHostId } : {}),
    ...(binding.pmHome ? { pmHome: binding.pmHome } : {}),
    workerIsolation: binding.workerIsolation,
    workerSlots: binding.workerSlots,
    cwd: role === "worker" ? binding.workerRoot : (binding.pmHome ?? binding.agentHome),
    issueId,
    inboxIssueId: binding.inboxIssueId,
  };
}

/** The issue a run is about: the context issue, the wake issue, or a UUID task id. */
export function readProjectPmRunIssueId(context: Record<string, unknown> | null | undefined): string | null {
  const ctx = record(context);
  const nonEmpty = (value: unknown) => typeof value === "string" && value.trim() ? value.trim() : null;
  const uuid = (value: string | null) =>
    value && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value) ? value : null;
  return nonEmpty(ctx.issueId) ??
    nonEmpty(record(record(ctx.paperclipWake).issue).id) ??
    uuid(nonEmpty(ctx.taskId));
}

export async function loadProjectPmIssueFacts(db: Db, companyId: string, issueId: string | null): Promise<ProjectPmIssueFacts | null | "missing"> {
  if (!issueId) return null;
  const [issue] = await db.select({
    id: issues.id,
    projectId: issues.projectId,
    parentId: issues.parentId,
    assigneeAgentId: issues.assigneeAgentId,
    status: issues.status,
    executionState: issues.executionState,
    verifiedPmWatchdog: verifiedPmWatchdogSql(),
  }).from(issues).where(and(eq(issues.id, issueId), eq(issues.companyId, companyId))).limit(1);
  return issue ?? "missing";
}

async function canonicalAgentHome(agentId: string): Promise<string> {
  const home = resolveDefaultAgentWorkspaceDir(agentId);
  await mkdir(home, { recursive: true });
  return realpath(home);
}

async function primaryProjectWorkspaceRealpath(db: Db, companyId: string, projectId: string, workerHostId?: string): Promise<string | null> {
  const [workspace] = await db.select({ cwd: projectWorkspaces.cwd, sourceType: projectWorkspaces.sourceType, metadata: projectWorkspaces.metadata }).from(projectWorkspaces)
    .where(and(eq(projectWorkspaces.projectId, projectId), eq(projectWorkspaces.companyId, companyId)))
    .orderBy(desc(projectWorkspaces.isPrimary), asc(projectWorkspaces.createdAt), asc(projectWorkspaces.id))
    .limit(1);
  if (!workspace?.cwd || !path.isAbsolute(workspace.cwd)) return null;
  if (workerHostId) {
    if (workspace.sourceType !== 'remote_managed' || record(workspace.metadata).hostId !== workerHostId || path.posix.normalize(workspace.cwd) !== workspace.cwd) return null;
    return workspace.cwd; // The adapter verifies existence/canonicalization on the registered remote host before dispatch.
  }
  try {
    const resolved = await realpath(workspace.cwd);
    return (await stat(resolved)).isDirectory() ? resolved : null;
  } catch {
    return null;
  }
}

/**
 * Validate a `project_pm` binding against the agent and its company. Used on
 * create, update and at claim. Returns the binding with the canonical agent home.
 */
export async function resolveProjectPmBinding(db: Db, input: {
  companyId: string;
  agentId: string;
  binding: ProjectPmWorkspaceBinding;
  validateInbox: boolean;
}): Promise<ResolvedProjectPmWorkspaceBinding> {
  const { binding } = input;
  if (binding.workerHostId && binding.workerIsolation !== "shared") {
    projectPmConflict("invalid", "Remote PM workers require shared isolation.");
  }
  // The PM home lives on the worker host; the adapter creates and canonicalizes
  // it there before the PM session starts, so the server only checks its shape.
  if (binding.pmHome !== undefined && !binding.workerHostId) {
    projectPmConflict("invalid", "A native PM home requires a worker host.");
  }
  const agentHome = await canonicalAgentHome(input.agentId).catch(() =>
    projectPmConflict("agent_home_unavailable", "The PM agent home could not be created."));
  if (binding.agentHome !== undefined && binding.agentHome !== agentHome) {
    projectPmConflict("agent_home_mismatch", `The PM agent home must be the agent's canonical home directory ${agentHome}.`);
  }
  const [project] = await db.select({ id: projects.id }).from(projects)
    .where(and(eq(projects.id, binding.projectId), eq(projects.companyId, input.companyId))).limit(1);
  if (!project) projectPmConflict("project_invalid", "The PM project does not exist in the agent's company.");
  const workerRoot = await primaryProjectWorkspaceRealpath(db, input.companyId, binding.projectId, binding.workerHostId);
  if (!workerRoot || workerRoot !== binding.workerRoot) {
    projectPmConflict("worker_root_mismatch", "The PM worker root must equal the canonical path of the project's primary workspace directory.");
  }
  const inboxIssueId = binding.inboxIssueId ?? null;
  if (inboxIssueId && input.validateInbox) {
    const [inbox] = await db.select({
      projectId: issues.projectId,
      parentId: issues.parentId,
      assigneeAgentId: issues.assigneeAgentId,
    }).from(issues).where(and(eq(issues.id, inboxIssueId), eq(issues.companyId, input.companyId))).limit(1);
    if (!inbox || inbox.projectId !== binding.projectId || inbox.parentId !== null || inbox.assigneeAgentId !== input.agentId) {
      projectPmConflict("inbox_invalid", "The PM inbox must be a top-level issue of the PM project, in the same company, assigned to this agent.");
    }
  }
  return {
    mode: "project_pm",
    agentHome,
    projectId: binding.projectId,
    workerRoot: binding.workerRoot,
    ...(binding.workerHostId ? { workerHostId: binding.workerHostId } : {}),
    ...(binding.pmHome ? { pmHome: binding.pmHome } : {}),
    workerIsolation: binding.workerIsolation,
    workerSlots: binding.workerSlots,
    inboxIssueId,
    ...(binding.allowCrossProject ? { allowCrossProject: true } : {}),
  };
}

/**
 * The claim-time context for one role. A whitelisted PM's worker on an issue of
 * another project runs in that project's primary workspace (resolved and
 * checked like the home project's worker root); every other case is the plain
 * binding context.
 */
export async function buildProjectPmRoleContext(db: Db, input: {
  companyId: string;
  binding: ResolvedProjectPmWorkspaceBinding;
  role: ProjectPmRole;
  issue: ProjectPmIssueFacts | null;
}): Promise<PaperclipPmWorkspaceContext> {
  const { binding, role, issue } = input;
  const context = buildPaperclipPmWorkspaceContext(binding, role, issue?.id ?? null);
  if (role !== "worker" || !issue?.projectId || issue.projectId === binding.projectId) return context;
  if (!binding.allowCrossProject) {
    projectPmConflict("out_of_bounds", "The PM binding does not allow issues of other projects.");
  }
  const workerRoot = await primaryProjectWorkspaceRealpath(db, input.companyId, issue.projectId, binding.workerHostId);
  if (!workerRoot) {
    projectPmConflict("worker_root_mismatch", `Project ${issue.projectId} has no usable primary workspace directory for a cross-project worker.`);
  }
  return { ...context, projectId: issue.projectId, workerRoot, cwd: workerRoot };
}

/** Durable source evidence, independent of caller-provided wake or conversation flags. */
export async function isExternalWorkspaceTask(db: Db, companyId: string, issueId: string | null): Promise<boolean> {
  if (!issueId) return false;
  const [issue] = await db.select({
    external: sql<boolean>`${issues.originKind} = 'chat_channel' or exists (
      select 1 from ${chatConversations} c where c.issue_id = ${issues.id} and c.company_id = ${companyId}
    )`,
  }).from(issues).where(and(eq(issues.id, issueId), eq(issues.companyId, companyId))).limit(1);
  if (!issue) {
    workspaceBindingConflict("issue_unavailable", "Fixed workspace task is unavailable in this company.", { issueId });
    return false;
  }
  return issue.external;
}

/**
 * Report isolation and provisioning mismatches of a fixed directory. Advisory
 * only: each mismatch is logged and the fixed directory is still used.
 */
export function assertFixedWorkspacePolicy(input: {
  binding: FixedWorkspaceBinding; environment: { driver: string; config: Record<string, unknown> } | null;
  trustPreset: string; mode: string; external: boolean; isDot: boolean; strategies: unknown[];
}): string[] {
  const mismatches: string[] = [];
  const note = (reason: string, message: string) =>
    mismatches.push(workspaceBindingConflict(reason, message, { cwd: input.binding.cwd }));
  if (input.trustPreset === "low_trust_review" || input.external) {
    note("isolation_required", "External chat and low-trust tasks prefer isolation over an agent's fixed working directory.");
  }
  if (["isolated_workspace", "operator_branch"].includes(input.mode)) {
    note("policy_conflict", "This task requests an isolated workspace or branch, conflicting with the fixed working directory.");
  }
  const environment = input.environment;
  if (input.isDot || !environment || !["local", "ssh"].includes(environment.driver)) {
    note("environment_conflict", "The selected environment does not support fixed in-place execution.");
  }
  if (input.binding.projectPm && environment && environment.driver !== "local") {
    note("environment_conflict", "Project PM agents run on a local path only.");
  }
  if (input.binding.hostId && environment && environment.driver !== "local") {
    note("environment_conflict", "A remote-host fixed directory is reached through the CC Pocket host; select the local environment.");
  }
  if (environment?.driver === "ssh" && (environment.config.workspaceMode !== "in_place" || environment.config.remoteWorkspacePath !== input.binding.cwd)) {
    note("environment_conflict", "SSH fixed execution expects in_place mode and the exact configured remote workspace path.");
  }
  for (const value of input.strategies) {
    if (!value || typeof value !== "object") continue;
    const strategy = value as Record<string, unknown>;
    if ((strategy.type && strategy.type !== "project_primary") ||
        ["provisionCommand", "runtimeProvisionCommand", "teardownCommand", "cleanupCommand"].some(key => strategy[key])) {
      note("provisioning_conflict", "Fixed working directories do not use workspace provisioning, cleanup or worktree strategies.");
      break;
    }
  }
  return mismatches;
}

/** Advisory: a project directory that differs from the fixed directory is logged only. */
export function assertFixedProjectWorkspace(binding: FixedWorkspaceBinding, workspace: { cwd: string | null; sourceType?: string | null } | null, configured: boolean): string[] {
  const mismatches: string[] = [];
  if (configured && (!workspace?.cwd || path.posix.normalize(workspace.cwd).replace(/\/$/, "") !== path.posix.normalize(binding.cwd).replace(/\/$/, ""))) {
    mismatches.push(workspaceBindingConflict("project_conflict", "The selected project's working directory differs from the agent's fixed working directory.",
      { cwd: binding.cwd, projectCwd: workspace?.cwd ?? null }));
  }
  if (binding.hostId && configured && workspace?.sourceType !== "remote_managed") {
    mismatches.push(workspaceBindingConflict("project_conflict", "A remote-host fixed directory expects the project's remote-managed source.", { cwd: binding.cwd }));
  }
  return mismatches;
}

/**
 * A remote-host fixed directory is never inspected on the controller; the CC
 * Pocket host creates it. Adapter, host and path-shape mismatches are logged only.
 */
export function assertRemoteFixedBinding(binding: FixedWorkspaceBinding, agent: { adapterType: string; adapterConfig: unknown }): string[] {
  if (!binding.hostId) return [];
  const mismatches: string[] = [];
  if (agent.adapterType !== "ccpocket_bridge") mismatches.push(workspaceBindingConflict("environment_conflict", "Remote-host fixed directories require the CC Pocket adapter.", { cwd: binding.cwd }));
  if (record(agent.adapterConfig).hostId !== binding.hostId) mismatches.push(workspaceBindingConflict("environment_conflict", "The agent's CC Pocket host differs from its fixed directory's host.", { cwd: binding.cwd }));
  if (path.posix.normalize(binding.cwd) !== binding.cwd || binding.cwd.endsWith("/")) mismatches.push(workspaceBindingConflict("path_alias", "The remote working directory is not canonical.", { cwd: binding.cwd }));
  return mismatches;
}

/**
 * Create the fixed local directory when missing (`mkdir -p`). Returns false only
 * when it cannot be used (for example the path is a file); the caller then falls
 * back to the next directory. A symbolic alias is logged and still used.
 */
export async function ensureFixedLocalDirectory(binding: FixedWorkspaceBinding): Promise<boolean> {
  if (!path.isAbsolute(binding.cwd)) {
    workspaceBindingConflict("path_unavailable", "The fixed working directory is not an absolute path.", { cwd: binding.cwd });
    return false;
  }
  try {
    await mkdir(binding.cwd, { recursive: true });
    if (!(await stat(binding.cwd)).isDirectory()) throw new Error("not a directory");
    if (await realpath(binding.cwd) !== path.resolve(binding.cwd)) {
      workspaceBindingConflict("path_alias", "The fixed working directory is a symbolic path alias.", { cwd: binding.cwd });
    }
    return true;
  } catch (error) {
    workspaceBindingConflict("path_unavailable", "The fixed working directory could not be created or is not a directory.",
      { cwd: binding.cwd, err: error });
    return false;
  }
}

export type ProjectPmRunWorkspace =
  | { outcome: "none" }
  | { outcome: "workspace"; workspace: PaperclipPmWorkspaceContext }
  | { outcome: "out_of_bounds"; issueId: string | null; message: string };

/**
 * Resolve the role and cwd of one run of a `project_pm` agent from current
 * issue state. Configuration errors throw `workspace_validation_failed`; an
 * issue outside the project is reported as `out_of_bounds` for a terminal cancel.
 */
export async function resolveProjectPmRunWorkspace(db: Db, input: {
  agent: { id: string; companyId: string; runtimeConfig: Record<string, unknown> | null | undefined };
  context: Record<string, unknown>;
  /** The role the queue assigned at claim for this run's issue; it wins over the current issue state. */
  claimedRole?: ProjectPmRole | null;
}): Promise<ProjectPmRunWorkspace> {
  const raw = record(input.agent.runtimeConfig?.workspaceBinding);
  if (raw.mode !== "project_pm") return { outcome: "none" };
  const parsed = agentProjectPmWorkspaceBindingSchema.safeParse(raw);
  if (!parsed.success) {
    projectPmConflict("invalid", "The project PM binding is invalid. Reconfigure it with an absolute worker root, a project and 0-4 worker slots.");
  }
  const binding = await resolveProjectPmBinding(db, {
    companyId: input.agent.companyId,
    agentId: input.agent.id,
    binding: parsed.data,
    validateInbox: false,
  });
  const issueId = readProjectPmRunIssueId(input.context);
  const issue = await loadProjectPmIssueFacts(db, input.agent.companyId, issueId);
  if (issue === "missing") {
    return { outcome: "out_of_bounds", issueId, message: `Issue ${issueId} is not available in the PM agent's company.` };
  }
  const decision = resolveProjectPmRole({ binding, agentId: input.agent.id, issue });
  if (decision.outcome === "out_of_bounds") return { outcome: "out_of_bounds", issueId, message: decision.message };
  const role = input.claimedRole ?? decision.role;
  if (role === "worker" && binding.workerSlots === 0) return {
    outcome: "out_of_bounds", issueId,
    message: "This PM only coordinates and reviews. A previously claimed worker role is no longer permitted.",
  };
  return { outcome: "workspace", workspace: await buildProjectPmRoleContext(db, { companyId: input.agent.companyId, binding, role, issue }) };
}
