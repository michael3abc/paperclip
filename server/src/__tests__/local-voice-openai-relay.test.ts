import { describe, expect, it, vi } from "vitest";
import type { LocalVoiceRelayServerEvent } from "@paperclipai/shared";
import { loadLocalVoiceGatewayConfig } from "../services/voice/local-voice-gateway-config.js";
import { OpenAIRealtimeRelay } from "../services/voice/openai-realtime-relay.js";
import type { VoiceAgentReply, VoiceTaskPort, VoiceUpstreamHandlers } from "../services/voice/voice-relay-core.js";
import { toTaiwanTraditional } from "../services/voice/zh-tw.js";

interface FakeUpstream { handlers: VoiceUpstreamHandlers; sent: any[]; closed: boolean }

function harness(options: { replies?: VoiceAgentReply[][]; transcriptGraceMs?: number } = {}) {
  const events: LocalVoiceRelayServerEvent[] = [];
  const audio: Buffer[] = [];
  const upstreams: FakeUpstream[] = [];
  const watchers: (() => void)[] = [];
  const replyBatches = [...(options.replies ?? [])];
  let clock = 1_000_000;
  const port = {
    status: vi.fn(async (identifier?: string) => ({ status: "ok", identifier: identifier ?? null })),
    submit: vi.fn(async (draft: { operationId: string }, _via: "spoken" | "ui") => ({ status: "accepted" as const, operationId: draft.operationId })),
    newReplies: vi.fn(async () => replyBatches.shift() ?? []),
    watch: vi.fn((onChange: () => void) => { watchers.push(onChange); return () => undefined; }),
    end: vi.fn(async () => undefined),
  } satisfies VoiceTaskPort;
  const browser = { sendEvent: vi.fn((event: LocalVoiceRelayServerEvent) => { events.push(event); }), sendAudio: vi.fn((pcm: Buffer) => { audio.push(pcm); }), close: vi.fn() };
  const relay = new OpenAIRealtimeRelay({
    browser, port,
    connectUpstream: async (handlers) => {
      const upstream: FakeUpstream = { handlers, sent: [], closed: false };
      upstreams.push(upstream);
      return { send: (json) => upstream.sent.push(JSON.parse(json)), close: () => { upstream.closed = true; } };
    },
    binding: { issueId: "issue-1", issueIdentifier: "HOM-900", issueTitle: "語音對話", agentName: "michael" },
    model: "gpt-realtime-1.5",
    now: () => clock,
    transcriptGraceMs: options.transcriptGraceMs ?? 0,
    replyDebounceMs: 10,
    reconnectDelaysMs: [0, 0],
  });
  const current = () => upstreams[upstreams.length - 1]!;
  const fromModel = (message: unknown, upstream = current()) => upstream.handlers.onMessage(JSON.stringify(message));
  const ready = async (upstream?: FakeUpstream) => {
    await vi.waitFor(() => expect(upstreams.length).toBeGreaterThan(0));
    const target = upstream ?? current();
    fromModel({ type: "session.created", session: {} }, target);
    fromModel({ type: "session.updated", session: {} }, target);
  };
  const sent = (type: string, upstream = current()) => upstream.sent.filter((m) => m.type === type);
  const outputFor = async (callId: string) => {
    let found: any;
    await vi.waitFor(() => {
      found = upstreams.flatMap((u) => u.sent).find((m) => m.type === "conversation.item.create" && m.item?.call_id === callId);
      expect(found).toBeTruthy();
    });
    return JSON.parse(found.item.output);
  };
  const toolCall = (callId: string, name: string, args: Record<string, unknown>) => {
    fromModel({ type: "response.created", response: { id: `r-${callId}` } });
    fromModel({ type: "response.function_call_arguments.done", call_id: callId, name, arguments: JSON.stringify(args), item_id: `fc-${callId}` });
    fromModel({ type: "response.done", response: { id: `r-${callId}`, status: "completed", usage: { input_tokens: 10, output_tokens: 2, total_tokens: 12 } } });
  };
  /** One spoken model response: audio (1 s) plus its transcript. */
  const speak = (id: string, text: string, status = "completed") => {
    fromModel({ type: "response.created", response: { id } });
    fromModel({ type: "response.output_audio.delta", response_id: id, item_id: `a-${id}`, content_index: 0, delta: Buffer.alloc(48_000).toString("base64") });
    fromModel({ type: "response.output_audio_transcript.delta", response_id: id, delta: text });
    fromModel({ type: "response.done", response: { id, status, usage: { input_tokens: 100, output_tokens: 50, total_tokens: 150, input_token_details: { audio_tokens: 80, text_tokens: 20, cached_tokens: 64 }, output_token_details: { audio_tokens: 40, text_tokens: 10 } } } });
  };
  const advance = (ms: number) => { clock += ms; };
  return { relay, port, browser, events, audio, upstreams, watchers, current, fromModel, ready, sent, outputFor, toolCall, speak, advance };
}

async function started(options?: Parameters<typeof harness>[0]) {
  const h = harness(options);
  const start = h.relay.start();
  await h.ready();
  await start;
  return h;
}

describe("OpenAIRealtimeRelay", () => {
  it("configures a GA realtime session after session.created and announces a 24 kHz relay", async () => {
    const h = await started();
    const [update] = h.sent("session.update");
    expect(update.session).toMatchObject({
      type: "realtime",
      output_modalities: ["audio"],
      tool_choice: "auto",
      audio: {
        input: {
          format: { type: "audio/pcm", rate: 24000 },
          transcription: { model: "gpt-4o-transcribe", language: "zh" },
          turn_detection: { type: "server_vad", create_response: true, interrupt_response: true },
        },
        output: { format: { type: "audio/pcm", rate: 24000 }, voice: "marin" },
      },
    });
    expect(update.session.audio.input.transcription.prompt).toContain("繁體");
    expect(update.session.tools.map((tool: any) => tool.name)).toEqual(["query_task_status", "prepare_request", "submit_request", "get_updates"]);
    expect(update.session.tools[1]).toMatchObject({ type: "function", parameters: { type: "object", properties: { text: { type: "string" } }, required: ["text"] } });
    expect(update.session.instructions).toContain("HOM-900");
    expect(h.events[0]).toMatchObject({ type: "ready", inputSampleRate: 24000, maxSeconds: 900, warningSeconds: 600 });
  });

  it("fails the call when the session update is rejected", async () => {
    const h = harness();
    const start = h.relay.start();
    await vi.waitFor(() => expect(h.upstreams).toHaveLength(1));
    h.fromModel({ type: "session.created" });
    h.fromModel({ type: "error", error: { code: "invalid_value" } });
    await start;
    expect(h.events.at(-1)).toEqual({ type: "ended", reason: "upstream_unavailable" });
  });

  it("streams microphone audio, forwards model audio and clears the input buffer on pause", async () => {
    const h = await started();
    h.relay.handleBrowserAudio(Buffer.from([1, 0, 2, 0]));
    expect(h.sent("input_audio_buffer.append")).toEqual([{ type: "input_audio_buffer.append", audio: Buffer.from([1, 0, 2, 0]).toString("base64") }]);
    h.fromModel({ type: "response.created", response: { id: "r1" } });
    h.fromModel({ type: "response.output_audio.delta", item_id: "a1", content_index: 0, delta: Buffer.from([9, 9]).toString("base64") });
    expect(h.audio[0]).toEqual(Buffer.from([9, 9]));
    await h.relay.handleBrowserMessage({ type: "mic", state: "paused" });
    expect(h.current().sent.at(-1)).toEqual({ type: "input_audio_buffer.clear" });
    h.relay.handleBrowserAudio(Buffer.from([1, 0]));
    expect(h.sent("input_audio_buffer.append")).toHaveLength(1);
  });

  it("answers a tool call with a function_call_output and one response.create after the response finishes", async () => {
    const h = await started();
    h.fromModel({ type: "response.created", response: { id: "r1" } });
    h.fromModel({ type: "response.output_item.added", item: { type: "function_call", id: "fc1", name: "query_task_status", call_id: "c1" } });
    h.fromModel({ type: "response.function_call_arguments.done", call_id: "c1", item_id: "fc1", arguments: "{\"identifier\":\" HOM-307 \"}" });
    expect(await h.outputFor("c1")).toEqual({ status: "ok", identifier: "HOM-307" });
    expect(h.sent("response.create")).toHaveLength(0); // the calling response is still active
    h.fromModel({ type: "response.done", response: { id: "r1", status: "completed" } });
    expect(h.sent("response.create")).toHaveLength(1);
    h.fromModel({ type: "response.function_call_arguments.done", call_id: "c2", name: "get_updates", arguments: "not json" });
    expect(await h.outputFor("c2")).toMatchObject({ status: "pending" });
  });

  it("submits only after a full read-back and the caller's own 確認送出 transcribed after the tool call", async () => {
    const h = await started({ transcriptGraceMs: 2000 });
    h.toolCall("p1", "prepare_request", { text: "請 michael 查昨天部署失敗的原因" });
    const prepared = await h.outputFor("p1");
    expect(prepared).toMatchObject({ status: "draft_ready", revision: 1 });
    h.speak("r2", "草稿是：请 michael 查昨天部署失败的原因。請說確認送出。");
    await h.relay.handleBrowserMessage({ type: "playback", playing: false });
    h.advance(2000);
    h.fromModel({ type: "input_audio_buffer.speech_started", item_id: "u1", audio_start_ms: 10 });
    h.fromModel({ type: "input_audio_buffer.speech_stopped", item_id: "u1" });
    // The model calls submit before gpt-4o-transcribe finishes; the relay waits for the transcript.
    h.fromModel({ type: "response.created", response: { id: "r3" } });
    h.fromModel({ type: "response.function_call_arguments.done", call_id: "s1", name: "submit_request", arguments: JSON.stringify({ draftId: prepared.draftId }) });
    setTimeout(() => h.fromModel({ type: "conversation.item.input_audio_transcription.completed", item_id: "u1", transcript: "确认送出。", usage: { input_tokens: 7, output_tokens: 3 } }), 50);
    expect(await h.outputFor("s1")).toMatchObject({ status: "accepted" });
    expect(h.port.submit).toHaveBeenCalledTimes(1);
    expect(h.port.submit.mock.calls[0]![1]).toBe("spoken");
    expect(h.events).toContainEqual({ type: "transcript", role: "user", text: "確認送出。" });
    expect(h.events.filter((e) => e.type === "transcript" && e.role === "model").map((e: any) => e.text).join("")).toContain("部署失敗");
  });

  it("does not accept 確認送出 heard while the read-back still plays, or after the caller cut the read-back off", async () => {
    const h = await started();
    h.toolCall("p1", "prepare_request", { text: "請 michael 重新部署" });
    const prepared = await h.outputFor("p1");
    h.speak("r2", "草稿是：請 michael 重新部署。");
    // Browser still playing: speaker echo cannot confirm.
    h.fromModel({ type: "input_audio_buffer.speech_started", item_id: "u1" });
    h.fromModel({ type: "conversation.item.input_audio_transcription.completed", item_id: "u1", transcript: "確認送出" });
    h.toolCall("s1", "submit_request", { draftId: prepared.draftId });
    expect(await h.outputFor("s1")).toMatchObject({ status: "confirmation_required" });
    expect(h.port.submit).not.toHaveBeenCalled();

    const cut = await started();
    cut.toolCall("p1", "prepare_request", { text: "請 michael 重新部署" });
    const draft = await cut.outputFor("p1");
    cut.speak("r2", "草稿是：請 michael 重新部署。");
    cut.advance(200); // 0.2 s of a 1 s read-back played
    cut.fromModel({ type: "input_audio_buffer.speech_started", item_id: "u1" });
    expect(cut.sent("conversation.item.truncate")).toEqual([{ type: "conversation.item.truncate", item_id: "a-r2", content_index: 0, audio_end_ms: 200 }]);
    expect(cut.events.at(-1)).toEqual({ type: "interrupted" });
    expect(cut.relay.snapshot.draft?.recited).toBe(false);
    await cut.relay.handleBrowserMessage({ type: "playback", playing: false });
    cut.fromModel({ type: "input_audio_buffer.speech_started", item_id: "u2", audio_start_ms: 5000 });
    cut.fromModel({ type: "conversation.item.input_audio_transcription.completed", item_id: "u2", transcript: "確認送出" });
    cut.toolCall("s1", "submit_request", { draftId: draft.draftId });
    expect(await cut.outputFor("s1")).toMatchObject({ status: "confirmation_required" });
  });

  it("cancels an active response on barge-in", async () => {
    const h = await started();
    h.fromModel({ type: "response.created", response: { id: "r1" } });
    h.fromModel({ type: "response.output_audio.delta", item_id: "a1", content_index: 0, delta: Buffer.alloc(4800).toString("base64") });
    h.advance(50);
    h.fromModel({ type: "input_audio_buffer.speech_started", item_id: "u1" });
    expect(h.sent("response.cancel")).toHaveLength(1);
    expect(h.sent("conversation.item.truncate")[0]).toMatchObject({ item_id: "a1", audio_end_ms: 50 });
    h.fromModel({ type: "response.done", response: { id: "r1", status: "cancelled" } });
    expect((h.relay.snapshot as Record<string, unknown>).activeResponse).toBe(false);
  });

  it("speaks an agent voice summary as a user item once no response or tool call is pending", async () => {
    const reply: VoiceAgentReply = { commentId: "c1", body: "內容\n語音摘要：部署好了。", voiceSummary: "部署好了。", spoken: "部署好了。", createdAt: "2026-11-14T00:00:00.000Z" };
    const h = await started({ replies: [[reply]] });
    h.fromModel({ type: "response.created", response: { id: "r1" } });
    h.watchers[0]!();
    await vi.waitFor(() => expect(h.events.some((e) => e.type === "agent_reply")).toBe(true));
    expect(h.sent("conversation.item.create")).toHaveLength(0);
    h.fromModel({ type: "response.done", response: { id: "r1", status: "completed" } });
    const [item] = h.sent("conversation.item.create");
    expect(item.item).toMatchObject({ type: "message", role: "user" });
    expect(item.item.content[0].text).toContain("「部署好了。」");
    expect(h.sent("response.create")).toHaveLength(1);
  });

  it("reconnects with recent conversation and the open draft in the new session's instructions", async () => {
    const h = await started();
    h.fromModel({ type: "input_audio_buffer.speech_started", item_id: "u1" });
    h.fromModel({ type: "conversation.item.input_audio_transcription.completed", item_id: "u1", transcript: "帮我留言给 michael" });
    h.toolCall("p1", "prepare_request", { text: "請 michael 檢查磁碟" });
    const prepared = await h.outputFor("p1");
    h.speak("r2", "草稿是：請 michael 檢查磁碟。");
    const first = h.current();
    first.handlers.onClose(1006, "gone");
    await vi.waitFor(() => expect(h.upstreams).toHaveLength(2));
    h.relay.handleBrowserAudio(Buffer.from([7, 0]));
    await h.ready(h.upstreams[1]);
    await vi.waitFor(() => expect(h.events).toContainEqual({ type: "resumed", contextKept: true }));
    const instructions = h.sent("session.update", h.upstreams[1])[0].session.instructions as string;
    expect(instructions).toContain("Owner：幫我留言給 michael");
    expect(instructions).toContain("助理：草稿是：請 michael 檢查磁碟。");
    expect(instructions).toContain(prepared.draftId);
    expect(instructions).toContain("草稿已覆誦過");
    // The draft was read back, so audio held during the switch is dropped (it could carry a confirmation).
    expect(h.sent("input_audio_buffer.append", h.upstreams[1])).toHaveLength(0);
    // Frames from the retired connection are ignored.
    first.handlers.onMessage(JSON.stringify({ type: "response.output_audio_transcript.delta", delta: "old" }));
    expect(h.events.some((e) => e.type === "transcript" && e.text === "old")).toBe(false);
  });

  it("drops a tool result for a replaced session", async () => {
    let release!: () => void;
    const h = harness();
    h.port.status.mockImplementation(() => new Promise((resolve) => { release = () => resolve({ status: "ok", identifier: null }); }));
    const start = h.relay.start(); await h.ready(); await start;
    h.fromModel({ type: "response.function_call_arguments.done", call_id: "c1", name: "query_task_status", arguments: "{}" });
    h.current().handlers.onClose(1006, "gone");
    await vi.waitFor(() => expect(h.upstreams).toHaveLength(2));
    await h.ready(h.upstreams[1]);
    await vi.waitFor(() => expect(h.events.some((e) => e.type === "resumed")).toBe(true));
    release();
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(h.upstreams.flatMap((u) => u.sent).some((m) => m.item?.call_id === "c1")).toBe(false);
    expect((h.relay.snapshot as Record<string, unknown>).pendingToolCalls).toBe(0);
  });

  it("sums response and transcription usage for the call log", async () => {
    const log = vi.fn();
    const h = harness();
    (h.relay as any).log = log;
    const start = h.relay.start(); await h.ready(); await start;
    h.speak("r1", "你好");
    h.speak("r2", "再見");
    h.fromModel({ type: "conversation.item.input_audio_transcription.completed", item_id: "u9", transcript: "嗯", usage: { input_tokens: 7, output_tokens: 3 } });
    expect(h.relay.snapshot.usage).toMatchObject({ responses: 2, inputTokens: 200, outputTokens: 100, totalTokens: 300, inputAudioTokens: 160, cachedInputTokens: 128, outputAudioTokens: 80, transcriptions: 1, transcriptionInputTokens: 7 });
    await h.relay.end("caller_ended");
    expect(log).toHaveBeenCalledWith("voice_relay_ended", expect.objectContaining({ engine: "openai", model: "gpt-realtime-1.5", usage: expect.objectContaining({ totalTokens: 300 }) }));
  });
});

describe("OpenAIRealtimeRelay review hardening", () => {
  async function recitedDraft(h: Awaited<ReturnType<typeof started>>, text: string) {
    h.toolCall("p1", "prepare_request", { text });
    const prepared = await h.outputFor("p1");
    h.speak("r2", `草稿是：${text}。`);
    return prepared;
  }

  it("drops microphone audio buffered during a reconnect while a read-back awaits confirmation", async () => {
    const h = await started();
    await recitedDraft(h, "請 michael 重新部署");
    h.current().handlers.onClose(1006, "gone");
    await vi.waitFor(() => expect(h.upstreams).toHaveLength(2));
    h.relay.handleBrowserAudio(Buffer.from([7, 0])); // could be 「確認送出」 over the read-back, or its echo
    await h.ready(h.upstreams[1]);
    await vi.waitFor(() => expect(h.events.some((e) => e.type === "resumed")).toBe(true));
    expect(h.sent("input_audio_buffer.append", h.upstreams[1])).toHaveLength(0);
  });

  it("judges an utterance by when it began: speech that started before playback drained cannot confirm", async () => {
    const h = await started();
    const prepared = await recitedDraft(h, "請 michael 重新部署");
    h.advance(1000);
    for (let i = 0; i < 10; i++) h.relay.handleBrowserAudio(Buffer.alloc(4800)); // 1 s of microphone audio
    await h.relay.handleBrowserMessage({ type: "playback", playing: false });
    // VAD reports speech that began 300 ms before the browser drained playback.
    h.fromModel({ type: "input_audio_buffer.speech_started", item_id: "u1", audio_start_ms: 700 });
    h.fromModel({ type: "conversation.item.input_audio_transcription.completed", item_id: "u1", transcript: "確認送出" });
    h.toolCall("s1", "submit_request", { draftId: prepared.draftId });
    expect(await h.outputFor("s1")).toMatchObject({ status: "confirmation_required" });
    // The model answers the refusal (no audio) before the caller speaks again.
    h.fromModel({ type: "response.created", response: { id: "r4" } });
    h.fromModel({ type: "response.done", response: { id: "r4", status: "completed" } });
    h.fromModel({ type: "input_audio_buffer.speech_started", item_id: "u2", audio_start_ms: 1200 });
    h.fromModel({ type: "conversation.item.input_audio_transcription.completed", item_id: "u2", transcript: "確認送出" });
    h.toolCall("s2", "submit_request", { draftId: prepared.draftId });
    expect(await h.outputFor("s2")).toMatchObject({ status: "accepted" });
  });

  it("holds notices until playback drains, and a cut-off read-back is unheard even after a notice played", async () => {
    const reply: VoiceAgentReply = { commentId: "c1", body: "語音摘要：好了。", voiceSummary: "好了。", spoken: "好了。", createdAt: "x" };
    const h = await started({ replies: [[reply]] });
    await recitedDraft(h, "請 michael 檢查磁碟空間");
    h.watchers[0]!();
    await vi.waitFor(() => expect(h.events.some((e) => e.type === "agent_reply")).toBe(true));
    expect(h.sent("conversation.item.create").filter((m) => m.item.type === "message")).toHaveLength(0); // read-back still playing
    // A notice response replaces the current audio item; the caller then cuts in early.
    h.speak("r3", "通知");
    h.advance(300);
    h.fromModel({ type: "input_audio_buffer.speech_started", item_id: "u1", audio_start_ms: 0 });
    expect(h.relay.snapshot.draft?.recited).toBe(false);
    await h.relay.handleBrowserMessage({ type: "playback", playing: false });
    expect(h.sent("conversation.item.create").filter((m) => m.item.type === "message")).toHaveLength(1);
  });

  it("counts a read-back whose captions OpenCC rewrote, and only speech after the draft", async () => {
    const h = await started();
    h.fromModel({ type: "response.created", response: { id: "r0" } });
    h.fromModel({ type: "response.output_audio_transcript.delta", response_id: "r0", delta: "請 michael 檢查軟件後台" });
    h.fromModel({ type: "response.function_call_arguments.done", call_id: "p1", name: "prepare_request", arguments: JSON.stringify({ text: "請 michael 檢查軟件後台" }) });
    await h.outputFor("p1");
    h.fromModel({ type: "response.done", response: { id: "r0", status: "completed" } });
    expect(h.relay.snapshot.draft?.recited).toBe(false); // spoken before the draft existed
    h.speak("r2", "草稿：請 michael 檢查軟件後台。");
    expect(h.relay.snapshot.draft?.recited).toBe(true);
  });

  it("recovers from a rejected response.create and drops late audio of a cancelled response", async () => {
    const h = await started();
    await h.relay.handleBrowserMessage({ type: "text", text: "你好" });
    expect(h.sent("response.create")).toHaveLength(1);
    expect((h.relay.snapshot as Record<string, unknown>).activeResponse).toBe(true);
    h.fromModel({ type: "error", error: { code: "invalid_value" } });
    expect((h.relay.snapshot as Record<string, unknown>).activeResponse).toBe(false);
    expect(h.relay.snapshot.modelTurnActive).toBe(false);

    h.fromModel({ type: "response.created", response: { id: "r9" } });
    h.fromModel({ type: "response.output_audio.delta", response_id: "r9", item_id: "a9", delta: Buffer.alloc(480).toString("base64") });
    h.fromModel({ type: "input_audio_buffer.speech_started", item_id: "u1", audio_start_ms: 0 });
    const played = h.audio.length;
    h.fromModel({ type: "response.output_audio.delta", response_id: "r9", item_id: "a9", delta: Buffer.alloc(480).toString("base64") });
    h.fromModel({ type: "response.output_audio_transcript.delta", response_id: "r9", delta: "晚到" });
    expect(h.audio).toHaveLength(played);
    expect(h.events.some((e) => e.type === "transcript" && e.text === "晚到")).toBe(false);
  });

  it("keeps a new session's tool call pending when an old session's result is dropped", async () => {
    let releaseOld!: () => void;
    const h = harness();
    h.port.status.mockImplementationOnce(() => new Promise((resolve) => { releaseOld = () => resolve({ status: "ok", identifier: null }); }));
    const start = h.relay.start(); await h.ready(); await start;
    h.fromModel({ type: "response.function_call_arguments.done", call_id: "old", name: "query_task_status", arguments: "{}" });
    h.current().handlers.onClose(1006, "gone");
    await vi.waitFor(() => expect(h.upstreams).toHaveLength(2));
    await h.ready(h.upstreams[1]);
    await vi.waitFor(() => expect(h.events.some((e) => e.type === "resumed")).toBe(true));
    let releaseNew!: () => void;
    h.port.status.mockImplementationOnce(() => new Promise((resolve) => { releaseNew = () => resolve({ status: "ok", identifier: null }); }));
    h.fromModel({ type: "response.function_call_arguments.done", call_id: "new", name: "query_task_status", arguments: "{}" });
    releaseOld();
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect((h.relay.snapshot as Record<string, unknown>).pendingToolCalls).toBe(1);
    expect(h.sent("response.create", h.upstreams[1])).toHaveLength(0);
    releaseNew();
    expect(await h.outputFor("new")).toMatchObject({ status: "ok" });
    expect(h.sent("response.create", h.upstreams[1])).toHaveLength(1);
  });
});

describe("local voice engine configuration", () => {
  const base = { PAPERCLIP_LOCAL_VOICE_GATEWAY_URL: "ws://192.168.66.11:8792/", PAPERCLIP_LOCAL_VOICE_GATEWAY_KEY_FILE: "/tmp/key" };
  it("defaults to OpenAI gpt-realtime-1.5 with the marin voice", () => {
    expect(loadLocalVoiceGatewayConfig(base)).toEqual({ url: "ws://192.168.66.11:8792", keyFile: "/tmp/key", engine: "openai", model: "gpt-realtime-1.5", voiceName: "marin" });
  });
  it("switches back to Gemini by engine or by a Gemini model name", () => {
    expect(loadLocalVoiceGatewayConfig({ ...base, PAPERCLIP_LOCAL_VOICE_ENGINE: "gemini" })).toMatchObject({ engine: "gemini", model: "gemini-3.8-live", voiceName: "Kore" });
    expect(loadLocalVoiceGatewayConfig({ ...base, PAPERCLIP_LOCAL_VOICE_MODEL: "gemini-3.8-live" })).toMatchObject({ engine: "gemini" });
    expect(loadLocalVoiceGatewayConfig({ ...base, PAPERCLIP_LOCAL_VOICE_ENGINE: "OpenAI", PAPERCLIP_LOCAL_VOICE_MODEL: "gpt-realtime-2" })).toMatchObject({ engine: "openai", model: "gpt-realtime-2" });
    expect(loadLocalVoiceGatewayConfig({ ...base, PAPERCLIP_LOCAL_VOICE_ENGINE: "whisper" })).toBeNull();
    expect(loadLocalVoiceGatewayConfig({ ...base, PAPERCLIP_LOCAL_VOICE_NAME: "Kore" })).toMatchObject({ engine: "openai", voiceName: "marin" });
    expect(loadLocalVoiceGatewayConfig({ ...base, PAPERCLIP_LOCAL_VOICE_NAME: "Cedar" })).toMatchObject({ voiceName: "cedar" });
  });
});

describe("Taiwan Traditional conversion", () => {
  it("converts Simplified transcription to Taiwan Traditional and keeps Traditional text and names", () => {
    expect(toTaiwanTraditional("确认送出")).toBe("確認送出");
    expect(toTaiwanTraditional("帮我查 HOM-265 paperclip 的软件进度")).toBe("幫我查 HOM-265 paperclip 的軟體進度");
    expect(toTaiwanTraditional("請 michael 查部署")).toBe("請 michael 查部署");
  });
});
