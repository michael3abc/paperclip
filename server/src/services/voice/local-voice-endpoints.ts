import { randomUUID } from "node:crypto";
import { and, asc, eq, inArray, sql } from "drizzle-orm";
import { activityLog, agents, chatEndpoints, toolApplications, toolConnections, type Db } from "@paperclipai/db";
import { conflict, notFound } from "../../errors.js";
import type { InternalSetupState } from "../chat-channels/runtime-types.js";
import { voiceSessionStore, type VoiceCaller } from "./voice-session-store.js";

/**
 * Local voice endpoint provisioning (HOM-311). A local voice endpoint is a
 * browser-only, same-origin capability bound to one agent: it has no external
 * provider, credentials, webhook or phone number. The chat connection create
 * contract still rejects `local_voice`; only this server-owned path creates it,
 * behind the same enableChatConnectors + enableLocalVoice gate as voice starts.
 */
export async function ensureLocalVoiceEndpoint(db: Db, input: { companyId: string; agentId: string; caller: VoiceCaller; allowLocalBoard: boolean }) {
  const store = voiceSessionStore(db, { allowLocalBoard: input.allowLocalBoard });
  return db.transaction(async (tx) => {
    // Same caller authority as a voice start: active non-viewer member, instance admin or local board.
    await store.authorizeCaller(tx, input.companyId, input.caller);
    const [agent] = await tx.select({ id: agents.id, name: agents.name, status: agents.status }).from(agents)
      .where(and(eq(agents.id, input.agentId), eq(agents.companyId, input.companyId)));
    if (!agent) throw notFound("Agent not found");
    if (agent.status === "terminated") throw conflict("This agent is no longer available for voice", { code: "local_voice_agent_unavailable" });
    await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${`local-voice-endpoint:${input.companyId}:${input.agentId}`}, 0))`);
    const [existing] = await tx.select({ id: chatEndpoints.id }).from(chatEndpoints)
      .where(and(eq(chatEndpoints.companyId, input.companyId), eq(chatEndpoints.provider, "local_voice"), eq(chatEndpoints.assignedAgentId, input.agentId),
        inArray(chatEndpoints.status, ["active", "verifying"])))
      .orderBy(asc(chatEndpoints.createdAt)).limit(1);
    if (existing) return { endpointId: existing.id, agentId: agent.id, agentName: agent.name, created: false };
    const endpointId = randomUUID(), applicationId = randomUUID(), connectionId = randomUUID();
    const label = `Local voice · ${agent.name}`.slice(0, 200);
    await tx.insert(toolApplications).values({ id: applicationId, companyId: input.companyId, applicationKey: `chat:local_voice:${endpointId}`, name: label, type: "chat", status: "active" });
    await tx.insert(toolConnections).values({ id: connectionId, companyId: input.companyId, applicationId, name: label, uid: endpointId, connectionPurpose: "channel",
      transport: "voice", config: { provider: "local_voice" }, status: "active", enabled: true });
    await tx.insert(chatEndpoints).values({ id: endpointId, companyId: input.companyId, connectionId, provider: "local_voice", publicId: randomUUID(),
      assignedAgentId: agent.id, status: "active", setup: { step: "complete", runtimeGeneration: 1 } as InternalSetupState });
    await tx.insert(activityLog).values({ companyId: input.companyId, actorType: "user", actorId: input.caller.id, action: "voice.local_endpoint.created",
      entityType: "chat_endpoint", entityId: endpointId, details: { agentId: agent.id, provider: "local_voice" } });
    return { endpointId, agentId: agent.id, agentName: agent.name, created: true };
  });
}
