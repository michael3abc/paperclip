import { LOCAL_VOICE_OPENAI_VOICES } from "@paperclipai/shared";

/** Voice page agent preference (HOM-326), remembered per company in this browser. */
const LAST_AGENT_KEY_PREFIX = "paperclip.voice.lastAgentId:";

export function readLastVoiceAgentId(companyId: string): string | null {
  try { return window.localStorage.getItem(`${LAST_AGENT_KEY_PREFIX}${companyId}`); } catch { return null; }
}

export function saveLastVoiceAgentId(companyId: string, agentId: string) {
  try { window.localStorage.setItem(`${LAST_AGENT_KEY_PREFIX}${companyId}`, agentId); } catch { /* storage unavailable */ }
}

/**
 * Default agent for a voice call: `?agentId=`, else the agent last chosen on this page,
 * else one named "momo", else the primary agent, else the first available agent.
 */
export function chooseDefaultVoiceAgentId(
  available: readonly { id: string; name: string }[],
  options: { requested?: string | null; lastChosen?: string | null; primaryAgentId?: string | null },
): string | null {
  const has = (id: string | null | undefined): id is string => !!id && available.some((agent) => agent.id === id);
  if (has(options.requested)) return options.requested;
  if (has(options.lastChosen)) return options.lastChosen;
  const momo = available.find((agent) => agent.name.trim().toLowerCase() === "momo");
  if (momo) return momo.id;
  if (has(options.primaryAgentId)) return options.primaryAgentId;
  return available[0]?.id ?? null;
}

/** One voice for all agents in this browser. No entry = the server default. */
export const SHARED_VOICE_KEY = "paperclip.voice.voiceName";
const VOICE_CHANGED_EVENT = "paperclip:voice-choice-changed";

/** A known OpenAI Realtime voice name in lowercase, else null. */
export function normalizeVoiceName(value: string | null | undefined): string | null {
  if (typeof value !== "string") return null;
  const voice = value.trim().toLowerCase();
  return (LOCAL_VOICE_OPENAI_VOICES as readonly string[]).includes(voice) ? voice : null;
}

export function readSharedVoice(): string | null {
  try { return normalizeVoiceName(window.localStorage.getItem(SHARED_VOICE_KEY)); } catch { return null; }
}

/** `null` restores the server default for all agents. Storage errors reach the picker. */
export function saveSharedVoice(voiceName: string | null) {
  const voice = normalizeVoiceName(voiceName);
  if (voice) window.localStorage.setItem(SHARED_VOICE_KEY, voice);
  else window.localStorage.removeItem(SHARED_VOICE_KEY);
  window.dispatchEvent(new Event(VOICE_CHANGED_EVENT));
}

export function subscribeSharedVoice(listener: () => void) {
  const onStorage = (event: StorageEvent) => {
    if ((event.key === SHARED_VOICE_KEY || event.key === null) && event.storageArea === window.localStorage) listener();
  };
  window.addEventListener(VOICE_CHANGED_EVENT, listener);
  window.addEventListener("storage", onStorage);
  return () => {
    window.removeEventListener(VOICE_CHANGED_EVENT, listener);
    window.removeEventListener("storage", onStorage);
  };
}
