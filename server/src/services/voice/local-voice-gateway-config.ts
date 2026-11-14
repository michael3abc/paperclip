import { readFile } from "node:fs/promises";

/**
 * Server-side configuration for the local voice media relay (HOM-311, HOM-318).
 * The gateway key is read from a file at connect time and is never sent to the
 * browser, logged or stored in the database.
 *
 * Engine selection: `PAPERCLIP_LOCAL_VOICE_ENGINE` = `openai` (default,
 * OpenAI Realtime GA protocol) or `gemini` (Gemini Live fallback). Without an
 * explicit engine, a `PAPERCLIP_LOCAL_VOICE_MODEL` starting with `gemini`
 * selects Gemini so an older Gemini-only configuration keeps working.
 */
export type LocalVoiceEngine = "openai" | "gemini";

export interface LocalVoiceGatewayConfig {
  /** Base WebSocket URL of the realtime gateway, e.g. ws://192.168.66.11:8792 */
  url: string;
  keyFile: string;
  engine: LocalVoiceEngine;
  model: string;
  voiceName: string;
}

const DEFAULTS: Record<LocalVoiceEngine, { model: string; voiceName: string }> = {
  openai: { model: "gpt-realtime-1.5", voiceName: "marin" },
  gemini: { model: "gemini-3.8-live", voiceName: "Kore" },
};

export function loadLocalVoiceGatewayConfig(env: NodeJS.ProcessEnv = process.env): LocalVoiceGatewayConfig | null {
  const url = env.PAPERCLIP_LOCAL_VOICE_GATEWAY_URL?.trim();
  const keyFile = env.PAPERCLIP_LOCAL_VOICE_GATEWAY_KEY_FILE?.trim();
  if (!url || !keyFile) return null;
  let parsed: URL;
  try { parsed = new URL(url); } catch { return null; }
  if (parsed.protocol !== "ws:" && parsed.protocol !== "wss:") return null;
  if (parsed.search || parsed.username || parsed.password) return null;
  const configuredModel = env.PAPERCLIP_LOCAL_VOICE_MODEL?.trim() || null;
  const rawEngine = env.PAPERCLIP_LOCAL_VOICE_ENGINE?.trim().toLowerCase() || null;
  let engine: LocalVoiceEngine;
  if (rawEngine === "openai" || rawEngine === "gemini") engine = rawEngine;
  else if (rawEngine) return null;
  else engine = configuredModel?.toLowerCase().startsWith("gemini") ? "gemini" : "openai";
  const model = configuredModel || DEFAULTS[engine].model;
  if (!/^[A-Za-z0-9._-]{1,100}$/.test(model)) return null;
  const voiceName = env.PAPERCLIP_LOCAL_VOICE_NAME?.trim() || DEFAULTS[engine].voiceName;
  if (!/^[A-Za-z]{1,40}$/.test(voiceName)) return null;
  return { url: url.replace(/\/+$/, ""), keyFile, engine, model, voiceName };
}

export function localVoiceRealtimeUrl(config: LocalVoiceGatewayConfig) {
  return `${config.url}/v1/realtime?model=${encodeURIComponent(config.model)}`;
}

export async function readLocalVoiceGatewayKey(config: LocalVoiceGatewayConfig) {
  const key = (await readFile(config.keyFile, "utf8")).trim();
  if (!key || /\s/.test(key)) throw new Error("local voice gateway key is unavailable");
  return key;
}
