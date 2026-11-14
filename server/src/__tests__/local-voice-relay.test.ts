import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { LocalVoiceRelayServerEvent } from "@paperclipai/shared";
import { GeminiLiveRelay, type VoiceAgentReply, type VoiceTaskPort, type VoiceUpstreamHandlers } from "../services/voice/gemini-live-relay.js";
import { extractVoiceSummary, isConfirmationUtterance, recitationCoverage, spokenFallback } from "../services/voice/voice-summary.js";

interface FakeUpstream { handlers: VoiceUpstreamHandlers; sent: any[]; closed: boolean }

function harness(options: { replies?: VoiceAgentReply[][]; submit?: VoiceTaskPort["submit"]; failConnects?: number } = {}) {
  const events: LocalVoiceRelayServerEvent[] = [];
  const audio: Buffer[] = [];
  const upstreams: FakeUpstream[] = [];
  const watchers: (() => void)[] = [];
  const replyBatches = [...(options.replies ?? [])];
  let failConnects = options.failConnects ?? 0;
  const port = {
    status: vi.fn(async (identifier?: string) => ({ status: "ok", identifier: identifier ?? null })),
    submit: vi.fn(options.submit ?? (async (draft) => ({ status: "accepted" as const, operationId: draft.operationId }))),
    newReplies: vi.fn(async () => replyBatches.shift() ?? []),
    watch: vi.fn((onChange: () => void) => { watchers.push(onChange); return () => undefined; }),
    end: vi.fn(async () => undefined),
  } satisfies VoiceTaskPort;
  const browser = { sendEvent: vi.fn((event: LocalVoiceRelayServerEvent) => { events.push(event); }), sendAudio: vi.fn((pcm: Buffer) => { audio.push(pcm); }), close: vi.fn() };
  const relay = new GeminiLiveRelay({
    browser, port,
    connectUpstream: async (handlers) => {
      if (failConnects > 0) { failConnects -= 1; throw new Error("gateway down"); }
      const upstream: FakeUpstream = { handlers, sent: [], closed: false };
      upstreams.push(upstream);
      return { send: (json) => upstream.sent.push(JSON.parse(json)), close: () => { upstream.closed = true; } };
    },
    binding: { issueId: "issue-1", issueIdentifier: "HOM-900", issueTitle: "語音對話", agentName: "michael" },
    transcriptGraceMs: 0,
    replyDebounceMs: 10,
    reconnectDelaysMs: [0, 0],
  });
  const current = () => upstreams[upstreams.length - 1]!;
  const fromModel = (message: unknown, upstream = current()) => upstream.handlers.onMessage(JSON.stringify(message));
  const ready = async (upstream?: FakeUpstream) => { await vi.waitFor(() => expect(upstreams.length).toBeGreaterThan(0)); fromModel({ setupComplete: {} }, upstream ?? current()); };
  const toolCall = (id: string, name: string, args: Record<string, unknown>) => fromModel({ toolCall: { functionCalls: [{ id, name, args }] } });
  const toolResponse = async (id: string) => {
    let found: any;
    await vi.waitFor(() => {
      found = upstreams.flatMap((u) => u.sent).find((m) => m.toolResponse?.functionResponses?.[0]?.id === id);
      expect(found).toBeTruthy();
    });
    return found.toolResponse.functionResponses[0].response;
  };
  return { relay, port, browser, events, audio, upstreams, watchers, current, fromModel, ready, toolCall, toolResponse };
}

describe("GeminiLiveRelay", () => {
  beforeEach(() => { vi.useRealTimers(); });
  afterEach(() => { vi.useRealTimers(); });

  it("sends a resumable zh-TW setup with four blocking tools and announces readiness", async () => {
    const h = harness();
    const started = h.relay.start();
    await h.ready();
    await started;
    const setup = h.current().sent[0].setup;
    expect(setup.responseModalities).toEqual(["AUDIO"]);
    expect(setup.sessionResumption).toEqual({});
    expect(setup.contextWindowCompression).toEqual({ slidingWindow: {} });
    expect(setup.inputAudioTranscription).toEqual({});
    expect(setup.tools[0].functionDeclarations.map((d: any) => d.name)).toEqual(["query_task_status", "prepare_request", "submit_request", "get_updates"]);
    expect(JSON.stringify(setup.tools)).not.toContain("NON_BLOCKING");
    expect(setup.systemInstruction.parts[0].text).toContain("HOM-900");
    expect(h.events[0]).toMatchObject({ type: "ready", issueId: "issue-1", agentName: "michael", maxSeconds: 900, warningSeconds: 600 });
  });

  it("forwards microphone and model audio and relays barge-in", async () => {
    const h = harness();
    const started = h.relay.start(); await h.ready(); await started;
    h.relay.handleBrowserAudio(Buffer.from([1, 0, 2, 0]));
    expect(h.current().sent[1]).toEqual({ realtimeInput: { audio: { mimeType: "audio/pcm;rate=16000", data: Buffer.from([1, 0, 2, 0]).toString("base64") } } });
    h.relay.handleBrowserAudio(Buffer.from([1])); // odd byte count is not PCM16
    expect(h.current().sent).toHaveLength(2);
    h.fromModel({ serverContent: { modelTurn: { parts: [{ inlineData: { mimeType: "audio/pcm;rate=24000", data: Buffer.from([9, 9]).toString("base64") } }] } } });
    expect(h.audio[0]).toEqual(Buffer.from([9, 9]));
    h.fromModel({ serverContent: { interrupted: true } });
    expect(h.events.at(-1)).toEqual({ type: "interrupted" });
    await h.relay.handleBrowserMessage({ type: "mic", state: "paused" });
    expect(h.current().sent.at(-1)).toEqual({ realtimeInput: { audioStreamEnd: true } });
    h.relay.handleBrowserAudio(Buffer.from([1, 0]));
    expect(h.current().sent.at(-1)).toEqual({ realtimeInput: { audioStreamEnd: true } });
  });

  /** The model reads the draft back (audio + transcription), finishes its turn, and the browser drains playback. */
  async function recite(h: ReturnType<typeof harness>, text: string, options: { drain?: boolean } = {}) {
    h.fromModel({ serverContent: { modelTurn: { parts: [{ inlineData: { mimeType: "audio/pcm;rate=24000", data: "AAA=" } }] } } });
    h.fromModel({ serverContent: { outputTranscription: { text: `草稿是：${text}。請說確認送出。` } } });
    h.fromModel({ serverContent: { turnComplete: true } });
    if (options.drain !== false) await h.relay.handleBrowserMessage({ type: "playback", playing: false });
  }
  const say = (h: ReturnType<typeof harness>, ...chunks: string[]) => {
    for (const text of chunks) h.fromModel({ serverContent: { inputTranscription: { text } } });
  };

  it("submits a draft only after the read-back and the caller's own spoken confirmation", async () => {
    const h = harness();
    const started = h.relay.start(); await h.ready(); await started;
    h.toolCall("p1", "prepare_request", { text: "  請 michael 查昨天部署失敗的原因  " });
    const prepared = await h.toolResponse("p1");
    expect(prepared).toMatchObject({ status: "draft_ready", revision: 1, text: "請 michael 查昨天部署失敗的原因" });
    expect(h.events.find((e) => e.type === "draft")).toMatchObject({ draft: { draftId: prepared.draftId, revision: 1 } });

    // Said before any read-back: not accepted.
    say(h, "確認送出");
    h.toolCall("s1", "submit_request", { draftId: prepared.draftId });
    expect(await h.toolResponse("s1")).toMatchObject({ status: "confirmation_required" });
    expect(h.port.submit).not.toHaveBeenCalled();

    await recite(h, "請 michael 查昨天部署失敗的原因");
    say(h, "好，确认", "送出。"); // one utterance, simplified transcription
    h.toolCall("s2", "submit_request", { draftId: prepared.draftId });
    expect(await h.toolResponse("s2")).toMatchObject({ status: "accepted" });
    expect(h.port.submit).toHaveBeenCalledTimes(1);
    const [submitted, via] = h.port.submit.mock.calls[0]!;
    expect(submitted).toMatchObject({ draftId: prepared.draftId, revision: 1, text: "請 michael 查昨天部署失敗的原因" });
    expect(via).toBe("spoken");
    expect(h.events.find((e) => e.type === "submitted")).toMatchObject({ via: "spoken", operationId: submitted.operationId });

    h.toolCall("s3", "submit_request", { draftId: prepared.draftId });
    expect(await h.toolResponse("s3")).toMatchObject({ status: "accepted" });
    expect(h.port.submit).toHaveBeenCalledTimes(1);
  });

  it("ignores speaker echo: speech while the model talks or the browser still plays does not confirm", async () => {
    const h = harness();
    const started = h.relay.start(); await h.ready(); await started;
    h.toolCall("p1", "prepare_request", { text: "請 michael 重新部署" });
    const prepared = await h.toolResponse("p1");
    // Echo of 「確認送出」 while the read-back is still playing in the browser.
    await recite(h, "請 michael 重新部署", { drain: false });
    say(h, "確認送出");
    h.toolCall("s1", "submit_request", { draftId: prepared.draftId });
    expect(await h.toolResponse("s1")).toMatchObject({ status: "confirmation_required" });
    // An interrupted read-back never counts as recited.
    const h2 = harness();
    const started2 = h2.relay.start(); await h2.ready(); await started2;
    h2.toolCall("p1", "prepare_request", { text: "請 michael 重新部署" });
    const draft2 = await h2.toolResponse("p1");
    h2.fromModel({ serverContent: { outputTranscription: { text: "草稿是：請 michael 重新部署" } } });
    h2.fromModel({ serverContent: { interrupted: true } });
    say(h2, "確認送出");
    h2.toolCall("s1", "submit_request", { draftId: draft2.draftId });
    expect(await h2.toolResponse("s1")).toMatchObject({ status: "confirmation_required" });
    // A turn that did not read the draft back does not count either.
    const h3 = harness();
    const started3 = h3.relay.start(); await h3.ready(); await started3;
    h3.toolCall("p1", "prepare_request", { text: "請 michael 檢查備份與磁碟空間" });
    const draft3 = await h3.toolResponse("p1");
    h3.fromModel({ serverContent: { outputTranscription: { text: "好的，要送出嗎？" } } });
    h3.fromModel({ serverContent: { turnComplete: true } });
    say(h3, "確認送出");
    h3.toolCall("s1", "submit_request", { draftId: draft3.draftId });
    expect(await h3.toolResponse("s1")).toMatchObject({ status: "confirmation_required" });
    expect(h.port.submit).not.toHaveBeenCalled();
    expect(h2.port.submit).not.toHaveBeenCalled();
    expect(h3.port.submit).not.toHaveBeenCalled();
  });

  it("refuses negated, vague or embedded phrases and keeps the operation id across a failed attempt", async () => {
    let attempts = 0;
    const h = harness({ submit: async (draft) => (++attempts === 1
      ? { status: "failed", operationId: draft.operationId, code: "submit_unknown" }
      : { status: "accepted", operationId: draft.operationId }) });
    const started = h.relay.start(); await h.ready(); await started;
    h.toolCall("p1", "prepare_request", { text: "留言給 michael" });
    const prepared = await h.toolResponse("p1");
    await recite(h, "留言給 michael");
    for (const phrase of ["好，可以", "不要確認送出", "我不想確認送出", "確認送出嗎？", "請說確認送出"]) {
      say(h, phrase);
      h.toolCall(`s-${phrase}`, "submit_request", { draftId: prepared.draftId });
      expect(await h.toolResponse(`s-${phrase}`)).toMatchObject({ status: "confirmation_required" });
    }
    expect(h.port.submit).not.toHaveBeenCalled();

    await h.relay.handleBrowserMessage({ type: "confirm_draft", draftId: prepared.draftId, revision: 1 });
    await h.relay.handleBrowserMessage({ type: "confirm_draft", draftId: prepared.draftId, revision: 1 });
    expect(h.port.submit).toHaveBeenCalledTimes(2);
    expect(h.port.submit.mock.calls[0]![0].operationId).toBe(h.port.submit.mock.calls[1]![0].operationId);
    expect(h.port.submit.mock.calls[1]![1]).toBe("ui");
    expect(h.events.filter((e) => e.type === "submit_failed")).toMatchObject([{ revision: 1 }]);
    expect(h.events.find((e) => e.type === "submitted")).toMatchObject({ via: "ui" });
  });

  it("a revised draft needs a fresh read-back, and drafts cannot change while a submit is in flight", async () => {
    const h = harness();
    const started = h.relay.start(); await h.ready(); await started;
    h.toolCall("p1", "prepare_request", { text: "第一版內容" });
    const first = await h.toolResponse("p1");
    await recite(h, "第一版內容");
    say(h, "確認送出");
    h.toolCall("p2", "prepare_request", { text: "第二版內容" });
    const second = await h.toolResponse("p2");
    expect(second).toMatchObject({ draftId: first.draftId, revision: 2 });
    h.toolCall("s1", "submit_request", { draftId: first.draftId });
    expect(await h.toolResponse("s1")).toMatchObject({ status: "confirmation_required" });
    await h.relay.handleBrowserMessage({ type: "confirm_draft", draftId: first.draftId, revision: 1 });
    expect(h.events.at(-1)).toMatchObject({ type: "submit_failed", code: "voice_draft_stale", revision: 1 });
    expect(h.port.submit).not.toHaveBeenCalled();

    let release!: () => void;
    const slow = harness({ submit: (draft) => new Promise((resolve) => { release = () => resolve({ status: "accepted", operationId: draft.operationId }); }) });
    const s2 = slow.relay.start(); await slow.ready(); await s2;
    slow.toolCall("p1", "prepare_request", { text: "送出中" });
    const draft = await slow.toolResponse("p1");
    const confirming = slow.relay.handleBrowserMessage({ type: "confirm_draft", draftId: draft.draftId, revision: 1 });
    slow.toolCall("p2", "prepare_request", { text: "改內容" });
    expect(await slow.toolResponse("p2")).toMatchObject({ status: "busy" });
    await slow.relay.handleBrowserMessage({ type: "cancel_draft", draftId: draft.draftId });
    expect(slow.events.some((e) => e.type === "draft_cleared")).toBe(false);
    release();
    await confirming;
    expect(slow.events.find((e) => e.type === "submitted")).toMatchObject({ revision: 1 });
  });

  it("survives malformed gateway frames and closes an upstream that connects after the call ended", async () => {
    const h = harness();
    const started = h.relay.start(); await h.ready(); await started;
    expect(() => h.fromModel({ toolCall: { functionCalls: "nope" }, serverContent: { modelTurn: { parts: 5 } } })).not.toThrow();
    expect(() => h.fromModel({ toolCall: { functionCalls: [null, 3] } })).not.toThrow();
    expect(() => h.current().handlers.onMessage("null")).not.toThrow();
    expect(h.relay.isClosed).toBe(false);

    const late = harness();
    const pending = late.relay.start();
    await vi.waitFor(() => expect(late.upstreams).toHaveLength(1));
    await late.relay.handleBrowserMessage({ type: "end" });
    late.fromModel({ setupComplete: {} });
    await pending;
    expect(late.upstreams[0]!.closed).toBe(true);
    expect(late.events.filter((e) => e.type === "ready")).toHaveLength(0);
  });

  it("resumes with the latest handle on GoAway and replays buffered microphone audio", async () => {
    const h = harness();
    const started = h.relay.start(); await h.ready(); await started;
    const first = h.current();
    h.fromModel({ sessionResumptionUpdate: { newHandle: "handle-1", resumable: true } });
    h.fromModel({ goAway: { timeLeft: "10s" } });
    await vi.waitFor(() => expect(h.upstreams).toHaveLength(2));
    expect(h.upstreams[1]!.sent[0].setup.sessionResumption).toEqual({ handle: "handle-1" });
    h.relay.handleBrowserAudio(Buffer.from([5, 0]));
    h.fromModel({ setupComplete: {} }, h.upstreams[1]);
    await vi.waitFor(() => expect(h.events.find((e) => e.type === "resumed")).toEqual({ type: "resumed", contextKept: true }));
    expect(first.closed).toBe(true);
    expect(h.upstreams[1]!.sent.some((m) => m.realtimeInput?.audio?.data === Buffer.from([5, 0]).toString("base64"))).toBe(true);
    // Messages from the retired connection are ignored.
    first.handlers.onMessage(JSON.stringify({ serverContent: { outputTranscription: { text: "old" } } }));
    expect(h.events.some((e) => e.type === "transcript" && e.text === "old")).toBe(false);
  });

  it("reconnects after an unexpected close and ends the call when the gateway stays down", async () => {
    const h = harness();
    const started = h.relay.start(); await h.ready(); await started;
    h.current().handlers.onClose(1011, "internal");
    await vi.waitFor(() => expect(h.upstreams).toHaveLength(2));
    h.fromModel({ setupComplete: {} }, h.upstreams[1]);
    await vi.waitFor(() => expect(h.events.some((e) => e.type === "resumed" && e.contextKept === false)).toBe(true));

    const down = harness({ failConnects: 1 });
    await down.relay.start();
    expect(down.events.at(-1)).toEqual({ type: "ended", reason: "upstream_unavailable" });
    expect(down.port.end).toHaveBeenCalledWith("upstream_unavailable");
  });

  it("warns at ten minutes and ends at fifteen", async () => {
    vi.useFakeTimers();
    const h = harness();
    const started = h.relay.start();
    await vi.waitFor(() => expect(h.upstreams.length).toBe(1));
    h.fromModel({ setupComplete: {} });
    await started;
    await vi.advanceTimersByTimeAsync(600_000);
    expect(h.events.find((e) => e.type === "time_warning")).toEqual({ type: "time_warning", remainingSeconds: 300 });
    expect(h.current().sent.at(-1).clientContent.turns[0].parts[0].text).toContain("5 分鐘後會自動結束");
    await vi.advanceTimersByTimeAsync(300_000);
    expect(h.events.at(-1)).toEqual({ type: "ended", reason: "max_duration" });
    expect(h.port.end).toHaveBeenCalledWith("max_duration");
    expect(h.current().closed).toBe(true);
  });

  it("speaks a new agent reply's voice summary once, after the model finishes its turn", async () => {
    const reply = (id: string, body: string, voiceSummary: string | null): VoiceAgentReply => ({ commentId: id, body, voiceSummary, spoken: voiceSummary ?? spokenFallback(body), createdAt: "2026-11-14T00:00:00.000Z" });
    const h = harness({ replies: [
      [reply("c1", "完整內容\n語音摘要：部署失敗是磁碟滿了，已經清掉。", "部署失敗是磁碟滿了，已經清掉。")],
      [reply("c2", "部署失敗是磁碟滿了，已經清掉。", null), reply("c3", "補充\n語音摘要：部署失敗是磁碟滿了，已經清掉。", "部署失敗是磁碟滿了，已經清掉。")],
    ] });
    const started = h.relay.start(); await h.ready(); await started;
    h.fromModel({ serverContent: { modelTurn: { parts: [{ inlineData: { mimeType: "audio/pcm;rate=24000", data: "AAA=" } }] } } });
    h.watchers[0]!();
    await vi.waitFor(() => expect(h.events.some((e) => e.type === "agent_reply" && e.commentId === "c1")).toBe(true));
    expect(h.current().sent.some((m) => m.clientContent)).toBe(false); // model still speaking
    h.fromModel({ serverContent: { turnComplete: true } });
    const notice = h.current().sent.find((m) => m.clientContent);
    expect(notice.clientContent.turns[0].parts[0].text).toContain("「部署失敗是磁碟滿了，已經清掉。」");
    h.fromModel({ serverContent: { turnComplete: true } });
    h.watchers[0]!();
    await vi.waitFor(() => expect(h.events.some((e) => e.type === "agent_reply" && e.commentId === "c3")).toBe(true));
    expect(h.current().sent.filter((m) => m.clientContent)).toHaveLength(1);
  });

  it("answers status and update tools without confirmation", async () => {
    const h = harness({ replies: [[{ commentId: "c1", body: "b", voiceSummary: null, spoken: "b", createdAt: "x" }]] });
    const started = h.relay.start(); await h.ready(); await started;
    h.toolCall("q1", "query_task_status", { identifier: " HOM-307 " });
    expect(await h.toolResponse("q1")).toEqual({ status: "ok", identifier: "HOM-307" });
    h.toolCall("u1", "get_updates", {});
    expect(await h.toolResponse("u1")).toMatchObject({ status: "ok", replies: [{ summary: "b" }] });
    h.toolCall("u2", "get_updates", {});
    expect(await h.toolResponse("u2")).toMatchObject({ status: "pending" });
    h.toolCall("x1", "deploy_release", {});
    expect(await h.toolResponse("x1")).toMatchObject({ status: "error" });
  });
});

describe("voice summary helpers", () => {
  it("extracts the last spoken summary line or HTML comment", () => {
    expect(extractVoiceSummary("內容\n\n語音摘要：已完成，請看畫面。")).toBe("已完成，請看畫面。");
    expect(extractVoiceSummary("內容\n**語音摘要**: 兩句話。")).toBe("兩句話。");
    expect(extractVoiceSummary("a\n<!-- voiceSummary: hidden one -->")).toBe("hidden one");
    expect(extractVoiceSummary("沒有摘要")).toBeNull();
  });
  it("strips code, tables and links from a fallback", () => {
    const text = spokenFallback("# 標題\n```sh\nrm -rf x\n```\n| a | b |\n|---|---|\n- 看 [連結](http://x) 與 `code`");
    expect(text).toBe("標題 （程式碼略） 看 連結 與 code");
  });
  it("accepts only a short confirmation utterance in traditional or simplified transcription", () => {
    expect(isConfirmationUtterance("好 確認 送出！", "確認送出")).toBe(true);
    expect(isConfirmationUtterance("确认送出", "確認送出")).toBe(true);
    expect(isConfirmationUtterance("確認送出吧", "確認送出")).toBe(true);
    for (const text of ["不要確認送出", "還不能確認送出", "等一下再確認送出", "確認送出嗎", "請說確認送出", "好啊送出"]) expect(isConfirmationUtterance(text, "確認送出")).toBe(false);
  });
  it("measures how much of a draft the model read back", () => {
    expect(recitationCoverage("請 michael 查部署", "草稿是：請 Michael 查部署。")).toBe(1);
    expect(recitationCoverage("請 michael 查部署", "要送出嗎")).toBeLessThan(0.2);
  });
});
