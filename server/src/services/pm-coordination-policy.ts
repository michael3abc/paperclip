import { aiConnectionBindingSchema } from "@paperclipai/shared";
import { pmWorkerModels } from "./pm-worker-catalog.js";
import { isDeepStrictEqual } from "node:util";
import { workerSelectionOverrides, workerPermissionChoices, validateWorkerChoices } from "./pm-worker-options.js";
import { pmWorkerPolicySchema, pmWorkerManagedBlock, renderPmWorkerPolicy } from "@paperclipai/shared";
import { and, eq } from "drizzle-orm";
import { agents, issues, issueApprovals, heartbeatRuns, projectWorkspaces, executionWorkspaces, type Db } from "@paperclipai/db";
import { z } from "zod";
import { forbidden, unprocessable } from "../errors.js";
import { agentProjectPmWorkspaceBindingSchema, issueExecutionPolicySchema, taskWorkspaceSelectionSchema } from "@paperclipai/shared";

/** A platform capability boundary, independent of prompts and provider approvals. */
export const PM_COORDINATION_VERSION = 1 as const;
export const PM_BUNDLE_FILES = ["AGENTS.md", "PROJECT.md", "WORKERS.md", "REVIEW.md", "memory/decisions.md", "memory/handoff.md"] as const;
export const PM_EDITABLE_BUNDLE_FILES = new Set<string>(PM_BUNDLE_FILES.filter(path => path !== "AGENTS.md"));
export const PM_READ_TOOLS = new Set([
  "get_identity", "get_task_context", "get_task_history", "search_tasks", "read_current_wake_comments", "list_assigned_skills", "read_assigned_skill",
  "list_documents", "read_document", "list_document_revisions", "list_agents", "get_agent",
  "list_projects", "list_project_repositories", "get_workspace", "list_workspaces",
  "get_task", "read_task_history", "read_task_document", "list_task_documents",
  "list_approvals", "get_approval", "get_approval_context", "read_tool_result",
  "list_chat_attachments", "read_chat_attachment", "read_bundle_file", "search_api", "call_api",
  "list_task_attachments", "read_task_attachment",
]);
export const PM_WRITE_TOOLS = new Set([
  "create_task", "reassign_task", "set_dependencies", "set_task_title", "write_document",
  "comment_on_task", "write_task_document", "report_progress", "request_human_input",
  "request_approval", "request_review", "resolve_review", "write_bundle_file",
  "finish_task", "block_task", "paperclip_finish", "paperclip_block",
]);

const selection = z.object({
  model: z.string().min(1),
  effort: z.enum(["low", "medium", "high", "xhigh", "max"]).optional(),
  modelReasoningEffort: z.enum(["minimal", "low", "medium", "high", "xhigh"]).optional(),
  fastMode: z.boolean().optional(),
}).strict();
/** Owner-maintained copy of the accepted model table; editable Markdown never grants authority. */
const legacyPmDelegationSchema = z.object({
  version: z.literal(1),
  workers: z.array(z.object({ agentId: z.string().uuid(), selections: z.array(selection).min(1) }).strict()).min(1).max(2),
}).strict();
export const pmDelegationSchema = z.union([legacyPmDelegationSchema, pmWorkerPolicySchema]);
export type PmDelegation = z.infer<typeof pmDelegationSchema>;
type Agent = { id: string; companyId: string; runtimeConfig: Record<string, unknown> | null };
export type PmCoordinationScope = { agentId: string; companyId: string; projectId: string; workerRoot: string; delegation: PmDelegation | null };

export function pmCoordinationScope(agent: Agent): PmCoordinationScope | null {
  const raw = agent.runtimeConfig?.workspaceBinding as { mode?: string } | undefined;
  if (raw?.mode !== "project_pm") return null;
  const result = agentProjectPmWorkspaceBindingSchema.safeParse(raw);
  if (!result.success) {
    throw unprocessable("Invalid project PM binding", { code: "PM_BINDING_INVALID" });
  }
  const binding = result.data;
  if (binding.workerSlots !== 0) return null;
  const configured = agent.runtimeConfig?.pmDelegation;
  const parsed = configured === undefined ? null : pmDelegationSchema.safeParse(configured);
  if (parsed && !parsed.success) throw unprocessable("The PM delegation policy is invalid", { code: "PM_DELEGATION_INVALID" });
  return { agentId: agent.id, companyId: agent.companyId, projectId: binding.projectId,
    workerRoot: binding.workerRoot, delegation: parsed?.success ? parsed.data : null };
}

export async function currentPmCoordinationScope(db: Db, identity: { companyId: string; agentId: string }) {
  const [agent] = await db.select({ id: agents.id, companyId: agents.companyId, runtimeConfig: agents.runtimeConfig })
    .from(agents).where(and(eq(agents.id, identity.agentId), eq(agents.companyId, identity.companyId))).limit(1);
  if (!agent) throw forbidden("Agent identity is unavailable");
  return pmCoordinationScope(agent);
}

export function assertPmTool(scope: PmCoordinationScope, tool: string) {
  if (!PM_READ_TOOLS.has(tool) && !PM_WRITE_TOOLS.has(tool)) {
    throw forbidden("PMs coordinate and review; delegate this operation to an authorized worker", { code: "PM_TOOL_DENIED", tool });
  }
}

export async function assertPmIssue(db: Db, scope: PmCoordinationScope, issueId: string) {
  const [issue] = await db.select().from(issues).where(and(eq(issues.id, issueId), eq(issues.companyId, scope.companyId))).limit(1);
  if (!issue || issue.projectId !== scope.projectId) throw forbidden("The task is outside this PM's project", { code: "PM_PROJECT_DENIED" });
  return issue;
}

export function assertPmWorkerSelection(scope: PmCoordinationScope, agentId: unknown, overrides: unknown) {
  if (scope.delegation?.version === 2) {
    const input = z.object({ aiConnection: aiConnectionBindingSchema.optional(), workerSelectionId: z.string().uuid().optional(), adapterConfig: z.record(z.string(), z.unknown()).optional() }).strict().safeParse(overrides ?? {});
    if (!input.success) throw forbidden("Choose a worker selection; arbitrary task overrides are not allowed", { code: "PM_MODEL_DENIED" });
    const choices = scope.delegation.workers.flatMap(worker => worker.selections.map(choice => ({ worker, choice })));
    const selected = input.data.workerSelectionId
      ? choices.find(item => item.choice.id === input.data.workerSelectionId)
      : input.data.adapterConfig
        ? choices.find(item => item.worker.agentId === agentId && isDeepStrictEqual(workerSelectionOverrides(item.worker.harness, item.choice), input.data.adapterConfig))
        : choices.find(item => item.choice.id === (scope.delegation as import("@paperclipai/shared").PmWorkerPolicy).defaultSelectionId);
    if (!selected || (agentId != null && agentId !== selected.worker.agentId)) throw forbidden("Select an authorized shared worker", { code: "PM_WORKER_DENIED" });
    const adapterConfig = workerSelectionOverrides(selected.worker.harness, selected.choice);
    if (input.data.adapterConfig && !isDeepStrictEqual(adapterConfig, input.data.adapterConfig)) throw forbidden("Task overrides differ from the selected worker policy", { code: "PM_MODEL_DENIED" });
    if (input.data.aiConnection && !isDeepStrictEqual(input.data.aiConnection, selected.choice.aiConnection)) throw forbidden("Task connection differs from the Owner-selected worker option", { code: "PM_MODEL_DENIED" });
    return { adapterConfig, workerSelectionId: selected.choice.id, ...(selected.choice.aiConnection ? { aiConnection: selected.choice.aiConnection } : {}) };
  }
  const worker = scope.delegation?.workers.find(worker => worker.agentId === agentId);
  if (!worker) throw forbidden("Select a shared worker from the Owner-approved delegation policy", { code: "PM_WORKER_DENIED" });
  const wrapper = z.object({ adapterConfig: selection }).strict().safeParse(overrides);
  if (!wrapper.success || !worker.selections.some(allowed =>
    JSON.stringify(Object.entries(allowed).sort()) === JSON.stringify(Object.entries(wrapper.data.adapterConfig).sort()))) {
    throw forbidden("Select an exact authorized model and effort combination; worker defaults cannot replace the project model table", { code: "PM_MODEL_DENIED" });
  }
  return wrapper.data;
}

export async function assertPmDispatch(db: Db, scope: PmCoordinationScope, input: {
  projectId?: unknown; assigneeAgentId?: unknown; assigneeUserId?: unknown; assigneeAdapterOverrides?: unknown;
  executionWorkspaceSettings?: unknown; workspaceSelection?: unknown;
}, options: { existingTask?: boolean } = {}) {
  if (!options.existingTask && scope.delegation?.version !== 2) throw unprocessable("Configure PM worker settings before new dispatch; historical worker lists are not a dispatch fallback", { code: "PM_WORKER_MIGRATION_REQUIRED" });
  if (input.projectId !== scope.projectId || input.assigneeUserId != null) throw forbidden("PM execution tasks must remain in their project and use a shared worker", { code: "PM_DISPATCH_DENIED" });
  const overrides = assertPmWorkerSelection(scope, input.assigneeAgentId, input.assigneeAdapterOverrides);
  if (scope.delegation?.version === 2) {
    const { agentInstructionsService } = await import("./agent-instructions.js");
    const [owner] = await db.select().from(agents).where(and(eq(agents.id, scope.agentId), eq(agents.companyId, scope.companyId)));
    if (!owner || !isDeepStrictEqual(owner.runtimeConfig?.pmDelegation, scope.delegation)) throw forbidden("PM worker policy changed; read current settings before dispatch");
    const document = await agentInstructionsService(db).readFile(owner, "WORKERS.md");
    if (pmWorkerManagedBlock(document.content ?? "") !== renderPmWorkerPolicy(scope.delegation)) throw unprocessable("WORKERS.md and worker policy are out of sync; save the policy before dispatch", { code: "PM_WORKER_DOCUMENT_OUT_OF_SYNC" });
    const selected = scope.delegation.workers.find(worker => worker.selections.some(choice => choice.id === (overrides as { workerSelectionId?: string }).workerSelectionId))!;
    input.assigneeAgentId = selected.agentId;
    input.assigneeAdapterOverrides = overrides;
  }

  if (input.executionWorkspaceSettings != null && Object.keys(input.executionWorkspaceSettings).some(key => !["mode", "sharedWorkspaceConcurrency"].includes(key))) {
    throw forbidden("PM dispatch may select a configured workspace, but cannot change runtime, environment or network grants", { code: "PM_WORKSPACE_POLICY_DENIED" });
  }
  if (input.workspaceSelection != null) {
    const selected = taskWorkspaceSelectionSchema.parse(input.workspaceSelection);
    if (selected.kind === "configured_source") {
      const [source] = await db.select({ projectId: projectWorkspaces.projectId }).from(projectWorkspaces)
        .where(and(eq(projectWorkspaces.id, selected.projectWorkspaceId), eq(projectWorkspaces.companyId, scope.companyId))).limit(1);
      if (source?.projectId !== scope.projectId) throw forbidden("Workspace source is outside this PM's project", { code: "PM_PROJECT_DENIED" });
    } else if (selected.kind === "existing") {
      const [workspace] = await db.select({ projectId: executionWorkspaces.projectId }).from(executionWorkspaces)
        .where(and(eq(executionWorkspaces.id, selected.workspaceId), eq(executionWorkspaces.companyId, scope.companyId))).limit(1);
      if (workspace?.projectId !== scope.projectId) throw forbidden("Workspace is outside this PM's project", { code: "PM_PROJECT_DENIED" });
    }
  }
  const [worker] = await db.select().from(agents).where(and(eq(agents.id, String(input.assigneeAgentId)), eq(agents.companyId, scope.companyId))).limit(1);
  if (!worker || !["claude_local", "codex_local"].includes(worker.adapterType) || worker.runtimeConfig?.requireTaskWorktree !== true
    || ["paused", "terminated", "pending_approval"].includes(worker.status)) {
    throw forbidden("The selected shared worker is unavailable; inspect its recorded status", { code: "PM_WORKER_UNAVAILABLE" });
  }
  if (scope.delegation?.version === 2) {
    const group = scope.delegation.workers.find(item => item.agentId === worker.id)!;
    const choice = group.selections.find(item => item.id === (overrides as { workerSelectionId?: string }).workerSelectionId)!;

    const parsedBinding = aiConnectionBindingSchema.safeParse(worker.runtimeConfig?.aiConnection).data;
    validateWorkerChoices({ version: 2, defaultSelectionId: choice.id, workers: [{ ...group, selections: [choice] }] }, [{
      agentId: worker.id, name: worker.name, harness: group.harness,
      permissions: workerPermissionChoices(worker.adapterConfig ?? {}), defaultAiConnection: parsedBinding?.mode === "responsible_user" ? undefined : parsedBinding, models: await pmWorkerModels(db, worker, choice.aiConnection),
    }]);
    if (group.harness !== worker.adapterType || !workerPermissionChoices(worker.adapterConfig ?? {}).includes(choice.permission)) {
      throw forbidden("Shared worker harness or permission support changed; review its worker settings");
    }
  }
  return { assigneeAgentId: String(input.assigneeAgentId), assigneeAdapterOverrides: overrides };
}

/** Preserve source gates; PM-provided workflow settings cannot grant execution authority. */
export function pmDispatchExecutionPolicy(scope: PmCoordinationScope, requested: unknown, source: unknown) {
  const raw = requested as Record<string, unknown> | null | undefined;
  if (raw && Object.keys(raw).some(key => !["requiredQualityReview", "mode", "commentRequired", "stages", "maxReviewRounds"].includes(key))) {
    throw forbidden("PM dispatch cannot override trust, authorization or service monitoring policy", { code: "PM_REVIEW_POLICY_DENIED" });
  }
  const base = issueExecutionPolicySchema.parse(source ?? {});
  const chosen = issueExecutionPolicySchema.parse(raw ?? {});
  if (chosen.mode !== "normal" || !chosen.commentRequired || chosen.stages.some(stage =>
    stage.participants.some(participant => participant.type === "agent" && participant.agentId !== scope.agentId))) {
    throw forbidden("PM dispatch requires normal review and cannot assign another agent as approver", { code: "PM_REVIEW_POLICY_DENIED" });
  }
  const stages = [...base.stages];
  for (const stage of chosen.stages) {
    if (!stages.some(existing => JSON.stringify(existing) === JSON.stringify(stage))) stages.push(stage);
  }
  if (!stages.some(stage => stage.type === "review" && stage.participants.length === 1 && stage.participants[0]?.agentId === scope.agentId)) {
    stages.push({ type: "review", approvalsNeeded: 1, participants: [{ type: "agent", agentId: scope.agentId }] });
  }
  const deliverables = new Map(base.requiredQualityReview?.deliverables.map(item => [item.key, item]) ?? []);
  for (const item of chosen.requiredQualityReview?.deliverables ?? []) {
    const existing = deliverables.get(item.key);
    if (existing && existing.label !== item.label) throw forbidden("An inherited quality requirement cannot be replaced");
    deliverables.set(item.key, item);
  }
  return issueExecutionPolicySchema.parse({ ...base, mode: "normal", commentRequired: true, stages,
    ...(chosen.maxReviewRounds != null ? { maxReviewRounds: chosen.maxReviewRounds } : {}),
    ...(deliverables.size ? { requiredQualityReview: { version: 1, deliverables: [...deliverables.values()] } } : {}),
  });
}

export async function assertPmRun(db: Db, scope: PmCoordinationScope, runId: string) {
  const [run] = await db.select().from(heartbeatRuns).where(and(eq(heartbeatRuns.id, runId),
    eq(heartbeatRuns.companyId, scope.companyId), eq(heartbeatRuns.agentId, scope.agentId))).limit(1);
  if (!run || run.status !== "running" || !run.nativeIssueId) throw forbidden("PM operation requires its current running task", { code: "PM_RUN_DENIED" });
  const issue = await assertPmIssue(db, scope, run.nativeIssueId);
  return { run, issue };
}

export async function assertPmApproval(db: Db, scope: PmCoordinationScope, approvalId: string) {
  const linked = await db.select({ projectId: issues.projectId }).from(issueApprovals)
    .innerJoin(issues, eq(issues.id, issueApprovals.issueId)).where(and(eq(issueApprovals.approvalId, approvalId), eq(issueApprovals.companyId, scope.companyId)));
  if (!linked.length || linked.some(issue => issue.projectId !== scope.projectId)) throw forbidden("Approval is outside this PM's project", { code: "PM_PROJECT_DENIED" });
}
