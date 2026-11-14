// @vitest-environment jsdom
import { describe, expect, it, vi } from "vitest";
import { LOCAL_VOICE_RELAY_PROTOCOL, LOCAL_VOICE_RELAY_TOKEN_PREFIX } from "@paperclipai/shared";
import { LocalVoiceCall, type LocalVoiceCallDependencies, type VoiceAudioEngine } from "./local-voice-call";

class FakeSocket {
  readyState = 1;
  binaryType = "blob";
  sent: (string | ArrayBuffer)[] = [];
  onmessage: ((event: { data: unknown }) => void) | null = null;
  onclose: (() => void) | null = null;
  constructor(readonly url: string, readonly protocols: string[]) {}
  send(data: string | ArrayBuffer) { this.sent.push(data); }
  close() { this.readyState = 3; }
  emit(event: unknown) { this.onmessage?.({ data: JSON.stringify(event) }); }
  json() { return this.sent.filter((item): item is string => typeof item === "string").map((item) => JSON.parse(item)); }
}

function setup(options: { startError?: unknown; firstStartError?: unknown } = {}) {
  let now = 1_000_000;
  const sockets: FakeSocket[] = [];
  const intervals: (() => void)[] = [];
  let frame: ((pcm: ArrayBuffer, rms: number) => void) | null = null;
  const audio: VoiceAudioEngine & { played: ArrayBuffer[]; flushes: number; closed: boolean } = {
    played: [], flushes: 0, closed: false,
    start: vi.fn(async (handlers) => { frame = handlers.onFrame; }),
    play(pcm) { this.played.push(pcm); },
    flush() { this.flushes += 1; },
    async close() { this.closed = true; },
  };
  let firstStartError = options.firstStartError;
  const api = {
    ensureEndpoint: vi.fn(async () => ({ endpointId: "endpoint-1", agentId: "agent-1", agentName: "michael", created: false })),
    start: vi.fn(async (_companyId: string, input: { newConversation?: boolean }) => {
      if (options.startError) throw options.startError;
      if (firstStartError) { const error = firstStartError; firstStartError = undefined; throw error; }
      return { session: { id: "session-1", issueId: input.newConversation ? "issue-new" : "issue-1" } as never, media: { transportToken: "T".repeat(43) } as never };
    }),
    end: vi.fn(async () => ({}) as never),
    relayPath: (companyId: string, sessionId: string) => `/api/companies/${companyId}/voice-sessions/${sessionId}/ws`,
  };
  const deps: LocalVoiceCallDependencies = {
    api,
    createSocket: (url, protocols) => { const socket = new FakeSocket(url, protocols); sockets.push(socket); return socket as unknown as WebSocket; },
    createAudio: () => audio,
    now: () => now,
    randomId: () => "11111111-1111-4111-8111-111111111111",
    setInterval: (fn) => { intervals.push(fn); return intervals.length; },
    clearInterval: () => undefined,
  };
  const call = new LocalVoiceCall(deps);
  return { call, api, audio, sockets, tick: (ms: number) => { now += ms; for (const fn of intervals) fn(); }, frame: (rms: number) => frame?.(new ArrayBuffer(4), rms) };
}

describe("LocalVoiceCall", () => {
  it("starts a voice_task session and opens the relay with the token subprotocol", async () => {
    const h = setup();
    await h.call.start({ companyId: "c1", agentId: "agent-1" });
    expect(h.api.start).toHaveBeenCalledWith("c1", expect.objectContaining({ endpointId: "endpoint-1", maxDurationSeconds: 930 }));
    const socket = h.sockets[0]!;
    expect(socket.url).toMatch(/\/api\/companies\/c1\/voice-sessions\/session-1\/ws$/);
    expect(socket.protocols).toEqual([LOCAL_VOICE_RELAY_PROTOCOL, `${LOCAL_VOICE_RELAY_TOKEN_PREFIX}${"T".repeat(43)}`]);
    socket.emit({ type: "ready", issueId: "issue-1", issueIdentifier: "HOM-9", agentName: "michael", maxSeconds: 900, warningSeconds: 600 });
    expect(h.call.getSnapshot()).toMatchObject({ phase: "live", issue: { identifier: "HOM-9" } });
    h.frame(0.1);
    expect(socket.sent.filter((item) => item instanceof ArrayBuffer)).toHaveLength(1);
  });

  it("plays model audio, flushes it on barge-in and merges captions per turn", async () => {
    const h = setup();
    await h.call.start({ companyId: "c1", agentId: "agent-1" });
    const socket = h.sockets[0]!;
    socket.emit({ type: "ready", issueId: "issue-1", issueIdentifier: null, agentName: "michael", maxSeconds: 900, warningSeconds: 600 });
    socket.onmessage?.({ data: new ArrayBuffer(8) });
    expect(h.audio.played).toHaveLength(1);
    socket.emit({ type: "transcript", role: "model", text: "你好" });
    socket.emit({ type: "transcript", role: "model", text: "，請說" });
    socket.emit({ type: "interrupted" });
    socket.emit({ type: "transcript", role: "user", text: "查 HOM-307" });
    expect(h.audio.flushes).toBe(1);
    expect(h.call.getSnapshot().transcript.map((entry) => [entry.role, entry.text])).toEqual([["model", "你好，請說"], ["user", "查 HOM-307"]]);
  });

  it("pauses the microphone after 60 seconds without speech and resumes on request", async () => {
    const h = setup();
    await h.call.start({ companyId: "c1", agentId: "agent-1" });
    const socket = h.sockets[0]!;
    socket.emit({ type: "ready", issueId: "issue-1", issueIdentifier: null, agentName: "michael", maxSeconds: 900, warningSeconds: 600 });
    h.tick(30_000); h.frame(0.001);
    h.tick(29_000);
    expect(h.call.getSnapshot().mic).toBe("live");
    h.tick(1_000);
    expect(h.call.getSnapshot()).toMatchObject({ mic: "paused", micPausedReason: "silence" });
    expect(socket.json().at(-1)).toEqual({ type: "mic", state: "paused" });
    const audioFrames = socket.sent.filter((item) => item instanceof ArrayBuffer).length;
    h.frame(0.5);
    expect(socket.sent.filter((item) => item instanceof ArrayBuffer)).toHaveLength(audioFrames);
    h.call.resumeMic();
    expect(socket.json().at(-1)).toEqual({ type: "mic", state: "live" });
  });

  it("confirms a draft from the UI and tracks its result", async () => {
    const h = setup();
    await h.call.start({ companyId: "c1", agentId: "agent-1" });
    const socket = h.sockets[0]!;
    socket.emit({ type: "ready", issueId: "issue-1", issueIdentifier: null, agentName: "michael", maxSeconds: 900, warningSeconds: 600 });
    const draftId = "22222222-2222-4222-8222-222222222222";
    socket.emit({ type: "draft", draft: { draftId, revision: 2, text: "請查部署" } });
    h.call.confirmDraft();
    expect(socket.json().at(-1)).toEqual({ type: "confirm_draft", draftId, revision: 2 });
    expect(h.call.getSnapshot().draft?.status).toBe("submitting");
    socket.emit({ type: "submitted", draftId, revision: 2, operationId: "op", via: "ui" });
    expect(h.call.getSnapshot().draft).toMatchObject({ status: "submitted", via: "ui" });
    socket.emit({ type: "agent_reply", commentId: "c1", body: "完成", voiceSummary: "完成了", createdAt: "x" });
    socket.emit({ type: "agent_reply", commentId: "c1", body: "完成", voiceSummary: "完成了", createdAt: "x" });
    expect(h.call.getSnapshot().replies).toHaveLength(1);
  });

  it("ends through the relay, and ends the session over HTTP when the relay is gone", async () => {
    const h = setup();
    await h.call.start({ companyId: "c1", agentId: "agent-1" });
    const socket = h.sockets[0]!;
    socket.emit({ type: "ready", issueId: "issue-1", issueIdentifier: null, agentName: "michael", maxSeconds: 900, warningSeconds: 600 });
    await h.call.end();
    expect(socket.json().at(-1)).toEqual({ type: "end" });
    expect(h.api.end).not.toHaveBeenCalled();
    expect(h.audio.closed).toBe(true);
    expect(h.call.getSnapshot().phase).toBe("ended");

    const lost = setup();
    await lost.call.start({ companyId: "c1", agentId: "agent-1" });
    lost.sockets[0]!.onclose?.();
    await vi.waitFor(() => expect(lost.call.getSnapshot().phase).toBe("error"));
    expect(lost.api.end).toHaveBeenCalledWith("c1", "session-1");
  });

  it("reports microphone denial and continues on a new voice task when the old one has a live call", async () => {
    const denied = setup();
    (denied.audio.start as ReturnType<typeof vi.fn>).mockRejectedValueOnce(Object.assign(new Error("denied"), { name: "NotAllowedError" }));
    await denied.call.start({ companyId: "c1", agentId: "agent-1" });
    expect(denied.call.getSnapshot()).toMatchObject({ phase: "error" });
    expect(denied.call.getSnapshot().error).toContain("Microphone permission");
    expect(denied.api.end).toHaveBeenCalledWith("c1", "session-1");

    const busy = setup({ firstStartError: { status: 409, body: { error: "End the existing call", code: "voice_call_already_active" } } });
    await busy.call.start({ companyId: "c1", agentId: "agent-1" });
    expect(busy.api.start).toHaveBeenLastCalledWith("c1", expect.objectContaining({ newConversation: true }));
    expect(busy.call.getSnapshot().issue?.id).toBe("issue-new");
  });
});
