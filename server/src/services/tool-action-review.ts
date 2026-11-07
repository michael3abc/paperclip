import { notifyChatRunMilestones } from "./chat-run-milestone-notifications.js";
import { notifyToolReviewChange } from "./tool-review-work-notifications.js";
import { notifyDeliveryWork, DELIVERY_QUEUES } from "./delivery-work-notifications.js";
import { and, eq } from "drizzle-orm";
import {
  issues,
  issueThreadInteractions,
  toolActionRequests,
  toolInvocations,
  toolActionDeliveries,
  type Db,
} from "@paperclipai/db";
import { conflict, forbidden, notFound } from "../errors.js";
import { assertIssueThreadInteractionResolverAudience } from "./issue-thread-interaction-resolution.js";
import { emitConnectionInvoked } from "./connector-telemetry.js";
import { toolAccessPolicyService } from "./tool-access-policy.js";
import { assertDelegatedDecisionActor, decisionFingerprint, readDecisionDelegation } from "./delegated-decision-policy.js";

export type ToolReviewActor = { agentId?: string | null; userId?: string | null; runId?: string | null; delegationRevision?: string; reason?: string };

export async function assertDelegatedToolReview(db: Db, interactionId: string | null, companyId: string, actor: ToolReviewActor, rememberAction = false, recovery = false) {
  if (!actor.agentId) return;
  if (!interactionId || rememberAction) throw forbidden("Delegated tool reviews cannot grant persistent permissions");
  const [interaction] = await db.select().from(issueThreadInteractions).where(and(eq(issueThreadInteractions.id, interactionId), eq(issueThreadInteractions.companyId, companyId))).limit(1);
  const context = interaction?.delegation;
  if (!interaction || !context || context.level !== "delegate" || !context.requiredScopes.includes("external_writes")) throw forbidden("This tool action is reserved for a human");
  if (recovery) {
    const grant = await readDecisionDelegation(db, companyId);
    if (interaction.status !== "accepted" || interaction.resolvedByAgentId !== actor.agentId || !interaction.resolvedByRunId
      || !grant || grant.id !== context.grantId || grant.scope.revision !== context.grantRevision
      || context.recipientAgentId !== actor.agentId || context.reservedReasons.length
      || !context.requiredScopes.every(scope => grant.scope.scopes.includes(scope))
      || context.sourceFingerprint !== decisionFingerprint({ kind: interaction.kind, payload: interaction.payload, sourceRunId: interaction.sourceRunId })) throw forbidden("The committed delegated tool decision is no longer authorized");
    return;
  }
  if (!actor.runId || !actor.delegationRevision || !actor.reason?.trim()) throw forbidden("Delegated tool reviews require a current run, revision and reason");
  await assertDelegatedDecisionActor(db, { companyId, agentId: actor.agentId, runId: actor.runId,
    revision: actor.delegationRevision, context,
    fingerprint: decisionFingerprint({ kind: interaction.kind, payload: interaction.payload, sourceRunId: interaction.sourceRunId }) });
}
import {
  logActivity,
  publishActivity,
  type ActivityPublication,
} from "./activity-log.js";

/** The shared transaction for both task and Connections review decisions. */
export async function commitToolActionReview(
  db: Db,
  input: {
    companyId: string;
    actionRequestId: string;
    issueId?: string;
    interactionId?: string;
    decision: "approved" | "rejected";
    rememberAction?: boolean;
    reason?: string;
    actor: ToolReviewActor;
  },
) {
  const [source] = await db
    .select()
    .from(toolActionRequests)
    .where(
      and(
        eq(toolActionRequests.id, input.actionRequestId),
        eq(toolActionRequests.companyId, input.companyId),
      ),
    )
    .limit(1);
  if (!source) throw notFound("Tool action request not found");
  if ((input.issueId || input.interactionId) && (!input.issueId || !input.interactionId || source.issueId !== input.issueId || source.interactionId !== input.interactionId)) {
    throw conflict("Tool action request does not belong to this interaction");
  }
  const publications: ActivityPublication[] = [];
  const result = await db.transaction(async (tx) => {
    const [issue] = source.issueId
      ? await tx
          .select()
          .from(issues)
          .where(
            and(
              eq(issues.id, source.issueId),
              eq(issues.companyId, input.companyId),
            ),
          )
          .for("update")
      : [];
    const [interaction] = source.interactionId
      ? await tx
          .select()
          .from(issueThreadInteractions)
          .where(
            and(
              eq(issueThreadInteractions.id, source.interactionId),
              eq(issueThreadInteractions.companyId, input.companyId),
            ),
          )
          .for("update")
      : [];
    const [current] = await tx
      .select()
      .from(toolActionRequests)
      .where(
        and(
          eq(toolActionRequests.id, source.id),
          eq(toolActionRequests.companyId, input.companyId),
        ),
      )
      .for("update");
    if (!current) throw notFound("Tool action request not found");
    await assertDelegatedToolReview(tx as unknown as Db, current.interactionId, input.companyId, input.actor, input.rememberAction);
    if (current.status !== "pending") {
      if (input.actor.agentId && current.decidedByAgentId !== input.actor.agentId) throw conflict("Another actor already resolved this tool request");
      if (
        (input.decision === "approved" &&
          ["approved", "executing", "executed", "failed"].includes(
            current.status,
          )) ||
        current.status === input.decision
      )
        return current;
      throw conflict("This review has already been resolved");
    }
    if (
      source.issueId &&
      (!issue || issue.status === "done" || issue.status === "cancelled")
    )
      throw conflict("This task is closed");
    const [invocation] = await tx
      .select()
      .from(toolInvocations)
      .where(
        and(
          eq(toolInvocations.id, current.invocationId),
          eq(toolInvocations.companyId, input.companyId),
        ),
      )
      .limit(1);
    if (
      !invocation ||
      invocation.issueId !== current.issueId ||
      (current.requestedByAgentId &&
        (invocation.actorType === "agent" ? invocation.actorId : invocation.agentId) !== current.requestedByAgentId)
    )
      throw conflict("Tool invocation context does not match");
    if (current.expiresAt && current.expiresAt <= new Date())
      throw conflict("This review has expired");
    if (current.interactionId) {
      const payload = interaction?.payload as {
        toolAction?: { actionRequestId?: string; invocationId?: string };
      } | null;
      if (
        !interaction ||
        interaction.issueId !== current.issueId ||
        payload?.toolAction?.actionRequestId !== current.id ||
        payload.toolAction.invocationId !== current.invocationId
      )
        throw conflict("Tool review context does not match");
      assertIssueThreadInteractionResolverAudience({
        actor: input.actor.agentId ? { type: "agent", agentId: input.actor.agentId, runId: input.actor.runId }
          : { type: "user", userId: input.actor.userId ?? "board" },
        interaction,
        governedAction: !input.actor.agentId,
      });
      if (interaction.status !== "pending")
        throw conflict("This review has already been resolved");
    }
    const now = new Date();
    if (interaction && issue) await notifyChatRunMilestones(tx, interaction);
    await notifyToolReviewChange(tx, current.companyId);
    const [updated] = await tx
      .update(toolActionRequests)
      .set({
        status: input.decision,
        resolvedByUserId: input.actor.agentId ? null : input.actor.userId ?? "board",
        decidedByUserId: input.actor.agentId ? null : input.actor.userId ?? "board",
        resolvedByAgentId: input.actor.agentId ?? null,
        decidedByAgentId: input.actor.agentId ?? null,
        decidedAt: now,
        resolvedAt: now,
        updatedAt: now,
      })
      .where(eq(toolActionRequests.id, current.id))
      .returning();
    if (input.rememberAction) {
      if (input.decision !== "approved")
        throw conflict("Only an approval can remember permission");
      await toolAccessPolicyService(
        tx as unknown as Db,
      ).createTrustRuleFromActionRequest({
        companyId: input.companyId,
        actionRequestId: current.id,
        body: { approvalThreshold: 1, priority: 40, argumentMode: "action" },
        actor: { userId: input.actor.userId ?? "board" },
      });
    }
    await tx
      .update(toolInvocations)
      .set({
        approvalState: input.decision,
        ...(input.decision === "rejected"
          ? {
              status: "denied" as const,
              completedAt: now,
              errorCode: "action_declined",
              errorMessage: "The assigned decision maker declined this action.",
            }
          : {}),
        updatedAt: now,
      })
      .where(
        and(
          eq(toolInvocations.id, current.invocationId),
          eq(toolInvocations.companyId, input.companyId),
        ),
      );
    if (interaction && issue) {
      await tx
        .update(issueThreadInteractions)
        .set({
          status: input.decision === "approved" ? "accepted" : "rejected",
          resolvedByUserId: input.actor.agentId ? null : input.actor.userId ?? "board",
          resolvedByAgentId: input.actor.agentId ?? null,
          resolvedByRunId: input.actor.runId ?? null,
          resolvedAt: now,
          updatedAt: now,
          result:
            input.decision === "approved"
              ? {
                  version: 1,
                  outcome: "accepted",
                  toolAction: {
                    version: 1,
                    status: "approved",
                    rememberedAction: input.rememberAction === true,
                    updatedAt: now.toISOString(),
                  },
                }
              : { version: 1, outcome: "rejected", reason: input.reason },
        })
        .where(eq(issueThreadInteractions.id, interaction.id));
      await notifyDeliveryWork(tx, DELIVERY_QUEUES.toolAction);
      await tx
        .insert(toolActionDeliveries)
        .values({
          companyId: input.companyId,
          actionRequestId: current.id,
          issueId: issue.id,
          interactionId: interaction.id,
        })
        .onConflictDoNothing();
      await logActivity(
        tx as unknown as Db,
        {
          companyId: input.companyId,
          actorType: input.actor.agentId ? "agent" : "user",
          actorId: input.actor.agentId ?? input.actor.userId ?? "board",
          agentId: input.actor.agentId ?? null,
          runId: input.actor.runId ?? null,
          action:
            input.decision === "approved"
              ? "issue.thread_interaction_accepted"
              : "issue.thread_interaction_rejected",
          entityType: "issue",
          entityId: issue.id,
          details: {
            interactionId: interaction.id,
            actionRequestId: current.id,
            rememberAction: input.rememberAction === true,
            delegation: interaction.delegation,
            reason: input.actor.reason ?? input.reason,
          },
        },
        publications,
      );
    }
    return updated;
  });
  // A rejection writes the invocation's terminal `denied` status inside the
  // transaction above; emit only after that commit. Approvals stay in-flight
  // and reach their terminal status in the gateway execution paths.
  if (input.decision === "rejected")
    void emitConnectionInvoked(db, source.invocationId);
  for (const publication of publications) publishActivity(publication);
  return result;
}
