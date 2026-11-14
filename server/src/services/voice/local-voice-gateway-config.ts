import { readFile } from "node:fs/promises";

/**
 * Server-side configuration for the local voice media relay (HOM-311).
 * The gateway key is read from a file at connect time and is never sent to the
 * browser, logged or stored in the database.
 */
export interface LocalVoiceGatewayConfig {
  /** Base WebSocket URL of the realtime gateway, e.g. ws://192.168.66.11:8792 */
  url: string;
  keyFile: string;
  model: string;
  voiceName: string;
}

export function loadLocalVoiceGatewayConfig(env: NodeJS.ProcessEnv = process.env): LocalVoiceGatewayConfig | null {
  const url = env.PAPERCLIP_LOCAL_VOICE_GATEWAY_URL?.trim();
  const keyFile = env.PAPERCLIP_LOCAL_VOICE_GATEWAY_KEY_FILE?.trim();
  if (!url || !keyFile) return null;
  let parsed: URL;
  try { parsed = new URL(url); } catch { return null; }
  if (parsed.protocol !== "ws:" && parsed.protocol !== "wss:") return null;
  if (parsed.search || parsed.username || parsed.password) return null;
  const model = env.PAPERCLIP_LOCAL_VOICE_MODEL?.trim() || "gemini-3.8-live";
  if (!/^[A-Za-z0-9._-]{1,100}$/.test(model)) return null;
  const voiceName = env.PAPERCLIP_LOCAL_VOICE_NAME?.trim() || "Kore";
  if (!/^[A-Za-z]{1,40}$/.test(voiceName)) return null;
  return { url: url.replace(/\/+$/, ""), keyFile, model, voiceName };
}

export function localVoiceRealtimeUrl(config: LocalVoiceGatewayConfig) {
  return `${config.url}/v1/realtime?model=${encodeURIComponent(config.model)}`;
}

export async function readLocalVoiceGatewayKey(config: LocalVoiceGatewayConfig) {
  const key = (await readFile(config.keyFile, "utf8")).trim();
  if (!key || /\s/.test(key)) throw new Error("local voice gateway key is unavailable");
  return key;
}
