import { describe, expect, it } from "vitest";
import { LOCAL_VOICE_OPENAI_VOICES, LOCAL_VOICE_RELAY_PROTOCOL, LOCAL_VOICE_RELAY_TOKEN_PREFIX, LOCAL_VOICE_RELAY_VOICE_PREFIX } from "@paperclipai/shared";
import { parseVoiceRelayProtocols } from "../realtime/local-voice-relay-ws.js";
import { loadLocalVoiceGatewayConfig, resolveLocalVoiceName } from "../services/voice/local-voice-gateway-config.js";

/** Per-agent voice choice (HOM-265): browser offer on the relay upgrade, server allowlist and default fallback. */
describe("local voice per-call voice choice", () => {
  const base = { PAPERCLIP_LOCAL_VOICE_GATEWAY_URL: "ws://192.168.66.11:8792/", PAPERCLIP_LOCAL_VOICE_GATEWAY_KEY_FILE: "/tmp/key" };
  const openai = loadLocalVoiceGatewayConfig(base)!;
  const gemini = loadLocalVoiceGatewayConfig({ ...base, PAPERCLIP_LOCAL_VOICE_ENGINE: "gemini" })!;
  const token = "T".repeat(43);

  it("applies an allowed OpenAI voice case-insensitively and falls back to the configured voice otherwise", () => {
    expect(openai.voiceName).toBe("marin");
    expect(resolveLocalVoiceName(openai, "Cedar")).toBe("cedar");
    for (const voice of LOCAL_VOICE_OPENAI_VOICES) expect(resolveLocalVoiceName(openai, voice.toUpperCase())).toBe(voice);
    for (const requested of [null, undefined, "", "Kore", "nova", "marin!"]) expect(resolveLocalVoiceName(openai, requested)).toBe("marin");
    const configured = loadLocalVoiceGatewayConfig({ ...base, PAPERCLIP_LOCAL_VOICE_NAME: "Sage" })!;
    expect(resolveLocalVoiceName(configured, "bogus")).toBe("sage");
  });

  it("ignores the caller's choice for the Gemini engine", () => {
    expect(resolveLocalVoiceName(gemini, "cedar")).toBe("Kore");
    expect(resolveLocalVoiceName(gemini, null)).toBe("Kore");
  });

  it("reads one optional voice subprotocol and never rejects the upgrade over it", () => {
    const protocols = (...extra: string[]) => [LOCAL_VOICE_RELAY_PROTOCOL, `${LOCAL_VOICE_RELAY_TOKEN_PREFIX}${token}`, ...extra].join(", ");
    expect(parseVoiceRelayProtocols(protocols())).toEqual({ token, voiceName: null });
    expect(parseVoiceRelayProtocols(protocols(`${LOCAL_VOICE_RELAY_VOICE_PREFIX}Cedar`))).toEqual({ token, voiceName: "Cedar" });
    expect(parseVoiceRelayProtocols(protocols(`${LOCAL_VOICE_RELAY_VOICE_PREFIX}ced4r`))).toEqual({ token, voiceName: null });
    expect(parseVoiceRelayProtocols(protocols(`${LOCAL_VOICE_RELAY_VOICE_PREFIX}`))).toEqual({ token, voiceName: null });
    expect(parseVoiceRelayProtocols(protocols(`${LOCAL_VOICE_RELAY_VOICE_PREFIX}ash`, `${LOCAL_VOICE_RELAY_VOICE_PREFIX}sage`))).toEqual({ token, voiceName: null });
    // The voice offer never stands in for the session credential.
    expect(parseVoiceRelayProtocols([LOCAL_VOICE_RELAY_PROTOCOL, `${LOCAL_VOICE_RELAY_VOICE_PREFIX}ash`].join(", "))).toBeNull();
  });
});
