import { isDeepStrictEqual } from "node:util";
import { and, eq } from "drizzle-orm";
import { agents, heartbeatRuns, issues, issueThreadInteractions, projects, toolOauthStates, type Db } from "@paperclipai/db";
import { aiRuntimeConnectionBindingSchema, connectionIntentPayloadSchema, isAiConnectionCompatible, AI_CONNECTION_CAPABILITIES, aiProviderSchema } from "@paperclipai/shared";
import { parseObject } from "../adapters/utils.js";
import { parseIssueAssigneeAdapterOverrides } from "./execution-workspace-policy.js";
import { isPendingExecutionReviewForAgent } from "./issue-execution-policy.js";
import { parseProjectWorkerPolicy, resolveWorkerOverrides } from "./project-worker-policy.js";
import { notifyIssueReviewState } from "./issue-review-state-notifications.js";
import { notifyChatConfirmationResolution } from "./chat-confirmation-notifications.js";
import type { ActivityPublication } from "./activity-log.js";
import { aiConnectionRequirementIdentity } from "./ai-auth-failure.js";

async function obsoleteReason(db: Db, task: typeof issues.$inferSelect, intent: typeof issueThreadInteractions.$inferSelect) {
  const payload = connectionIntentPayloadSchema.safeParse(intent.payload);
  if (!payload.success || payload.data.purpose !== "ai") return null;
  if (["done", "cancelled"].includes(task.status)) return "The task closed before AI authentication was completed.";
  if (task.assigneeAgentId !== payload.data.requestingAgentId || task.assigneeUserId) {
    return "The requesting agent no longer executes this task.";
  }
  const [agent] = await db.select().from(agents).where(and(eq(agents.id, payload.data.requestingAgentId),
    eq(agents.companyId, task.companyId))).for("share");
  if (!agent) return null;
  // Pending review remains the reviewer's role even while authentication has
  // blocked the task. Never apply the original worker's task configuration.
  const reviewing = isPendingExecutionReviewForAgent(task, agent.id);
  let overrides = reviewing ? null : parseIssueAssigneeAdapterOverrides(task.assigneeAdapterOverrides);
  if (!reviewing && !overrides?.adapterConfig && parseObject(task.assigneeAdapterOverrides).workerSelectionId) {
    const { expandStoredWorkerSelection } = await import("./worker-selection-expansion.js");
    const expanded = await expandStoredWorkerSelection(db, agent, task.assigneeAdapterOverrides);
    if (expanded) overrides = { ...overrides, useProjectWorkspace: overrides?.useProjectWorkspace ?? null,
      adapterConfig: expanded.adapterConfig, aiConnection: overrides?.aiConnection ?? expanded.aiConnection as NonNullable<typeof overrides>["aiConnection"] };
    // An unresolved selection is not evidence that the agent default applies.
    else return null;
  }
  const [project] = overrides?.adapterConfig && task.projectId ? await db.select({ workerPolicy: projects.workerPolicy }).from(projects)
    .where(and(eq(projects.id, task.projectId), eq(projects.companyId, task.companyId))) : [];
  const effective = resolveWorkerOverrides(parseProjectWorkerPolicy(project?.workerPolicy), overrides?.adapterConfig);
  if (effective.violations.length) return null;
  const config = { ...agent.adapterConfig, ...effective.adapterConfig };
  const rawBinding = overrides?.aiConnection ?? agent.runtimeConfig.aiConnection;
  const parsedBinding = aiRuntimeConnectionBindingSchema.safeParse(rawBinding);
  if (rawBinding != null && !parsedBinding.success) return null;
  const binding = parsedBinding.data;
  if (agent.adapterType === "paperclip_runner" && config.homeMode === "preconfigured") {
    return "The current execution uses its preconfigured AI authentication.";
  }
  const [source] = intent.sourceRunId ? await db.select().from(heartbeatRuns).where(and(
    eq(heartbeatRuns.id, intent.sourceRunId), eq(heartbeatRuns.companyId, task.companyId),
    eq(heartbeatRuns.agentId, agent.id))) : [];
  const sourceIssueId = source?.issueId ?? source?.nativeIssueId ?? source?.contextSnapshot?.issueId ?? source?.contextSnapshot?.taskId;
  const sourceContext = sourceIssueId === task.id ? source?.contextSnapshot : null;
  // A router's current selection cannot be inferred from a personal default or
  // another run. A changed pool, however, proves that this allocation was replaced.
  if (binding?.mode === "router") {
    const pool = parseObject(sourceContext?.aiRouterSelection).poolId;
    return typeof pool === "string" && pool !== binding.connectionId
      ? "The task's AI routing pool was replaced." : null;
  }
  if (binding && binding.provider !== payload.data.serviceSlug) return "The current task execution requires another AI provider.";
  const provider = aiProviderSchema.safeParse(payload.data.serviceSlug).data;
  if (provider && !Object.keys(AI_CONNECTION_CAPABILITIES[provider].methods).some(method =>
    isAiConnectionCompatible(binding ?? { provider, method: method as "subscription" | "api_key" }, agent.adapterType, config.model, config.provider, config.acpxAgent))) {
    return "The current task harness and model no longer use this AI provider.";
  }
  const previous = parseObject(sourceContext?.aiConnectionRequirement);
  const previousBinding = aiRuntimeConnectionBindingSchema.safeParse(previous.binding);
  const validPrevious = previous.version === 1 && typeof previous.adapterType === "string"
    && ["model", "provider", "acpxAgent", "homeMode"].every(key => previous[key] === null || typeof previous[key] === "string")
    && (previous.binding === null || previousBinding.success);
  if (validPrevious && !isDeepStrictEqual(previous, aiConnectionRequirementIdentity(agent.adapterType, config, binding))) {
    return "The task's AI execution configuration was replaced.";
  }
  return null;
}

/** Event/read-triggered cleanup of the exact observed cards. No wake or grant. */
export async function expireInapplicableAiConnectionIntents(db: Db, candidates: Array<{ id: string; kind: string; status: string; payload: unknown }>) {
  const ids = candidates.filter(row => row.kind === "connection_intent" && row.status === "pending"
    && parseObject(row.payload).purpose === "ai").map(row => row.id).sort();
  const expired = new Map<string, typeof issueThreadInteractions.$inferSelect>();
  if (!ids.length) return expired;
  const { logActivity, publishActivity } = await import("./activity-log.js");
  for (const id of ids) {
    const publications: ActivityPublication[] = [];
    const [candidate] = await db.select().from(issueThreadInteractions).where(eq(issueThreadInteractions.id, id));
    if (!candidate) continue;
    const row = await db.transaction(async tx => {
      const client = tx as unknown as Db;
      const [task] = await tx.select().from(issues).where(and(eq(issues.id, candidate.issueId), eq(issues.companyId, candidate.companyId))).for("update");
      const [intent] = await tx.select().from(issueThreadInteractions).where(and(eq(issueThreadInteractions.id, id),
        eq(issueThreadInteractions.companyId, candidate.companyId))).for("update");
      if (!task || !intent) return null;
      if (intent.status !== "pending") return intent;
      const reason = await obsoleteReason(client, task, intent);
      if (!reason) return null;
      await notifyIssueReviewState(tx, intent);
      await notifyChatConfirmationResolution(tx, intent);
      const now = new Date();
      const [retired] = await tx.update(issueThreadInteractions).set({ status: "expired",
        result: { version: 1, outcome: "expired", reason }, resolvedAt: now, updatedAt: now })
        .where(and(eq(issueThreadInteractions.id, id), eq(issueThreadInteractions.status, "pending"))).returning();
      if (!retired) return null;
      await tx.delete(toolOauthStates).where(eq(toolOauthStates.interactionId, id));
      // Loading a terminal row does not re-enter reconciliation.
      const { issueThreadInteractionService } = await import("./issue-thread-interactions.js");
      const { enqueueTerminalIssueInteractionChatPublications } = await import("./chat-interaction-publications.js");
      const interaction = await issueThreadInteractionService(client).getById(id);
      if (interaction) await enqueueTerminalIssueInteractionChatPublications(client, interaction);
      await tx.update(issues).set({ updatedAt: now }).where(eq(issues.id, task.id));
      await logActivity(client, { companyId: task.companyId, actorType: "system", actorId: "connection-applicability",
        action: "issue.thread_interaction_resolved", entityType: "issue", entityId: task.id,
        details: { interactionId: id, interactionKind: "connection_intent", status: "expired", resolutionSource: "obsolete_ai_requirement" } }, publications);
      return retired;
    });
    for (const publication of publications) publishActivity(publication);
    if (row) expired.set(id, row);
  }
  return expired;
}
