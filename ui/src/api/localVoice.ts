import type { LocalVoiceSessionMedia, VoiceSession } from "@paperclipai/shared";
import { api } from "./client";

const companyBase = (companyId: string) => `/companies/${encodeURIComponent(companyId)}`;

export interface LocalVoiceStatus { companyId: string; enabled: boolean; relayConfigured: boolean }
export interface LocalVoiceEndpoint { endpointId: string; agentId: string; agentName: string; created: boolean }

/** Same-origin local voice (HOM-311): endpoint provisioning and voice_task session starts. */
export const localVoiceApi = {
  status(companyId: string) {
    return api.get<LocalVoiceStatus>(`${companyBase(companyId)}/local-voice/status`, { cache: "no-store", signal: AbortSignal.timeout(10_000) });
  },
  ensureEndpoint(companyId: string, agentId: string) {
    return api.post<LocalVoiceEndpoint>(`${companyBase(companyId)}/local-voice/endpoints`, { agentId }, { signal: AbortSignal.timeout(10_000) });
  },
  start(companyId: string, input: { endpointId: string; issueId?: string; newConversation?: boolean; idempotencyKey: string; maxDurationSeconds: number }) {
    return api.post<{ session: VoiceSession; media?: LocalVoiceSessionMedia }>(`${companyBase(companyId)}/voice-sessions`,
      { ...input, bindingMode: "voice_task" }, { signal: AbortSignal.timeout(10_000) });
  },
  end(companyId: string, sessionId: string) {
    return api.post<VoiceSession>(`${companyBase(companyId)}/voice-sessions/${encodeURIComponent(sessionId)}/end`, {}, { signal: AbortSignal.timeout(10_000) });
  },
  relayPath(companyId: string, sessionId: string) {
    return `/api${companyBase(companyId)}/voice-sessions/${encodeURIComponent(sessionId)}/ws`;
  },
};
