import type { LocalVoiceSessionMedia, VoiceBindingMode, VoiceSession } from "@paperclipai/shared";
import { api } from "./client";

const companyBase = (companyId: string) => `/companies/${encodeURIComponent(companyId)}`;

export interface LocalVoiceStatus { companyId: string; enabled: boolean; relayConfigured: boolean }
export interface LocalVoiceEndpoint { endpointId: string; agentId: string; agentName: string; created: boolean }

/**
 * Same-origin local voice: endpoint provisioning and session starts. `voice_task`
 * binds a server-created voice task (HOM-311); `agent_chat` binds the caller's
 * existing Chat with the endpoint's agent and needs that Chat's issueId (HOM-326).
 */
export const localVoiceApi = {
  status(companyId: string) {
    return api.get<LocalVoiceStatus>(`${companyBase(companyId)}/local-voice/status`, { cache: "no-store", signal: AbortSignal.timeout(10_000) });
  },
  ensureEndpoint(companyId: string, agentId: string) {
    return api.post<LocalVoiceEndpoint>(`${companyBase(companyId)}/local-voice/endpoints`, { agentId }, { signal: AbortSignal.timeout(10_000) });
  },
  start(companyId: string, input: { endpointId: string; issueId?: string; newConversation?: boolean; idempotencyKey: string; maxDurationSeconds: number; bindingMode?: VoiceBindingMode }) {
    const { bindingMode = "voice_task", ...rest } = input;
    return api.post<{ session: VoiceSession; media?: LocalVoiceSessionMedia }>(`${companyBase(companyId)}/voice-sessions`,
      { ...rest, bindingMode }, { signal: AbortSignal.timeout(10_000) });
  },
  end(companyId: string, sessionId: string) {
    return api.post<VoiceSession>(`${companyBase(companyId)}/voice-sessions/${encodeURIComponent(sessionId)}/end`, {}, { signal: AbortSignal.timeout(10_000) });
  },
  relayPath(companyId: string, sessionId: string) {
    return `/api${companyBase(companyId)}/voice-sessions/${encodeURIComponent(sessionId)}/ws`;
  },
};
