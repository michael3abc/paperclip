import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { LocalVoiceRelayServerEvent } from "@paperclipai/shared";
import { GeminiLiveRelay } from "../services/voice/gemini-live-relay.js";
import { OpenAIRealtimeRelay } from "../services/voice/openai-realtime-relay.js";
import type { VoiceAgentReply, VoiceRelayOptions, VoiceTaskPort, VoiceUpstreamHandlers } from "../services/voice/voice-relay-core.js";

type Engine = "openai" | "gemini";
const activeRelays: (OpenAIRealtimeRelay | GeminiLiveRelay)[] = [];

function harness(engine: Engine, policyVersion: "main_answer_v1" | "natural_chat_v2" = "main_answer_v1") {
  const events: LocalVoiceRelayServerEvent[] = [];
  const sockets: { handlers: VoiceUpstreamHandlers; sent: any[] }[] = [];
  const replies: VoiceAgentReply[] = [];
  const receipts = new Map<string, string>();
  let notify = () => {};
  const port = {
    status: vi.fn(async () => ({})),
    submit: vi.fn(async (draft) => ({ status: "accepted" as const, operationId: draft.operationId })),
    newReplies: vi.fn(async () => replies.splice(0)),
    resolveInput: vi.fn(async (id) => receipts.get(id) ?? null),
    watch: vi.fn((fn) => { notify = fn; return () => {}; }),
    end: vi.fn(async () => {}),
  } satisfies VoiceTaskPort;
  const browser = { sendEvent: (event: LocalVoiceRelayServerEvent) => { events.push(event); }, sendAudio: vi.fn(), close: vi.fn() };
  const options: VoiceRelayOptions = {
    browser, port,
    connectUpstream: async (handlers) => {
      const socket = { handlers, sent: [] as any[] };
      sockets.push(socket);
      return { send: (json) => { socket.sent.push(JSON.parse(json)); }, close: () => {} };
    },
    binding: { mode: "agent_chat", policyVersion, issueId: "chat-1", issueIdentifier: "HOM-1", agentName: "momo", issueTitle: "Chat" },
    dictationMergeMs: 30, dictationHoldMs: 2000, dictationDrainMs: 0,
    replyDebounceMs: 10, reconnectDelaysMs: [0],
  };
  const relay = engine === "openai" ? new OpenAIRealtimeRelay(options) : new GeminiLiveRelay(options);
  activeRelays.push(relay);
  const current = () => sockets[sockets.length - 1]!;
  const fromModel = (event: unknown) => current().handlers.onMessage(JSON.stringify(event));
  const ready = () => {
    if (engine === "openai") {
      fromModel({ type: "session.created", session: {} });
      fromModel({ type: "session.updated", session: {} });
    } else fromModel({ setupComplete: {} });
  };
  const start = async () => { const pending = relay.start(); await Promise.resolve(); ready(); await pending; };
  const dictations = () => events.filter((event): event is Extract<LocalVoiceRelayServerEvent, { type: "dictation" }> => event.type === "dictation");
  const turns = () => events.filter((event): event is Extract<LocalVoiceRelayServerEvent, { type: "voice_turn" }> => event.type === "voice_turn");
  const spoken = () => current().sent.flatMap((frame) => engine === "openai"
    ? frame.type === "conversation.item.create" && frame.item?.role === "user" ? [frame.item.content[0].text as string] : []
    : frame.clientContent?.turns?.flatMap((turn: any) => turn.parts.map((part: any) => part.text as string)) ?? []);
  const say = (id: string, text: string, finish = true) => {
    if (engine === "openai") {
      fromModel({ type: "input_audio_buffer.speech_started", item_id: id, audio_start_ms: 10_000 });
      fromModel({ type: "input_audio_buffer.speech_stopped", item_id: id });
      fromModel({ type: "conversation.item.input_audio_transcription.completed", item_id: id, transcript: text });
    } else {
      fromModel({ serverContent: { inputTranscription: { text } } });
      if (finish) fromModel({ serverContent: { turnComplete: true } });
    }
  };
  const store = async (index = dictations().length - 1) => {
    const dictation = dictations()[index]!;
    const commentId = `input-${index}`;
    receipts.set(dictation.operationId, commentId);
    await relay.handleBrowserMessage({ type: "dictation_result", operationId: dictation.operationId, status: "sent", commentId });
    return commentId;
  };
  const reply = async (id: string, sources: string[], summary: string | null = "我還需要知道你要哪個版本。") => {
    replies.push({ commentId: id, sourceCommentIds: sources, runId: "run-1", body: "完整詳細文字", voiceSummary: summary, spoken: summary ?? "完整詳細文字", createdAt: new Date().toISOString() });
    notify();
    await vi.advanceTimersByTimeAsync(11);
  };
  const audio = (id = "response-1") => {
    if (engine === "openai") {
      fromModel({ type: "response.created", response: { id } });
      fromModel({ type: "response.output_audio.delta", response_id: id, item_id: `audio-${id}`, delta: Buffer.alloc(4800).toString("base64") });
    } else fromModel({ serverContent: { modelTurn: { parts: [{ inlineData: { mimeType: "audio/pcm;rate=24000", data: Buffer.alloc(4800).toString("base64") } }] } } });
  };
  const finish = async (id = "response-1") => {
    if (engine === "openai") fromModel({ type: "response.done", response: { id, status: "completed" } });
    else fromModel({ serverContent: { turnComplete: true } });
    await relay.handleBrowserMessage({ type: "playback", playing: false });
  };
  return { relay, port, browser, events, sockets, receipts, current, fromModel, ready, start, dictations, turns, spoken, say, store, reply, audio, finish };
}

beforeEach(() => { vi.useFakeTimers(); vi.setSystemTime(0); });
afterEach(async () => {
  for (const relay of activeRelays.splice(0)) relay.handleBrowserClosed();
  await Promise.resolve();
  vi.clearAllTimers();
  vi.useRealTimers();
});

describe.each<Engine>(["openai", "gemini"])("%s main-answer policy", (engine) => {
  it("forwards substantive discussion verbatim, accepts a main question, and keeps meaningful short answers", async () => {
    const h = harness(engine);
    await h.start();
    h.say("s-1", "你覺得這個設計如何？");
    await vi.advanceTimersByTimeAsync(31);
    expect(h.dictations()).toHaveLength(1);
    expect(h.dictations()[0].text).toBe("你覺得這個設計如何？");
    expect(h.spoken()).toEqual([]);
    const source = await h.store();
    await h.reply("reply-1", [source]);
    expect(h.spoken()).toHaveLength(1);
    expect(h.spoken()[0]).toContain("我還需要知道你要哪個版本。");
    expect(h.spoken()[0]).not.toContain("我確認一下");
    h.audio();
    await h.finish();
    h.say("s-2", "對");
    await vi.advanceTimersByTimeAsync(31);
    expect(h.dictations().map((entry) => entry.text)).toEqual(["你覺得這個設計如何？", "對"]);
    expect(h.port.submit).not.toHaveBeenCalled();
  });

  it("says each waiting notice once only after the stored receipt", async () => {
    const h = harness(engine);
    await h.start();
    h.say("s-1", "目前進度如何？");
    await vi.advanceTimersByTimeAsync(31);
    await vi.advanceTimersByTimeAsync(1000);
    expect(h.spoken()).toEqual([]);
    await h.store();
    await vi.advanceTimersByTimeAsync(800);
    expect(h.spoken()).toHaveLength(1);
    expect(h.spoken()[0]).toContain("我確認一下。");
    h.audio("ack");
    await h.finish("ack");
    await vi.advanceTimersByTimeAsync(19_200);
    expect(h.spoken()).toHaveLength(2);
    expect(h.spoken()[1]).toContain("還在等結果。");
    h.audio("wait");
    await h.finish("wait");
    await vi.advanceTimersByTimeAsync(30_000);
    expect(h.spoken()).toHaveLength(2);
  });

  it("plays identical summaries for distinct answers and never synthesizes a missing summary", async () => {
    const h = harness(engine);
    await h.start();
    for (let index = 0; index < 3; index += 1) {
      h.say(`s-${index}`, `請回答第${index}個問題`);
      await vi.advanceTimersByTimeAsync(31);
      const source = await h.store();
      await h.reply(`reply-${index}`, [source], index < 2 ? "還沒有結果。" : null);
      h.audio(`response-${index}`);
      await h.finish(`response-${index}`);
    }
    expect(h.spoken()).toHaveLength(3);
    expect(h.spoken()[0]).toBe(h.spoken()[1]);
    expect(h.spoken()[2]).toContain("我已經回覆在對話中，請看畫面的文字。");
    expect(h.spoken()[2]).not.toContain("完整詳細文字");
  });

  it("keeps a late old answer silent after barge-in, permits explicit replay, and never cancels main", async () => {
    const h = harness(engine);
    await h.start();
    h.say("s-1", "先看第一個問題");
    await vi.advanceTimersByTimeAsync(31);
    const oldSource = await h.store();
    h.say("s-2", "再補充第二個問題");
    await vi.advanceTimersByTimeAsync(31);
    const newSource = await h.store();
    await h.reply("old", [oldSource], "舊答案。");
    expect(h.spoken()).toHaveLength(0);
    await h.reply("new", [newSource], "新答案。");
    expect(h.spoken()).toHaveLength(1);
    h.audio();
    await h.finish();
    await h.relay.handleBrowserMessage({ type: "replay_reply", commentId: "old" });
    expect(h.spoken()).toHaveLength(2);
    expect(h.spoken()[1]).toContain("舊答案。");
    expect(h.port.end).not.toHaveBeenCalled();
    expect(h.port.submit).not.toHaveBeenCalled();
  });

  it("resolves an unknown write by its existing receipt without resending, including early answers", async () => {
    const h = harness(engine);
    await h.start();
    h.say("s-1", "目前有哪些選項？");
    await vi.advanceTimersByTimeAsync(31);
    const input = h.dictations()[0];
    await h.reply("reply", ["input-0"]);
    expect(h.spoken()).toHaveLength(0);
    await h.relay.handleBrowserMessage({ type: "dictation_result", operationId: input.operationId, status: "unknown" });
    expect(h.turns().at(-1)?.state).toBe("unknown");
    await h.store();
    expect(h.spoken()).toHaveLength(1);
    await h.store();
    await h.reply("reply", ["input-0"]);
    expect(h.spoken()).toHaveLength(1);
    expect(h.dictations()).toHaveLength(1);
  });

  it("reconnects without resending already stored input or replaying an answer", async () => {
    const h = harness(engine);
    await h.start();
    h.say("s-1", "請問目前狀態？");
    await vi.advanceTimersByTimeAsync(31);
    const source = await h.store();
    await h.reply("reply", [source]);
    h.audio();
    h.current().handlers.onClose(1006, "test-disconnect");
    await Promise.resolve();
    h.ready();
    await Promise.resolve();
    await Promise.resolve();
    await h.reply("reply", [source]);
    expect(h.sockets).toHaveLength(2);
    expect(h.dictations()).toHaveLength(1);
    expect(h.spoken().some((text) => text.includes("我還需要知道你要哪個版本。"))).toBe(false);
  });

  it("recovers an unknown receipt on an answer notification without another browser receipt or write", async () => {
    const h = harness(engine);
    await h.start();
    h.say("s-1", "請問目前狀態？");
    await vi.advanceTimersByTimeAsync(31);
    const input = h.dictations()[0];
    await h.relay.handleBrowserMessage({ type: "dictation_result", operationId: input.operationId, status: "unknown" });
    expect(h.turns().at(-1)?.state).toBe("unknown");
    h.receipts.set(input.operationId, "late-input"); // The original write committed after its response was lost.
    await h.reply("late-answer", ["late-input"]);
    expect(h.turns().some((turn) => turn.inputCommentId === "late-input" && turn.state === "stored")).toBe(true);
    expect(h.spoken()).toHaveLength(1);
    expect(h.dictations()).toHaveLength(1);
    expect(h.port.submit).not.toHaveBeenCalled();
  });

  it("keeps distinct answer IDs for the same input and summary while rejecting duplicate delivery", async () => {
    const h = harness(engine);
    await h.start();
    h.say("s-1", "請確認這個結果");
    await vi.advanceTimersByTimeAsync(31);
    const source = await h.store();
    await h.reply("answer-1", [source], "已經確認。");
    h.audio("r1");
    await h.finish("r1");
    await h.reply("answer-2", [source], "已經確認。");
    h.audio("r2");
    await h.finish("r2");
    await h.reply("answer-2", [source], "已經確認。");
    expect(h.spoken()).toHaveLength(2);
    expect(h.spoken()[0]).toBe(h.spoken()[1]);
  });

  it("publishes complete combined-answer sources and a terminal receipt when replaying an older answer", async () => {
    const h = harness(engine);
    await h.start();
    h.say("s-1", "第一個問題");
    await vi.advanceTimersByTimeAsync(31);
    const first = await h.store();
    h.say("s-2", "再補充第二個問題");
    await vi.advanceTimersByTimeAsync(31);
    const second = await h.store();
    await h.reply("combined", [first, second]);
    const combined = h.events.filter((event) => event.type === "agent_reply" && event.commentId === "combined");
    expect(combined.some((event) => event.type === "agent_reply" && event.playbackState === "interrupted")).toBe(false);
    expect(combined.at(-1)).toMatchObject({ playbackState: "queued", turnIds: h.dictations().map((entry) => entry.turnId) });
    h.audio("combined-audio");
    await h.finish("combined-audio");
    await h.reply("newer", [first, second], "補上更完整的答案。");
    h.audio("newer-audio");
    await h.finish("newer-audio");
    const turnsBeforeReplay = h.turns().length;
    await h.relay.handleBrowserMessage({ type: "replay_reply", commentId: "combined" });
    h.audio("replay-audio");
    await h.finish("replay-audio");
    expect(h.events.filter((event) => event.type === "agent_reply" && event.commentId === "combined").at(-1))
      .toMatchObject({ playbackState: "completed" });
    expect(h.turns()).toHaveLength(turnsBeforeReplay);
  });
});

describe("main-answer transport boundaries", () => {
  it("releases rejected OpenAI playback so an explicit replay and subsequent answer can proceed", async () => {
    const h = harness("openai");
    await h.start();
    h.say("s-1", "請確認第一個問題");
    await vi.advanceTimersByTimeAsync(31);
    const source = await h.store();
    await h.reply("first", [source]);
    h.fromModel({ type: "error", error: { code: "server_error", message: "response.create rejected" } });
    expect(h.events.some((event) => event.type === "error" && event.code === "playback_failed")).toBe(true);
    expect(h.turns().at(-1)).toMatchObject({ answerCommentId: "first", state: "interrupted" });
    await h.relay.handleBrowserMessage({ type: "replay_reply", commentId: "first" });
    expect(h.spoken()).toHaveLength(2);
    h.audio("replay-first");
    await h.finish("replay-first");
    h.say("s-2", "接著請確認第二個問題");
    await vi.advanceTimersByTimeAsync(31);
    await h.reply("second", [await h.store()]);
    expect(h.spoken()).toHaveLength(3);
    h.audio("second-response");
    await h.finish("second-response");
    expect(h.events.filter((event) => event.type === "agent_reply" && event.commentId === "second").at(-1))
      .toMatchObject({ playbackState: "completed" });
    expect(h.dictations()).toHaveLength(2);
  });

  it("rejects unsolicited OpenAI answers even if a provider ignores create_response=false", async () => {
    const h = harness("openai");
    await h.start();
    h.audio("unsolicited");
    expect(h.browser.sendAudio).not.toHaveBeenCalled();
  });

  it("drops OpenAI audio whose response.created arrives after barge-in", async () => {
    const h = harness("openai");
    await h.start();
    h.say("s-1", "請給我一個建議");
    await vi.advanceTimersByTimeAsync(31);
    const source = await h.store();
    await h.reply("reply", [source]); // response.create sent; response.created still in flight.
    h.say("s-2", "先等一下");
    h.audio("late-created");
    expect(h.browser.sendAudio).not.toHaveBeenCalled();
  });

  it("ignores a duplicate old response.done while a newer OpenAI answer is playing", async () => {
    const h = harness("openai");
    await h.start();
    h.say("s-1", "第一個問題");
    await vi.advanceTimersByTimeAsync(31);
    await h.reply("first", [await h.store()]);
    h.audio("response-old");
    await h.finish("response-old");
    h.say("s-2", "第二個問題");
    await vi.advanceTimersByTimeAsync(31);
    await h.reply("second", [await h.store()]);
    h.audio("response-new");
    h.fromModel({ type: "response.done", response: { id: "response-old", status: "completed" } });
    expect(h.relay.snapshot.modelTurnActive).toBe(true);
    expect(h.turns().at(-1)).toMatchObject({ answerCommentId: "second", state: "speaking" });
  });

  it("drops audio and captions delivered after the completed response", async () => {
    const h = harness("openai");
    await h.start();
    h.say("s-1", "第一個問題");
    await vi.advanceTimersByTimeAsync(31);
    await h.reply("first", [await h.store()]);
    h.audio("response-old");
    await h.finish("response-old");
    const count = h.browser.sendAudio.mock.calls.length;
    h.fromModel({ type: "response.output_audio.delta", response_id: "response-old", item_id: "audio-old", delta: Buffer.alloc(4800).toString("base64") });
    h.fromModel({ type: "response.output_audio_transcript.delta", response_id: "response-old", delta: "不應再播" });
    expect(h.browser.sendAudio).toHaveBeenCalledTimes(count);
    expect(h.relay.snapshot.modelTurnActive).toBe(false);
    expect(h.events.some(event => event.type === "transcript" && event.text === "不應再播")).toBe(false);
  });

  it("shows a finite transcription failure instead of silently swallowing missing route events", async () => {
    const h = harness("openai");
    await h.start();
    h.fromModel({ type: "input_audio_buffer.speech_started", item_id: "lost", audio_start_ms: 0 });
    h.fromModel({ type: "input_audio_buffer.speech_stopped", item_id: "lost" });
    await vi.advanceTimersByTimeAsync(20_001);
    expect(h.events.some((event) => event.type === "error" && /辨識|轉錄|語音/.test(event.message))).toBe(true);
    expect(h.dictations()).toHaveLength(0);
  });

  it("does not mistake Gemini's original unsolicited answer for a fast main reply", async () => {
    const h = harness("gemini");
    await h.start();
    h.say("s-1", "請討論這個設計", false);
    await vi.advanceTimersByTimeAsync(31);
    const source = await h.store();
    await h.reply("reply", [source]);
    h.audio(); // Still the response to caller audio, not the subsequent notice.
    expect(h.browser.sendAudio).not.toHaveBeenCalled();
    h.fromModel({ serverContent: { turnComplete: true } });
    expect(h.spoken()).toHaveLength(1);
    h.audio();
    expect(h.browser.sendAudio).toHaveBeenCalledTimes(1);
  });
});


describe.each<Engine>(["openai", "gemini"])("%s natural chat", (engine) => {
  function routeId(h: ReturnType<typeof harness>) {
    return JSON.parse(h.spoken().findLast(text => text.startsWith("[Paperclip 閒聊回合]"))!.replace("[Paperclip 閒聊回合] ", "")).turnId;
  }
  function routeTool(h: ReturnType<typeof harness>, args: object, name = "forward_to_main", callId = "forward-1") {
    if (engine === "openai") h.fromModel({ type: "response.function_call_arguments.done", response_id: "local", call_id: callId, name, arguments: JSON.stringify(args) });
    else h.fromModel({ toolCall: { functionCalls: [{ id: callId, name, args }] } });
  }
  async function startRoute(h: ReturnType<typeof harness>, text: string) {
    h.say("speech-1", text);
    await vi.advanceTimersByTimeAsync(31);
    if (engine === "openai") h.fromModel({ type: "response.created", response: { id: "local" } });
  }
  it.each(["喂嗨", "我覺得這個不錯", "今天好累，想聊聊天"])("answers %s locally without a main wake or waiting notice", async text => {
    const h = harness(engine, "natural_chat_v2");
    await h.start();
    await startRoute(h, text);
    expect(h.spoken()[0]).toContain(text);
    expect(h.dictations()).toHaveLength(0);
    if (engine === "openai") {
      h.fromModel({ type: "response.output_audio_transcript.delta", response_id: "local", delta: "我在，想聊什麼？" });
      h.fromModel({ type: "response.output_audio.delta", response_id: "local", item_id: "a", delta: Buffer.alloc(480).toString("base64") });
    } else h.fromModel({ serverContent: { outputTranscription: { text: "我在，想聊什麼？" }, modelTurn: { parts: [{ inlineData: { mimeType: "audio/pcm;rate=24000", data: Buffer.alloc(480).toString("base64") } }] } } });
    await h.finish("local");
    await vi.advanceTimersByTimeAsync(1000);
    expect(h.browser.sendAudio).toHaveBeenCalled();
    expect(h.dictations()).toHaveLength(0);
    expect(h.spoken().join(" ")).not.toContain("我確認一下");
    expect(h.port.status).not.toHaveBeenCalled();
    expect(h.port.submit).not.toHaveBeenCalled();
  });
  it("forwards only server-held words once and plays only a source-bound main answer", async () => {
    const h = harness(engine, "natural_chat_v2");
    await h.start();
    await startRoute(h, "幫我查 Career 設定");
    const token = routeId(h);
    routeTool(h, { turnId: token });
    routeTool(h, { turnId: token }, "forward_to_main", "duplicate");
    await Promise.resolve();
    expect(h.dictations().map(d => d.text)).toEqual(["幫我查 Career 設定"]);
    await h.finish("local");
    if (engine === "openai") expect(h.current().sent.filter(f => f.type === "response.create")).toHaveLength(1);
    const source = await h.store();
    await h.reply("main-answer", [source], "Career 已經設定為 CC Pocket Bridge。");
    expect(h.spoken().at(-1)).toContain("Career 已經設定為 CC Pocket Bridge");
    h.audio("main");
    await h.finish("main");
    expect(h.turns().at(-1)).toMatchObject({ state: "completed", answerCommentId: "main-answer" });
    expect(h.port.submit).not.toHaveBeenCalled();
  });
  it("rejects fabricated tokens, rewritten input and task tools", async () => {
    const h = harness(engine, "natural_chat_v2");
    await h.start();
    await startRoute(h, "查一下進度");
    routeTool(h, { turnId: "other" });
    routeTool(h, { turnId: routeId(h), text: "改寫的要求" });
    routeTool(h, {}, "submit_request");
    routeTool(h, {}, "query_task_status");
    await Promise.resolve();
    expect(h.dictations()).toHaveLength(0);
    expect(h.port.submit).not.toHaveBeenCalled();
    expect(h.port.status).not.toHaveBeenCalled();
    expect(h.events.some(e => e.type === "error" && e.code === "voice_route_rejected")).toBe(true);
  });
  it("cannot reuse a route token during main-answer playback", async () => {
    const h = harness(engine, "natural_chat_v2");
    await h.start();
    await startRoute(h, "幫我查進度");
    const token = routeId(h);
    routeTool(h, { turnId: token });
    await Promise.resolve();
    await h.finish("local");
    await h.reply("main", [await h.store()], "查好了。");
    if (engine === "openai") h.fromModel({ type: "response.created", response: { id: "local" } });
    routeTool(h, { turnId: token });
    await Promise.resolve();
    expect(h.dictations()).toHaveLength(1);
    expect(h.events.some(e => e.type === "error" && e.code === "voice_route_rejected")).toBe(true);
  });
  it("rejects a route interrupted by new speech and reports unsent work", async () => {
    const h = harness(engine, "natural_chat_v2");
    await h.start();
    await startRoute(h, "幫我查進度");
    const token = routeId(h);
    h.say("speech-2", "先等一下");
    routeTool(h, { turnId: token });
    await Promise.resolve();
    expect(h.dictations()).toHaveLength(0);
    expect(h.events.some(e => e.type === "error" && e.code === "voice_chat_interrupted")).toBe(true);
  });
  it("reports an unfinished route on hangup without sending it to main", async () => {
    const h = harness(engine, "natural_chat_v2");
    await h.start();
    await startRoute(h, "幫我查進度");
    await h.relay.handleBrowserMessage({ type: "end" });
    expect(h.dictations()).toHaveLength(0);
    expect(h.events.some(e => e.type === "error" && e.code === "voice_chat_interrupted")).toBe(true);
  });
  it("rejects an old connection token after reconnect without resending input", async () => {
    const h = harness(engine, "natural_chat_v2");
    await h.start();
    await startRoute(h, "幫我查進度");
    const token = routeId(h);
    h.current().handlers.onClose(1006, "test-disconnect");
    await Promise.resolve();
    h.ready();
    await Promise.resolve();
    routeTool(h, { turnId: token });
    await Promise.resolve();
    expect(h.dictations()).toHaveLength(0);
  });
  it("flushes an early main answer after the tool result settles", async () => {
    const h = harness(engine, "natural_chat_v2");
    await h.start();
    await startRoute(h, "幫我查進度");
    routeTool(h, { turnId: routeId(h) });
    // response.done can arrive in the same batch, before runToolCall's continuation.
    const completed = h.finish("local");
    await h.reply("early", [await h.store()], "目前還在處理。");
    await completed;
    expect(h.spoken().at(-1)).toContain("目前還在處理");
    h.audio("early-audio");
    expect(h.browser.sendAudio).toHaveBeenCalled();
  });
  it("suppresses output in the same frame as a forward tool call", async () => {
    if (engine !== "gemini") return;
    const h = harness(engine, "natural_chat_v2");
    await h.start();
    await startRoute(h, "幫我查進度");
    h.fromModel({
      toolCall: { functionCalls: [{ id: "forward", name: "forward_to_main", args: { turnId: routeId(h) } }] },
      serverContent: { outputTranscription: { text: "我已經完成工作" }, modelTurn: { parts: [{ inlineData: { mimeType: "audio/pcm;rate=24000", data: Buffer.alloc(480).toString("base64") } }] } },
    });
    expect(h.browser.sendAudio).not.toHaveBeenCalled();
    expect(h.events.some(e => e.type === "transcript" && e.role === "model")).toBe(false);
    expect(h.dictations()).toHaveLength(1);
  });
  it("does not speak an invented answer after forwarding to main", async () => {
    const h = harness(engine, "natural_chat_v2");
    await h.start();
    await startRoute(h, "幫我查進度");
    routeTool(h, { turnId: routeId(h) });
    await Promise.resolve();
    if (engine === "openai") {
      h.fromModel({ type: "response.output_audio_transcript.delta", response_id: "local", delta: "我已經完成工作" });
      h.fromModel({ type: "response.output_audio.delta", response_id: "local", delta: Buffer.alloc(480).toString("base64") });
    } else h.fromModel({ serverContent: { outputTranscription: { text: "我已經完成工作" }, modelTurn: { parts: [{ inlineData: { mimeType: "audio/pcm;rate=24000", data: Buffer.alloc(480).toString("base64") } }] } } });
    expect(h.browser.sendAudio).not.toHaveBeenCalled();
    expect(h.dictations()).toHaveLength(1);
  });

});
