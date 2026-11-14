import { describe, expect, it, vi } from "vitest";
import type { LocalVoiceRelayServerEvent } from "@paperclipai/shared";
import { GeminiLiveRelay } from "../services/voice/gemini-live-relay.js";
import { OpenAIRealtimeRelay } from "../services/voice/openai-realtime-relay.js";
import { agentChatVoiceMessageBody, isDictationNoise, isLikelyEcho } from "../services/voice/voice-dictation.js";
import { joinDictation, type VoiceAgentReply, type VoiceRelayOptions, type VoiceTaskPort, type VoiceUpstreamHandlers } from "../services/voice/voice-relay-core.js";

/** HOM-326: the agent_chat binding dictates every finished utterance to the caller's Chat. */

interface FakeUpstream { handlers: VoiceUpstreamHandlers; sent: any[]; closed: boolean }

function harness(engine: "openai" | "gemini", options: { replies?: VoiceAgentReply[][]; mergeMs?: number; holdMs?: number; drainMs?: number } = {}) {
  const events: LocalVoiceRelayServerEvent[] = [];
  const upstreams: FakeUpstream[] = [];
  const replyBatches = [...(options.replies ?? [])];
  const watchers: (() => void)[] = [];
  const port = {
    status: vi.fn(async () => ({ status: "ok" })),
    submit: vi.fn(async (draft: { operationId: string }) => ({ status: "accepted" as const, operationId: draft.operationId })),
    newReplies: vi.fn(async () => replyBatches.shift() ?? []),
    watch: vi.fn((onChange: () => void) => { watchers.push(onChange); return () => undefined; }),
    end: vi.fn(async () => undefined),
  } satisfies VoiceTaskPort;
  const browser = { sendEvent: vi.fn((event: LocalVoiceRelayServerEvent) => { events.push(event); }), sendAudio: vi.fn(), close: vi.fn() };
  const relayOptions: VoiceRelayOptions = {
    browser, port,
    connectUpstream: async (handlers) => {
      const upstream: FakeUpstream = { handlers, sent: [], closed: false };
      upstreams.push(upstream);
      return { send: (json) => upstream.sent.push(JSON.parse(json)), close: () => { upstream.closed = true; } };
    },
    binding: { issueId: "chat-1", issueIdentifier: "HOM-1", issueTitle: "Chat with momo", agentName: "momo", mode: "agent_chat" },
    replyDebounceMs: 10,
    reconnectDelaysMs: [0],
    dictationMergeMs: options.mergeMs ?? 30,
    dictationHoldMs: options.holdMs ?? 2000,
    dictationDrainMs: options.drainMs ?? 1000,
  };
  const relay = engine === "openai" ? new OpenAIRealtimeRelay(relayOptions) : new GeminiLiveRelay(relayOptions);
  const current = () => upstreams[upstreams.length - 1]!;
  const fromModel = (message: unknown) => current().handlers.onMessage(JSON.stringify(message));
  const start = async () => {
    const started = relay.start();
    await vi.waitFor(() => expect(upstreams.length).toBe(1));
    if (engine === "openai") {
      fromModel({ type: "session.created", session: {} });
      fromModel({ type: "session.updated", session: {} });
    } else {
      fromModel({ setupComplete: {} });
    }
    await started;
  };
  const dictations = () => events.filter((event): event is Extract<LocalVoiceRelayServerEvent, { type: "dictation" }> => event.type === "dictation");
  const userTurns = () => current().sent.filter((m) => m.type === "conversation.item.create" && m.item?.role === "user").map((m) => m.item.content[0].text as string);
  /** OpenAI: one caller utterance, VAD start plus its transcription. */
  const say = (itemId: string, text: string, audioStartMs = 0) => {
    fromModel({ type: "input_audio_buffer.speech_started", item_id: itemId, audio_start_ms: audioStartMs });
    fromModel({ type: "conversation.item.input_audio_transcription.completed", item_id: itemId, transcript: text });
  };
  return { relay, port, events, upstreams, watchers, current, fromModel, start, dictations, userTurns, say };
}

describe("agent_chat dictation helpers", () => {
  it("drops fillers, lone acknowledgements and known transcription hallucinations", () => {
    for (const text of ["", "  ", "嗯", "好。", "好的", "對對", "OK", "謝謝觀看", "字幕由 Amara.org 社群提供", "請不吝點贊 訂閱 轉發 打賞支持明鏡與點點欄目"]) {
      expect(isDictationNoise(text), text).toBe(true);
    }
    for (const text of ["幫我看 HOM-326", "好，部署吧", "明天再說", "ok 那就這樣做"]) expect(isDictationNoise(text), text).toBe(false);
  });

  it("treats a transcription that repeats recent model speech as echo", () => {
    const spoken = "momo 回覆了：測試都通過，等你在畫面上確認部署。";
    expect(isLikelyEcho("測試都通過，等你在畫面上確認部署", spoken)).toBe(true);
    expect(isLikelyEcho("先不要部署，我晚點看", spoken)).toBe(false);
    expect(isLikelyEcho("隨便一句話", "")).toBe(false);
    // Too short to judge: a few shared characters prove nothing.
    expect(isLikelyEcho("部署", spoken)).toBe(false);
  });

  it("keeps the caller's words first and unchanged in the Chat body", () => {
    const body = agentChatVoiceMessageBody("幫我查 HOM-326 的進度");
    expect(body.startsWith("幫我查 HOM-326 的進度\n\n")).toBe(true);
    expect(body).toContain("語音摘要：");
    expect(body).toContain("不能當作核准");
    expect(joinDictation(["幫我查", " HOM-326 ", "的進度"])).toBe("幫我查HOM-326的進度");
    expect(joinDictation(["check", "HOM-326"])).toBe("check HOM-326");
  });
});

describe("OpenAI relay, agent_chat binding", () => {
  it("has no tools, never answers caller speech by itself and announces the binding", async () => {
    const h = harness("openai");
    await h.start();
    const [update] = h.current().sent.filter((m) => m.type === "session.update");
    expect(update.session.tools).toEqual([]);
    expect(update.session.audio.input.turn_detection).toMatchObject({ type: "server_vad", create_response: false, interrupt_response: true });
    expect(update.session.instructions).toContain("Chat");
    expect(update.session.instructions).not.toContain("prepare_request");
    expect(h.events[0]).toMatchObject({ type: "ready", bindingMode: "agent_chat", agentName: "momo" });
  });

  it("merges utterances after a quiet gap into one verbatim Taiwan Traditional dictation", async () => {
    const h = harness("openai");
    await h.start();
    h.say("i1", "帮我看一下");
    h.say("i2", "HOM-326 的进度");
    expect(h.dictations()).toHaveLength(0);
    await vi.waitFor(() => expect(h.dictations()).toHaveLength(1));
    const [dictation] = h.dictations();
    expect(dictation!.text).toBe("幫我看一下HOM-326 的進度");
    expect(dictation!.body).toBe(agentChatVoiceMessageBody(dictation!.text));
    // Caller speech alone never starts a model response.
    expect(h.current().sent.filter((m) => m.type === "response.create")).toHaveLength(0);
  });

  it("keeps merging while the caller is still speaking", async () => {
    const h = harness("openai", { mergeMs: 40, holdMs: 5000 });
    await h.start();
    h.say("i1", "第一句");
    h.fromModel({ type: "input_audio_buffer.speech_started", item_id: "i2", audio_start_ms: 10 });
    await new Promise((resolve) => setTimeout(resolve, 120));
    expect(h.dictations()).toHaveLength(0);
    h.fromModel({ type: "conversation.item.input_audio_transcription.completed", item_id: "i2", transcript: "第二句" });
    await vi.waitFor(() => expect(h.dictations()).toHaveLength(1));
    expect(h.dictations()[0]!.text).toBe("第一句第二句");
  });

  it("waits for an utterance still being transcribed before sending the earlier one", async () => {
    const h = harness("openai", { mergeMs: 30 });
    await h.start();
    // The second utterance starts before the first one's transcription arrives.
    h.fromModel({ type: "input_audio_buffer.speech_started", item_id: "a", audio_start_ms: 0 });
    h.fromModel({ type: "input_audio_buffer.speech_started", item_id: "b", audio_start_ms: 900 });
    h.fromModel({ type: "conversation.item.input_audio_transcription.completed", item_id: "a", transcript: "明天早上九點" });
    await new Promise((resolve) => setTimeout(resolve, 300));
    expect(h.dictations()).toHaveLength(0);
    h.fromModel({ type: "conversation.item.input_audio_transcription.completed", item_id: "b", transcript: "提醒我開會" });
    await vi.waitFor(() => expect(h.dictations()).toHaveLength(1));
    expect(h.dictations()[0]!.text).toBe("明天早上九點提醒我開會");
  });

  it("acknowledges a sent dictation briefly and reports a failed one", async () => {
    const h = harness("openai");
    await h.start();
    h.say("i1", "請把測試跑完");
    await vi.waitFor(() => expect(h.dictations()).toHaveLength(1));
    const { operationId } = h.dictations()[0]!;
    await h.relay.handleBrowserMessage({ type: "dictation_result", operationId, status: "sent", commentId: "11111111-1111-4111-8111-111111111111" });
    expect(h.userTurns().at(-1)).toContain("只說「收到」");
    expect(h.current().sent.filter((m) => m.type === "response.create")).toHaveLength(1);
    // A repeated or unknown result is ignored.
    await h.relay.handleBrowserMessage({ type: "dictation_result", operationId, status: "sent" });
    expect(h.userTurns().filter((text) => text.includes("收到"))).toHaveLength(1);

    h.fromModel({ type: "response.done", response: { id: "r1", status: "completed" } });
    h.say("i2", "再幫我檢查一次");
    await vi.waitFor(() => expect(h.dictations()).toHaveLength(2));
    await h.relay.handleBrowserMessage({ type: "dictation_result", operationId: h.dictations()[1]!.operationId, status: "failed", message: "403" });
    expect(h.userTurns().at(-1)).toContain("沒有送到");
  });

  it("drops fillers and speaker echo of the model's own speech", async () => {
    const h = harness("openai");
    await h.start();
    h.say("i1", "嗯");
    await new Promise((resolve) => setTimeout(resolve, 80));
    expect(h.dictations()).toHaveLength(0);
    // The model reads a reply summary; its echo is transcribed while it plays.
    h.fromModel({ type: "response.created", response: { id: "r1" } });
    h.fromModel({ type: "response.output_audio.delta", response_id: "r1", item_id: "a1", content_index: 0, delta: Buffer.alloc(48_000).toString("base64") });
    h.fromModel({ type: "response.output_audio_transcript.delta", response_id: "r1", delta: "momo 回覆了：測試都通過了，等你確認部署。" });
    h.say("echo", "測試都通過了，等你確認部署");
    h.say("real", "先不要部署");
    await vi.waitFor(() => expect(h.dictations()).toHaveLength(1));
    expect(h.dictations()[0]!.text).toBe("先不要部署");
    // The caller sees what was not sent.
    expect(h.events).toContainEqual({ type: "dictation_dropped", text: "測試都通過了，等你確認部署", reason: "echo" });
    expect(h.events).toContainEqual({ type: "dictation_dropped", text: "嗯", reason: "noise" });
  });

  it("never treats speech after playback as echo, even when it repeats the model", async () => {
    const h = harness("openai");
    await h.start();
    h.fromModel({ type: "response.created", response: { id: "r1" } });
    h.fromModel({ type: "response.output_audio.delta", response_id: "r1", item_id: "a1", content_index: 0, delta: Buffer.alloc(4_800).toString("base64") });
    h.fromModel({ type: "response.output_audio_transcript.delta", response_id: "r1", delta: "等你在畫面上確認部署。" });
    h.fromModel({ type: "response.done", response: { id: "r1", status: "completed" } });
    await h.relay.handleBrowserMessage({ type: "playback", playing: false });
    await new Promise((resolve) => setTimeout(resolve, 150));
    h.say("later", "等你在畫面上確認部署", 5_000);
    await vi.waitFor(() => expect(h.dictations()).toHaveLength(1));
    expect(h.dictations()[0]!.text).toBe("等你在畫面上確認部署");
  });

  it("on End commits the caller's unfinished utterance and waits for its transcription", async () => {
    const h = harness("openai", { mergeMs: 5000, drainMs: 2000 });
    await h.start();
    h.fromModel({ type: "input_audio_buffer.speech_started", item_id: "tail", audio_start_ms: 100 });
    const ending = h.relay.handleBrowserMessage({ type: "end" });
    await vi.waitFor(() => expect(h.current().sent.some((m) => m.type === "input_audio_buffer.commit")).toBe(true));
    expect(h.events.some((event) => event.type === "ended")).toBe(false);
    h.fromModel({ type: "conversation.item.input_audio_transcription.completed", item_id: "tail", transcript: "最後補一句" });
    await ending;
    const types = h.events.map((event) => event.type);
    expect(h.dictations().map((d) => d.text)).toEqual(["最後補一句"]);
    expect(types.indexOf("dictation")).toBeLessThan(types.indexOf("ended"));
  });

  it("flushes buffered words when the relay itself ends the call", async () => {
    const h = harness("openai", { mergeMs: 5000 });
    await h.start();
    h.say("i1", "時間到之前說的話");
    await h.relay.end("max_duration");
    const types = h.events.map((event) => event.type);
    expect(h.dictations().map((d) => d.text)).toEqual(["時間到之前說的話"]);
    expect(types.indexOf("dictation")).toBeLessThan(types.indexOf("ended"));
  });

  it("sends typed text at once and flushes buffered words on pause and on end", async () => {
    const h = harness("openai", { mergeMs: 5000 });
    await h.start();
    await h.relay.handleBrowserMessage({ type: "text", text: "  打字的訊息  " });
    expect(h.dictations().map((d) => d.text)).toEqual(["打字的訊息"]);
    h.say("i1", "說到一半就暫停");
    await h.relay.handleBrowserMessage({ type: "mic", state: "paused" });
    expect(h.dictations().map((d) => d.text)).toEqual(["打字的訊息", "說到一半就暫停"]);
    await h.relay.handleBrowserMessage({ type: "mic", state: "live" });
    h.say("i2", "最後一句話");
    await h.relay.handleBrowserMessage({ type: "end" });
    const types = h.events.map((event) => event.type);
    expect(h.dictations().at(-1)!.text).toBe("最後一句話");
    expect(types.lastIndexOf("dictation")).toBeLessThan(types.indexOf("ended"));
    expect(h.port.end).toHaveBeenCalledWith("caller_ended");
  });

  it("reads agent replies from the Chat: the voice summary, else a short spoken summary", async () => {
    const h = harness("openai", { replies: [[{ commentId: "c1", body: "完整內容\n語音摘要：測試都過了。", voiceSummary: "測試都過了。", spoken: "測試都過了。", createdAt: "2026-11-14T00:00:00.000Z" }]] });
    await h.start();
    h.watchers[0]!();
    await vi.waitFor(() => expect(h.userTurns().some((text) => text.includes("「測試都過了。」"))).toBe(true));
    expect(h.events.some((event) => event.type === "agent_reply" && event.commentId === "c1")).toBe(true);
  });
});

describe("Gemini relay, agent_chat binding", () => {
  it("has no tools, merges transcription fragments and adds no second acknowledgement", async () => {
    const h = harness("gemini");
    await h.start();
    const setup = h.current().sent[0].setup;
    expect(setup.tools).toEqual([]);
    expect(setup.systemInstruction.parts[0].text).toContain("Chat");
    h.fromModel({ serverContent: { inputTranscription: { text: "帮我" } } });
    h.fromModel({ serverContent: { inputTranscription: { text: "看看进度" } } });
    await vi.waitFor(() => expect(h.dictations()).toHaveLength(1));
    expect(h.dictations()[0]!.text).toBe("幫我看看進度");
    // A short fragment that happens to share words with the model's acknowledgement is kept.
    h.fromModel({ serverContent: { modelTurn: { parts: [{ inlineData: { mimeType: "audio/pcm;rate=24000", data: Buffer.alloc(480).toString("base64") } }] }, outputTranscription: { text: "收到，部署前再確認" } } });
    h.fromModel({ serverContent: { inputTranscription: { text: "部署" } } });
    h.fromModel({ serverContent: { inputTranscription: { text: "先暫停" } } });
    await vi.waitFor(() => expect(h.dictations()).toHaveLength(2));
    expect(h.dictations()[1]!.text).toBe("部署先暫停");
    const before = h.current().sent.length;
    await h.relay.handleBrowserMessage({ type: "dictation_result", operationId: h.dictations()[0]!.operationId, status: "sent" });
    expect(h.current().sent.length).toBe(before);
  });
});
