// @vitest-environment jsdom
import { describe, expect, it, vi } from "vitest";
import { LOCAL_VOICE_RELAY_PROTOCOL, LOCAL_VOICE_RELAY_TOKEN_PREFIX } from "@paperclipai/shared";
import { AGENT_CHAT_END_WAIT_MS, LocalVoiceCall, type LocalVoiceCallDependencies, type VoiceAudioEngine } from "./local-voice-call";

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

const CHAT_ID = "33333333-3333-4333-8333-333333333333";
const OPERATION_ID = "44444444-4444-4444-8444-444444444444";
const COMMENT_ID = "55555555-5555-4555-8555-555555555555";
const READY = { type: "ready", issueId: CHAT_ID, issueIdentifier: "HOM-1", agentName: "momo", maxSeconds: 900, warningSeconds: 600, inputSampleRate: 24_000, bindingMode: "agent_chat" };

function setup(options: { startError?: unknown; firstStartError?: unknown; postChatMessage?: (issueId: string, body: string, clientRequestId: string) => Promise<{ id: string }> } = {}) {
  let now = 1_000_000;
  const sockets: FakeSocket[] = [];
  const intervals: (() => void)[] = [];
  let frame: ((pcm: ArrayBuffer, rms: number, rate?: number) => void) | null = null;
  let playing: ((playing: boolean) => void) | null = null;
  const audio: VoiceAudioEngine & { played: ArrayBuffer[]; flushes: number; closed: boolean; inputRates: number[] } = {
    played: [], flushes: 0, closed: false, inputRates: [],
    start: vi.fn(async (handlers) => { frame = handlers.onFrame; playing = handlers.onPlaying; }),
    play(pcm) { this.played.push(pcm); },
    flush() { this.flushes += 1; },
    setInputSampleRate(rate) { this.inputRates.push(rate); },
    async close() { this.closed = true; },
  };
  let firstStartError = options.firstStartError;
  let ids = 0;
  const ensureChat = vi.fn(async () => ({ id: CHAT_ID, identifier: "HOM-1" }));
  const postChatMessage = vi.fn(options.postChatMessage ?? (async () => ({ id: COMMENT_ID })));
  const api = {
    ensureEndpoint: vi.fn(async () => ({ endpointId: "endpoint-1", agentId: "agent-1", agentName: "michael", created: false })),
    start: vi.fn(async (_companyId: string, input: { newConversation?: boolean; issueId?: string; bindingMode?: string; idempotencyKey: string }) => {
      if (options.startError) throw options.startError;
      if (firstStartError) { const error = firstStartError; firstStartError = undefined; throw error; }
      const issueId = input.bindingMode === "agent_chat" ? input.issueId! : input.newConversation ? "issue-new" : "issue-1";
      return { session: { id: "session-1", issueId } as never, media: { transportToken: "T".repeat(43) } as never };
    }),
    end: vi.fn(async () => ({}) as never),
    relayPath: (companyId: string, sessionId: string) => `/api/companies/${companyId}/voice-sessions/${sessionId}/ws`,
  };
  const deps: LocalVoiceCallDependencies = {
    api,
    ensureChat,
    postChatMessage,
    createSocket: (url, protocols) => { const socket = new FakeSocket(url, protocols); sockets.push(socket); return socket as unknown as WebSocket; },
    createAudio: () => audio,
    now: () => now,
    randomId: () => `11111111-1111-4111-8111-${String(++ids).padStart(12, "0")}`,
    setInterval: (fn) => { intervals.push(fn); return intervals.length; },
    clearInterval: () => undefined,
  };
  const call = new LocalVoiceCall(deps);
  return { call, api, ensureChat, postChatMessage, audio, sockets, playing: (value: boolean) => playing?.(value), tick: (ms: number) => { now += ms; for (const fn of intervals) fn(); }, frame: (rms: number, rate?: number) => frame?.(new ArrayBuffer(4), rms, rate) };
}

describe("LocalVoiceCall", () => {
  it("starts a voice_task session and opens the relay with the token subprotocol", async () => {
    const h = setup();
    await h.call.start({ companyId: "c1", agentId: "agent-1" });
    expect(h.api.start).toHaveBeenCalledWith("c1", expect.objectContaining({ endpointId: "endpoint-1", maxDurationSeconds: 930 }));
    const socket = h.sockets[0]!;
    expect(socket.url).toMatch(/\/api\/companies\/c1\/voice-sessions\/session-1\/ws$/);
    expect(socket.protocols).toEqual([LOCAL_VOICE_RELAY_PROTOCOL, `${LOCAL_VOICE_RELAY_TOKEN_PREFIX}${"T".repeat(43)}`]);
    socket.emit({ type: "ready", issueId: "issue-1", issueIdentifier: "HOM-9", agentName: "michael", maxSeconds: 900, warningSeconds: 600, inputSampleRate: 24_000 });
    expect(h.call.getSnapshot()).toMatchObject({ phase: "live", issue: { identifier: "HOM-9" } });
    expect(h.audio.inputRates).toEqual([24_000]);
    h.frame(0.1);
    expect(socket.sent.filter((item) => item instanceof ArrayBuffer)).toHaveLength(1);
    h.frame(0.1, 16_000); // captured before a rate switch: dropped
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

  it("reports playback changes to the relay and abandons a start that was ended midway", async () => {
    const h = setup();
    await h.call.start({ companyId: "c1", agentId: "agent-1" });
    const socket = h.sockets[0]!;
    socket.emit({ type: "ready", issueId: "issue-1", issueIdentifier: null, agentName: "michael", maxSeconds: 900, warningSeconds: 600 });
    h.playing(true); h.playing(false);
    expect(socket.json().slice(-2)).toEqual([{ type: "playback", playing: true }, { type: "playback", playing: false }]);

    const slow = setup();
    let finish!: () => void;
    (slow.audio.start as ReturnType<typeof vi.fn>).mockImplementationOnce(() => new Promise<void>((resolve) => { finish = resolve; }));
    const starting = slow.call.start({ companyId: "c1", agentId: "agent-1" });
    await vi.waitFor(() => expect(slow.audio.start).toHaveBeenCalled());
    await slow.call.end();
    finish();
    await starting;
    expect(slow.sockets).toHaveLength(0);
    expect(slow.audio.closed).toBe(true);
    expect(slow.api.end).toHaveBeenCalledWith("c1", "session-1");
    expect(slow.call.getSnapshot().phase).toBe("ended");
  });

  describe("agent_chat", () => {
    async function live(options: Parameters<typeof setup>[0] = {}) {
      const h = setup(options);
      await h.call.start({ companyId: "c1", agentId: "agent-1", mode: "agent_chat" });
      const socket = h.sockets[0]!;
      socket.emit(READY);
      return { ...h, socket };
    }

    it("binds the session to the caller's Chat with the agent", async () => {
      const h = await live();
      expect(h.ensureChat).toHaveBeenCalledWith("c1", "agent-1");
      expect(h.api.start).toHaveBeenCalledTimes(1);
      expect(h.api.start).toHaveBeenCalledWith("c1", expect.objectContaining({ endpointId: "endpoint-1", issueId: CHAT_ID, bindingMode: "agent_chat", maxDurationSeconds: 930 }));
      expect(h.api.start.mock.calls[0]![1]).not.toHaveProperty("newConversation");
      expect(h.call.getSnapshot()).toMatchObject({ phase: "live", mode: "agent_chat", issue: { id: CHAT_ID, identifier: "HOM-1" }, sentLog: [] });
    });

    it("posts each dictation to the Chat as the caller and reports the result to the relay", async () => {
      let finish!: (value: { id: string }) => void;
      const h = await live({ postChatMessage: () => new Promise((resolve) => { finish = resolve; }) });
      h.socket.emit({ type: "dictation", operationId: OPERATION_ID, text: "幫我看部署", body: "幫我看部署\n\n(voice input)" });
      expect(h.postChatMessage).toHaveBeenCalledWith(CHAT_ID, "幫我看部署\n\n(voice input)", OPERATION_ID);
      expect(h.call.getSnapshot().sentLog).toEqual([{ operationId: OPERATION_ID, text: "幫我看部署", status: "sending" }]);
      // A repeated event for the same operation is not posted twice.
      h.socket.emit({ type: "dictation", operationId: OPERATION_ID, text: "幫我看部署", body: "幫我看部署\n\n(voice input)" });
      expect(h.postChatMessage).toHaveBeenCalledTimes(1);
      finish({ id: COMMENT_ID });
      await vi.waitFor(() => expect(h.call.getSnapshot().sentLog[0]?.status).toBe("sent"));
      expect(h.socket.json().at(-1)).toEqual({ type: "dictation_result", operationId: OPERATION_ID, status: "sent", commentId: COMMENT_ID });
    });

    it("reports a failed post to the relay and in the sent log", async () => {
      const h = await live({ postChatMessage: async () => { throw Object.assign(new Error("Request failed"), { body: { error: "Chat is closed" } }); } });
      h.socket.emit({ type: "dictation", operationId: OPERATION_ID, text: "你好", body: "你好 (voice)" });
      await vi.waitFor(() => expect(h.call.getSnapshot().sentLog[0]).toEqual({ operationId: OPERATION_ID, text: "你好", status: "failed", error: "Chat is closed" }));
      expect(h.socket.json().at(-1)).toEqual({ type: "dictation_result", operationId: OPERATION_ID, status: "failed", message: "Chat is closed" });
    });

    it("sends typed text to the relay instead of creating a draft", async () => {
      const h = await live();
      expect(h.call.sendText("  請回報進度 ")).toBe(true);
      expect(h.socket.json().at(-1)).toEqual({ type: "text", text: "請回報進度" });
    });

    it("ends an earlier live call on the same Chat and retries the start once with a new key", async () => {
      const h = setup({ firstStartError: { status: 409, body: { error: "End the existing call before starting another", code: "voice_call_already_active", details: { code: "voice_call_already_active", sessionId: "old-session" } } } });
      await h.call.start({ companyId: "c1", agentId: "agent-1", mode: "agent_chat" });
      expect(h.api.end).toHaveBeenCalledWith("c1", "old-session");
      expect(h.api.start).toHaveBeenCalledTimes(2);
      const [first, second] = h.api.start.mock.calls.map((call) => call[1]);
      expect(second).toMatchObject({ issueId: CHAT_ID, bindingMode: "agent_chat" });
      expect(second).not.toHaveProperty("newConversation");
      expect(second!.idempotencyKey).not.toBe(first!.idempotencyKey);
      expect(h.call.getSnapshot().notice).toBe("An earlier voice call on this Chat was ended.");
      expect(h.sockets).toHaveLength(1);

      const top = setup({ startError: { status: 409, body: { error: "busy", code: "voice_call_already_active", sessionId: "old-session" } } });
      await top.call.start({ companyId: "c1", agentId: "agent-1", mode: "agent_chat" });
      expect(top.api.start).toHaveBeenCalledTimes(2);
      expect(top.call.getSnapshot()).toMatchObject({ phase: "error", error: "busy" });
    });

    it("waits on end for the relay's final dictation and its post before closing", async () => {
      let finish!: (value: { id: string }) => void;
      const h = await live({ postChatMessage: () => new Promise((resolve) => { finish = resolve; }) });
      let ended = false;
      const ending = h.call.end().then(() => { ended = true; });
      expect(h.socket.json().at(-1)).toEqual({ type: "end" });
      expect(h.call.getSnapshot().phase).toBe("ending");
      h.socket.emit({ type: "dictation", operationId: OPERATION_ID, text: "最後一句", body: "最後一句 (voice)" });
      h.socket.emit({ type: "ended", reason: "caller_ended" });
      await Promise.resolve();
      expect(ended).toBe(false);
      // The microphone is released at once; only the post is awaited.
      expect(h.audio.closed).toBe(true);
      finish({ id: COMMENT_ID });
      await ending;
      expect(h.postChatMessage).toHaveBeenCalledWith(CHAT_ID, "最後一句 (voice)", OPERATION_ID);
      expect(h.socket.json().at(-1)).toEqual({ type: "dictation_result", operationId: OPERATION_ID, status: "sent", commentId: COMMENT_ID });
      expect(h.call.getSnapshot()).toMatchObject({ phase: "ended", endedReason: "Call ended.", sentLog: [{ status: "sent" }] });
      expect(h.audio.closed).toBe(true);
      expect(h.api.end).not.toHaveBeenCalled();
    });

    it("shows heard words that the relay did not send", async () => {
      const h = await live();
      h.socket.emit({ type: "dictation_dropped", text: "等你確認部署", reason: "echo" });
      h.socket.emit({ type: "dictation_dropped", text: "嗯", reason: "noise" });
      expect(h.call.getSnapshot().sentLog).toMatchObject([
        { text: "等你確認部署", status: "dropped", error: expect.stringContaining("assistant's own voice") },
        { text: "嗯", status: "dropped", error: expect.stringContaining("too short") },
      ]);
      expect(h.postChatMessage).not.toHaveBeenCalled();
    });

    it("stops waiting for the relay after the end timeout", async () => {
      vi.useFakeTimers();
      try {
        const h = await live();
        const ending = h.call.end();
        await vi.advanceTimersByTimeAsync(AGENT_CHAT_END_WAIT_MS);
        await ending;
        expect(h.call.getSnapshot().phase).toBe("ended");
        expect(h.audio.closed).toBe(true);
      } finally {
        vi.useRealTimers();
      }
    });
  });
});
