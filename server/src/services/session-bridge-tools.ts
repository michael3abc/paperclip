import { createHash } from "node:crypto";
import { and, eq, isNull } from "drizzle-orm";
import { agentApiKeys, agents, issues, type Db } from "@paperclipai/db";
import { forbidden } from "../errors.js";
import { sessionBridgeChatBindingSchema } from "./session-bridge-chat.js";
import type { ToolGatewaySession } from "./tool-gateway.js";

/** Request-scoped identity, never a run or a second credential. Revalidated on every call. */
export async function sessionBridgeToolIdentity(db: Db, token: string): Promise<ToolGatewaySession> {
  const [key] = await db.select().from(agentApiKeys).where(and(
    eq(agentApiKeys.keyHash, createHash("sha256").update(token).digest("hex")), isNull(agentApiKeys.revokedAt)));
  const scope = key?.scopeConfig;
  if (!key || scope?.kind !== "session_bridge" || !scope.allowAssignedTools || !key.responsibleUserId)
    throw forbidden("Assigned connector access is not authorized");
  const [agent] = await db.select().from(agents).where(and(eq(agents.id, key.agentId), eq(agents.companyId, key.companyId)));
  if (!agent || ["paused", "terminated", "pending_approval"].includes(agent.status) || agent.lifecycleState !== "ready")
    throw forbidden("Agent is unavailable");
  const binding = sessionBridgeChatBindingSchema.parse(agent.runtimeConfig?.sessionBridge);
  if (!scope.projectIds.includes(binding.projectId) || scope.conversationAgentId !== agent.id)
    throw forbidden("Connector context is outside this key scope");
  const [issue] = await db.select().from(issues).where(and(eq(issues.id, binding.conversationIssueId), eq(issues.companyId, key.companyId)));
  if (!issue || issue.conversationAgentId !== agent.id || issue.conversationUserId !== key.responsibleUserId)
    throw forbidden("Connector conversation ownership changed");
  const now = new Date();
  return { id: `session-bridge:${key.id}`, token: "", companyId: key.companyId, agentId: agent.id,
    actorType: "agent", actorId: agent.id, responsibleUserId: key.responsibleUserId, runId: null,
    issueId: issue.id, projectId: issue.projectId, createdAt: now, expiresAt: new Date(now.getTime() + 60000) };
}
