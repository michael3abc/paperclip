import { and, eq, isNull, sql } from "drizzle-orm";
import { agents, issues, issueComments, issueTreeHolds, issueTreeHoldMembers, type Db } from "@paperclipai/db";
import { z } from "zod";
import { conflict, forbidden } from "../errors.js";

// Owner configuration is the routing authority, independent of Bridge connectivity.
// Losing a key or a connection must never fall back to an adapter run.
export const sessionBridgeChatBindingSchema = z.object({
  version: z.literal(1), projectId: z.uuid(), conversationIssueId: z.uuid(),
  nativeSessionId: z.string().min(1).max(200),
}).strict();
export type SessionBridgeChatBinding = z.infer<typeof sessionBridgeChatBindingSchema>;

export async function sessionBridgeChatBinding(db: Db, companyId: string, agentId: string) {
  const [agent] = await db.select({ runtimeConfig: agents.runtimeConfig }).from(agents)
    .where(and(eq(agents.companyId, companyId), eq(agents.id, agentId)));
  const raw = agent?.runtimeConfig?.sessionBridge;
  if (raw == null) return null;
  return sessionBridgeChatBindingSchema.parse(raw);
}

export function sessionBridgeChatService(db: Db) {
  async function pending(companyId: string, agentId: string, userId: string | null, projectIds: string[]) {
    const binding = await sessionBridgeChatBinding(db, companyId, agentId);
    if (!binding) return null;
    if (!projectIds.includes(binding.projectId)) throw forbidden("Native conversation is outside key scope");
    const [issue] = await db.select().from(issues).where(and(eq(issues.id, binding.conversationIssueId), eq(issues.companyId, companyId)));
    if (!issue || !userId || issue.conversationAgentId !== agentId || issue.conversationUserId !== userId)
      throw forbidden("Native conversation ownership changed");
    const comments = await db.select({ id: issueComments.id, body: issueComments.body, metadata: issueComments.metadata })
      .from(issueComments).where(and(eq(issueComments.companyId, companyId),
        eq(issueComments.issueId, binding.conversationIssueId), eq(issueComments.origin, "session_bridge_input"),
        isNull(issueComments.deletedAt), sql`coalesce(${issueComments.metadata}->'sessionBridge'->>'state', 'pending') <> 'delivered'`))
      .orderBy(issueComments.createdAt, issueComments.id).limit(20);
    return { ...binding, comments: comments.map(c => ({ id: c.id, body: c.body,
      state: c.metadata?.sessionBridge?.state ?? "pending",
      claimId: c.metadata?.sessionBridge?.claimId ?? null })) };
  }

  async function receipt(identity: { companyId: string; agentId: string; keyId: string; userId: string | null; projectIds: string[] },
    input: { commentId: string; nativeSessionId: string; claimId: string; state: "delivering" | "delivered" }) {
    return db.transaction(async tx => {
      const binding = await sessionBridgeChatBinding(tx as unknown as Db, identity.companyId, identity.agentId);
      if (!binding || binding.nativeSessionId !== input.nativeSessionId) throw forbidden("Native session binding changed");
      if (!identity.projectIds.includes(binding.projectId)) throw forbidden("Native conversation is outside key scope");
      const [issue] = await tx.select().from(issues).where(and(eq(issues.id, binding.conversationIssueId),
        eq(issues.companyId, identity.companyId))).for("update");
      if (!issue || issue.conversationAgentId !== identity.agentId || issue.conversationUserId !== identity.userId)
        throw forbidden("Conversation ownership changed");
      const [comment] = await tx.select().from(issueComments).where(and(eq(issueComments.id, input.commentId),
        eq(issueComments.issueId, issue.id), eq(issueComments.companyId, identity.companyId),
        eq(issueComments.origin, "session_bridge_input"), isNull(issueComments.deletedAt)));
      if (!comment) throw forbidden("Native input not found");
      const previous = comment.metadata?.sessionBridge;
      if (previous && (previous.claimId !== input.claimId || previous.nativeSessionId !== input.nativeSessionId || previous.keyId !== identity.keyId))
        throw conflict("Input already claimed; inspect the original receipt, do not replay");
      if (previous?.state === "delivered") return previous;
      if (input.state === "delivered" && !previous) throw conflict("Input has not been claimed");
      if (input.state === "delivering") {
        const [agent] = await tx.select({ status: agents.status, lifecycleState: agents.lifecycleState }).from(agents)
          .where(and(eq(agents.id, identity.agentId), eq(agents.companyId, identity.companyId))).for("update");
        if (!agent || ["paused", "terminated", "pending_approval"].includes(agent.status) || agent.lifecycleState !== "ready")
          throw conflict("Agent is unavailable");
        const [hold] = await tx.select({ id: issueTreeHolds.id }).from(issueTreeHolds).where(and(
          eq(issueTreeHolds.companyId, identity.companyId), eq(issueTreeHolds.status, "active"),
          sql`(${issueTreeHolds.rootIssueId} = ${issue.id}::uuid or exists (select 1 from ${issueTreeHoldMembers}
            where ${issueTreeHoldMembers.holdId} = ${issueTreeHolds.id} and ${issueTreeHoldMembers.issueId} = ${issue.id}::uuid
              and ${issueTreeHoldMembers.skipped} = false))`)).limit(1);
        if (hold) throw conflict("Conversation is held");
      }
      const value = { state: input.state, claimId: input.claimId, nativeSessionId: input.nativeSessionId,
        keyId: identity.keyId, updatedAt: new Date().toISOString() };
      await tx.update(issueComments).set({ metadata: { version: 1, sections: [], ...comment.metadata, sessionBridge: value } })
        .where(eq(issueComments.id, comment.id));
      return value;
    });
  }
  return { pending, receipt };
}
