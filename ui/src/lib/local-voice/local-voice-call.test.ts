// @vitest-environment jsdom
import { describe, expect, it, vi } from "vitest";
import { LOCAL_VOICE_RELAY_PROTOCOL, LOCAL_VOICE_RELAY_TOKEN_PREFIX, LOCAL_VOICE_RELAY_VOICE_PREFIX } from "@paperclipai/shared";
import { AGENT_CHAT_END_WAIT_MS, localVoiceActivity, LocalVoiceCall, type LocalVoiceCallDependencies, type VoiceAudioEngine } from "./local-voice-call";

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
const READY = { type: "ready", issueId: CHAT_ID, issueIdentifier: "HOM-1", agentName: "momo", maxSeconds: 900, warningSeconds: 600, inputSampleRate: 24_000, bindingMode: "agent_chat", policyVersion: "main_answer_v1" };

function setup(options: { startError?: unknown; firstStartError?: unknown; findChatMessage?: LocalVoiceCallDependencies["findChatMessage"]; postChatMessage?: LocalVoiceCallDependencies["postChatMessage"] } = {}) {
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
    ringback: vi.fn(),
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
    findChatMessage: options.findChatMessage,
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
  it("plays the ringback tone while connecting and stops it when the relay is ready", async () => {
    const h = setup();
    await h.call.start({ companyId: "c1", agentId: "agent-1", mode: "agent_chat" });
    expect(h.audio.ringback).toHaveBeenCalledWith(true);
    expect(h.audio.ringback).not.toHaveBeenCalledWith(false);
    h.sockets[0]!.emit(READY);
    expect(h.audio.ringback).toHaveBeenLastCalledWith(false);
    expect(h.call.getSnapshot().phase).toBe("live");
  });

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

  it("offers the agent's chosen voice as an extra relay subprotocol, and nothing for no or an unknown voice (HOM-265)", async () => {
    const token = `${LOCAL_VOICE_RELAY_TOKEN_PREFIX}${"T".repeat(43)}`;
    const chosen = setup();
    await chosen.call.start({ companyId: "c1", agentId: "agent-1", mode: "agent_chat", voiceName: "Cedar" });
    expect(chosen.sockets[0]!.protocols).toEqual([LOCAL_VOICE_RELAY_PROTOCOL, token, `${LOCAL_VOICE_RELAY_VOICE_PREFIX}cedar`]);
    // The session start request itself is unchanged: the voice travels only with the relay upgrade.
    expect(chosen.api.start).toHaveBeenCalledWith("c1", expect.not.objectContaining({ voiceName: expect.anything() }));
    for (const voiceName of [undefined, null, "Kore", "marin; drop"]) {
      const h = setup();
      await h.call.start({ companyId: "c1", agentId: "agent-1", mode: "agent_chat", voiceName });
      expect(h.sockets[0]!.protocols).toEqual([LOCAL_VOICE_RELAY_PROTOCOL, token]);
    }
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
      expect(h.postChatMessage).toHaveBeenCalledWith(CHAT_ID, "幫我看部署\n\n(voice input)", OPERATION_ID, "session-1");
      expect(h.call.getSnapshot().sentLog).toEqual([{ operationId: OPERATION_ID, text: "幫我看部署", status: "sending" }]);
      // A repeated event for the same operation is not posted twice.
      h.socket.emit({ type: "dictation", operationId: OPERATION_ID, text: "幫我看部署", body: "幫我看部署\n\n(voice input)" });
      expect(h.postChatMessage).toHaveBeenCalledTimes(1);
      finish({ id: COMMENT_ID });
      await vi.waitFor(() => expect(h.call.getSnapshot().sentLog[0]?.status).toBe("sent"));
      expect(h.socket.json().at(-1)).toEqual({ type: "dictation_result", operationId: OPERATION_ID, status: "sent", commentId: COMMENT_ID });
    });

    it("reports a failed post to the relay and in the sent log", async () => {
      const h = await live({ postChatMessage: async () => { throw Object.assign(new Error("Request failed"), { status: 403, body: { error: "Chat is closed" } }); } });
      h.socket.emit({ type: "dictation", operationId: OPERATION_ID, text: "你好", body: "你好 (voice)" });
      await vi.waitFor(() => expect(h.call.getSnapshot().sentLog[0]).toEqual({ operationId: OPERATION_ID, text: "你好", status: "failed", error: "Chat is closed" }));
      expect(h.socket.json().at(-1)).toEqual({ type: "dictation_result", operationId: OPERATION_ID, status: "failed", message: "Chat is closed" });
    });

    it("looks up an uncertain POST once and reports the stored receipt without resending", async () => {
      const findChatMessage = vi.fn(async () => ({ id: COMMENT_ID }));
      const h = await live({ postChatMessage: async () => { throw new TypeError("Network lost"); }, findChatMessage });
      h.socket.emit({ type: "dictation", operationId: OPERATION_ID, turnId: "turn-one", text: "對", body: "對" });
      await vi.waitFor(() => expect(h.call.getSnapshot().sentLog[0]?.status).toBe("sent"));
      expect(findChatMessage).toHaveBeenCalledWith(CHAT_ID, OPERATION_ID);
      expect(findChatMessage).toHaveBeenCalledTimes(1);
      expect(h.call.getSnapshot().turns[0]).toMatchObject({ state: "stored", inputCommentId: COMMENT_ID });
      h.socket.emit({ type: "resumed", contextKept: true });
      h.socket.emit({ type: "dictation", operationId: OPERATION_ID, text: "對", body: "對" });
      expect(h.postChatMessage).toHaveBeenCalledTimes(1);
      expect(h.socket.json().at(-1)).toEqual({ type: "dictation_result", operationId: OPERATION_ID, status: "sent", commentId: COMMENT_ID });
    });

    it.each([undefined, 500])("keeps unresolved delivery visibly unknown for status %s", async (status) => {
      const findChatMessage = vi.fn(async () => null);
      const h = await live({ postChatMessage: async () => { throw Object.assign(new Error("Lost"), { status }); }, findChatMessage });
      h.socket.emit({ type: "dictation", operationId: OPERATION_ID, turnId: "turn-one", text: "問題", body: "問題" });
      await vi.waitFor(() => expect(h.call.getSnapshot().sentLog[0]?.status).toBe("unknown"));
      expect(h.socket.json().at(-1)).toMatchObject({ type: "dictation_result", status: "unknown" });
      expect(localVoiceActivity(h.call.getSnapshot())).toBe("送出結果不明");
      expect(h.postChatMessage).toHaveBeenCalledTimes(1);
    });

    it("surfaces a failed receipt lookup without retrying either request", async () => {
      const findChatMessage = vi.fn(async () => { throw new Error("Lookup unavailable"); });
      const h = await live({ postChatMessage: async () => { throw new Error("Connection lost"); }, findChatMessage });
      h.socket.emit({ type: "dictation", operationId: OPERATION_ID, turnId: "one", text: "問題", body: "問題" });
      await vi.waitFor(() => expect(h.call.getSnapshot().sentLog[0]?.error).toContain("收據查詢失敗：Lookup unavailable"));
      expect(h.postChatMessage).toHaveBeenCalledTimes(1);
      expect(findChatMessage).toHaveBeenCalledTimes(1);
    });

    it("retains operation deduplication beyond the visible log", async () => {
      const h = await live();
      for (let index = 0; index < 51; index++) h.socket.emit({ type: "dictation", operationId: `op-${index}`, text: "對", body: "對" });
      await vi.waitFor(() => expect(h.call.getSnapshot().sentLog.at(-1)?.status).toBe("sent"));
      expect(h.call.getSnapshot().sentLog).toHaveLength(50);
      h.socket.emit({ type: "dictation", operationId: "op-0", text: "對", body: "對" });
      expect(h.postChatMessage).toHaveBeenCalledTimes(51);
    });

    it("does not regress a processed turn on late stored receipts or duplicate events", async () => {
      let finish!: (value: { id: string }) => void;
      const h = await live({ postChatMessage: () => new Promise((resolve) => { finish = resolve; }) });
      h.socket.emit({ type: "dictation", operationId: OPERATION_ID, turnId: "one", text: "查一下", body: "查一下" });
      h.socket.emit({ type: "voice_turn", turnId: "one", state: "processing", runId: "run" });
      finish({ id: COMMENT_ID });
      await vi.waitFor(() => expect(h.call.getSnapshot().sentLog[0]?.status).toBe("sent"));
      h.socket.emit({ type: "voice_turn", turnId: "one", state: "sending" });
      expect(h.call.getSnapshot().turns).toEqual([expect.objectContaining({ state: "processing", inputCommentId: COMMENT_ID, runId: "run" })]);
      expect(localVoiceActivity(h.call.getSnapshot())).toBe("等待回答");
    });

    it("keeps same-text answers distinct and replays only a selected interrupted answer", async () => {
      const h = await live();
      for (const id of ["first", "second"]) {
        h.socket.emit({ type: "agent_reply", commentId: id, body: "好", voiceSummary: "好", createdAt: "now", turnIds: [id], playbackState: "queued" });
      }
      h.socket.emit({ type: "voice_turn", turnId: "first", answerCommentId: "first", state: "speaking" });
      h.socket.emit({ type: "interrupted" });
      h.socket.emit({ type: "voice_turn", turnId: "first", state: "completed" });
      h.socket.emit({ type: "agent_reply", commentId: "first", body: "好", voiceSummary: "好", createdAt: "now", playbackState: "queued" });
      expect(h.call.getSnapshot().turns[0].state).toBe("interrupted");
      expect(h.call.getSnapshot().replies).toHaveLength(2);
      expect(h.call.getSnapshot().replies[0].playbackState).toBe("interrupted");
      expect(h.socket.json()).toEqual([]);
      expect(h.call.replayReply("missing")).toBe(false);
      expect(h.call.replayReply("first")).toBe(true);
      expect(h.call.replayReply("first")).toBe(false);
      expect(h.socket.json()).toEqual([{ type: "replay_reply", commentId: "first" }]);
      h.socket.emit({ type: "voice_turn", turnId: "first", state: "speaking" });
      expect(h.call.getSnapshot().turns[0].state).toBe("speaking");
      expect(h.api.end).not.toHaveBeenCalled();
    });

    it("keeps legacy sessions off the replay policy and treats duplicate ready as a no-op", async () => {
      const h = setup();
      await h.call.start({ companyId: "c1", agentId: "agent-1", mode: "agent_chat" });
      const socket = h.sockets[0];
      socket.emit({ ...READY, policyVersion: undefined });
      socket.emit(READY);
      socket.emit({ type: "agent_reply", commentId: "legacy", body: "Answer", voiceSummary: "Answer", createdAt: "now" });
      expect(h.call.getSnapshot().policyVersion).toBeUndefined();
      expect(h.call.replayReply("legacy")).toBe(false);
      expect(socket.json()).toEqual([]);
    });

    it("ignores a closed call's late socket messages after a new call starts", async () => {
      const h = await live();
      const old = h.socket;
      const ending = h.call.end();
      old.emit({ type: "ended", reason: "caller_ended" });
      await ending;
      await h.call.start({ companyId: "c1", agentId: "agent-1", mode: "agent_chat" });
      old.emit({ type: "dictation", operationId: OPERATION_ID, text: "舊問題", body: "舊問題" });
      old.onmessage?.({ data: new ArrayBuffer(8) });
      expect(h.postChatMessage).not.toHaveBeenCalled();
      expect(h.audio.played).toHaveLength(0);
      expect(h.call.getSnapshot().sentLog).toEqual([]);
    });

    it("binds each POST to its captured session and ignores the previous call's late receipt", async () => {
      let finish!: (value: { id: string }) => void;
      let count = 0;
      const h = await live({ postChatMessage: async () => ++count === 1
        ? new Promise<{ id: string }>((resolve) => { finish = resolve; }) : { id: COMMENT_ID } });
      h.socket.emit({ type: "dictation", operationId: OPERATION_ID, text: "舊問題", body: "舊問題" });
      h.socket.close();
      h.socket.onclose?.();
      await vi.waitFor(() => expect(h.call.getSnapshot().phase).toBe("error"));
      h.api.start.mockResolvedValueOnce({ session: { id: "session-2", issueId: CHAT_ID } as never,
        media: { transportToken: "T".repeat(43) } as never });
      await h.call.start({ companyId: "c1", agentId: "agent-1", mode: "agent_chat" });
      const current = h.sockets.at(-1)!;
      current.emit(READY);
      current.emit({ type: "dictation", operationId: "new-operation", text: "新問題", body: "新問題" });
      await vi.waitFor(() => expect(h.call.getSnapshot().sentLog[0]?.status).toBe("sent"));
      finish({ id: "old-comment" });
      await Promise.resolve();
      await Promise.resolve();
      expect(h.postChatMessage).toHaveBeenNthCalledWith(1, CHAT_ID, "舊問題", OPERATION_ID, "session-1");
      expect(h.postChatMessage).toHaveBeenNthCalledWith(2, CHAT_ID, "新問題", "new-operation", "session-2");
      expect(h.call.getSnapshot().sentLog).toEqual([expect.objectContaining({ operationId: "new-operation", commentId: COMMENT_ID })]);
      expect(current.json()).toEqual([{ type: "dictation_result", operationId: "new-operation", status: "sent", commentId: COMMENT_ID }]);
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
      expect(h.postChatMessage).toHaveBeenCalledWith(CHAT_ID, "最後一句 (voice)", OPERATION_ID, "session-1");
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
