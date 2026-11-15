import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { VoiceTurnLedger, type VoiceTurnReply } from "../services/voice/voice-turn-ledger.js";

function answer(commentId: string, sourceCommentIds: string[], voiceSummary = "已經完成。退款仍待確認。"): VoiceTurnReply {
  return { commentId, sourceCommentIds, voiceSummary, runId: "run-1", body: "完整答案", createdAt: 0 };
}

function harness(options: { maxTurns?: number; maxReplies?: number } = {}) {
  const onTurn = vi.fn();
  const onNotice = vi.fn();
  const onSpeechReady = vi.fn();
  const ledger = new VoiceTurnLedger({ onTurn, onNotice, onSpeechReady, ...options });
  const store = (id: string) => {
    ledger.register(id, [`segment-${id}`]);
    ledger.stored(id, `input-${id}`);
  };
  return { ledger, store, onTurn, onNotice, onSpeechReady };
}

describe("VoiceTurnLedger", () => {
  beforeEach(() => { vi.useFakeTimers(); vi.setSystemTime(0); });
  afterEach(() => { vi.useRealTimers(); });

  it("does not announce work before a Chat write receipt exists", () => {
    const { ledger, onNotice } = harness();
    ledger.register("a", ["s-a"]);
    vi.advanceTimersByTime(60_000);
    expect(onNotice).not.toHaveBeenCalled();
    expect(ledger.processing("a", "run-1")).toBe(false);
    expect(ledger.getTurns()[0].state).toBe("sending");
    ledger.stored("a", "input-a");
    vi.advanceTimersByTime(799);
    expect(onNotice).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    expect(onNotice).toHaveBeenCalledWith("我確認一下。", "notice:a:ack");
  });

  it("skips both notices when an answer arrives before the first deadline", () => {
    const { ledger, store, onNotice } = harness();
    store("a");
    vi.advanceTimersByTime(799);
    ledger.reply(answer("reply-a", ["input-a"]));
    vi.advanceTimersByTime(60_000);
    expect(onNotice).not.toHaveBeenCalled();
    expect(ledger.takeNextSpeech()?.text).toBe("已經完成。退款仍待確認。");
    expect(vi.getTimerCount()).toBe(0);
  });

  it("announces each bounded waiting phase once and invalidates stale queued notices", () => {
    const { ledger, store, onNotice } = harness();
    store("a");
    vi.advanceTimersByTime(800);
    expect(ledger.isNoticeCurrent("notice:a:ack")).toBe(true);
    expect(ledger.processing("a", "run-1")).toBe(true);
    vi.advanceTimersByTime(19_200);
    expect(onNotice.mock.calls.map(([text]) => text)).toEqual(["我確認一下。", "還在等結果。"]);
    vi.advanceTimersByTime(120_000);
    expect(onNotice).toHaveBeenCalledTimes(2);
    ledger.reply(answer("reply-a", ["input-a"]));
    expect(ledger.isNoticeCurrent("notice:a:ack")).toBe(false);
    expect(ledger.isNoticeCurrent("notice:a:waiting")).toBe(false);
  });

  it("keeps delivery unknown distinct from stored, then reconciles an actual receipt", () => {
    const { ledger, onNotice } = harness();
    ledger.register("a", ["s-a"]);
    ledger.fail("a", "unknown", "送出結果尚未確認");
    vi.advanceTimersByTime(30_000);
    expect(ledger.getTurns()[0]).toMatchObject({ state: "unknown", inputCommentId: null });
    expect(onNotice).not.toHaveBeenCalled();
    expect(ledger.stored("a", "input-a")).toBe(true);
    expect(ledger.getTurns()[0]).toMatchObject({ state: "stored", error: null });
    ledger.fail("a", "failed", "late browser timeout");
    expect(ledger.getTurns()[0].state).toBe("stored");
  });

  it("never treats an unrelated text request's answer or same-run identity as correlation", () => {
    const { ledger, store } = harness();
    store("a");
    ledger.processing("a", "run-1");
    expect(ledger.reply(answer("text-answer", ["text-input"]))).toBe(false);
    expect(ledger.reply(answer("no-source", []))).toBe(false);
    expect(ledger.takeNextSpeech()).toBeNull();
    expect(ledger.getTurns()[0].answerCommentId).toBeNull();
  });

  it("lets the caller reconcile an answer seen before the stored receipt", () => {
    const { ledger, onNotice } = harness();
    ledger.register("a", ["s-a"]);
    const reply = answer("reply-a", ["input-a"]);
    expect(ledger.reply(reply)).toBe(false);
    ledger.stored("a", "input-a");
    expect(ledger.reply(reply)).toBe(true);
    vi.advanceTimersByTime(25_000);
    expect(onNotice).not.toHaveBeenCalled();
    expect(ledger.takeNextSpeech()?.commentId).toBe("reply-a");
  });

  it("maps a combined answer to multiple inputs, including a delayed receipt", () => {
    const { ledger, store } = harness();
    store("a");
    ledger.register("b", ["s-b"]);
    ledger.reply(answer("combined", ["input-a", "input-b"]));
    expect(ledger.takeNextSpeech()).toBeNull();
    ledger.stored("b", "input-b");
    expect(ledger.takeNextSpeech()).toMatchObject({ commentId: "combined", turnIds: ["a", "b"] });
    expect(ledger.getTurns().map((turn) => turn.answerCommentId)).toEqual(["combined", "combined"]);
  });

  it("does not let a same-run old answer claim a later input", () => {
    const { ledger, store } = harness();
    store("a");
    store("b");
    ledger.reply(answer("old", ["input-a"]));
    expect(ledger.takeNextSpeech()).toBeNull();
    expect(ledger.getTurns()[1].answerCommentId).toBeNull();
    ledger.reply(answer("new", ["input-b"]));
    expect(ledger.takeNextSpeech()?.commentId).toBe("new");
  });

  it("deduplicates operations, segments and receipts without rescheduling notices", () => {
    const { ledger, store, onNotice } = harness();
    store("a");
    ledger.register("a", ["segment-a"]);
    expect(ledger.register("duplicate-operation", ["segment-a"]).operationId).toBe("a");
    vi.advanceTimersByTime(500);
    expect(ledger.stored("a", "input-a")).toBe(true);
    expect(ledger.stored("a", "wrong-input")).toBe(false);
    expect(() => ledger.register("mixed", ["segment-a", "new-segment"])).toThrow(/already belongs/);
    vi.advanceTimersByTime(300);
    expect(onNotice).toHaveBeenCalledTimes(1);
    expect(ledger.getTurns()).toHaveLength(1);
  });

  it("plays two different answer IDs with identical words, each once", () => {
    const { ledger, store } = harness();
    store("a");
    ledger.reply(answer("reply-a", ["input-a"], "好。"));
    ledger.reply(answer("reply-a", ["input-a"], "好。"));
    const first = ledger.takeNextSpeech()!;
    expect(ledger.playbackStarted(first.key)).toBe(true);
    expect(ledger.playbackDrained(first.key)).toBe(true);
    expect(ledger.takeNextSpeech()).toBeNull();
    store("b");
    ledger.reply(answer("reply-b", ["input-b"], "好。"));
    const second = ledger.takeNextSpeech()!;
    expect(second.text).toBe(first.text);
    expect(second.key).not.toBe(first.key);
    expect(second.turnIds).toEqual(["b"]);
  });

  it("retains an interrupted answer for explicit replay without replaying delayed audio events", () => {
    const { ledger, store } = harness();
    store("a");
    ledger.reply(answer("reply-a", ["input-a"]));
    const first = ledger.takeNextSpeech()!;
    ledger.playbackStarted(first.key);
    ledger.interrupt();
    expect(ledger.getTurns()[0].state).toBe("interrupted");
    expect(ledger.isSpeechCurrent(first.key)).toBe(false);
    expect(ledger.playbackDrained(first.key)).toBe(false);
    expect(ledger.takeNextSpeech()).toBeNull();
    expect(ledger.replay("reply-a")).toBe(true);
    expect(ledger.replay("reply-a")).toBe(false);
    const replay = ledger.takeNextSpeech()!;
    expect(replay).toMatchObject({ replay: true, commentId: "reply-a" });
    expect(replay.key).not.toBe(first.key);
    ledger.playbackStarted(replay.key);
    ledger.playbackDrained(replay.key);
    expect(ledger.getTurns()[0].state).toBe("completed");
  });

  it("suppresses queued and late old answers on interruption but allows the new turn", () => {
    const { ledger, store, onNotice } = harness();
    store("a");
    ledger.reply(answer("queued-a", ["input-a"]));
    ledger.interrupt();
    ledger.reply(answer("late-a", ["input-a"]));
    expect(ledger.takeNextSpeech()).toBeNull();
    store("b");
    ledger.reply(answer("reply-b", ["input-b"]));
    expect(ledger.takeNextSpeech()?.commentId).toBe("reply-b");
    vi.advanceTimersByTime(60_000);
    expect(onNotice).not.toHaveBeenCalled();
    expect(ledger.replay("late-a")).toBe(true);
  });

  it("allows an answer that covers the old and latest turns after a barge-in", () => {
    const { ledger, store } = harness();
    store("a");
    ledger.interrupt();
    store("b");
    ledger.reply(answer("combined", ["input-a", "input-b"]));
    expect(ledger.takeNextSpeech()?.turnIds).toEqual(["a", "b"]);
  });

  it("does not let an old answer drain complete a newer answer on the same turn", () => {
    const { ledger, store } = harness();
    store("a");
    ledger.reply(answer("reply-a", ["input-a"]));
    const first = ledger.takeNextSpeech()!;
    ledger.playbackStarted(first.key);
    ledger.reply(answer("reply-b", ["input-a"]));
    ledger.playbackDrained(first.key);
    expect(ledger.getTurns()[0]).toMatchObject({ answerCommentId: "reply-b", state: "answer_ready" });
    expect(ledger.takeNextSpeech()?.commentId).toBe("reply-b");
  });

  it("uses a fixed text fallback when the main did not supply a voice summary", () => {
    const { ledger, store } = harness();
    store("a");
    ledger.reply({ ...answer("reply-a", ["input-a"], ""), body: "A very long factual answer." });
    expect(ledger.takeNextSpeech()?.text).toBe("我已經回覆在對話中，請看畫面的文字。");
  });

  it("retains receipts through upstream reconnect and rejects duplicate playback", () => {
    const { ledger, store } = harness();
    store("a");
    const reply = answer("reply-a", ["input-a"]);
    ledger.reply(reply);
    const speech = ledger.takeNextSpeech()!;
    ledger.playbackStarted(speech.key);
    ledger.interrupt(); // Audio transport was lost; keep this call's ledger.
    ledger.register("a", ["segment-a"]);
    ledger.stored("a", "input-a");
    ledger.reply(reply);
    expect(ledger.getTurns()).toHaveLength(1);
    expect(ledger.takeNextSpeech()).toBeNull();
  });

  it("hangs up by clearing local timers and playback only", () => {
    const { ledger, store, onNotice } = harness();
    store("a");
    expect(vi.getTimerCount()).toBe(2);
    ledger.dispose();
    ledger.dispose();
    expect(vi.getTimerCount()).toBe(0);
    vi.advanceTimersByTime(60_000);
    expect(onNotice).not.toHaveBeenCalled();
    expect(ledger.getTurns()[0].inputCommentId).toBe("input-a");
    expect(ledger.reply(answer("late", ["input-a"]))).toBe(false);
    expect(ledger.replay("late")).toBe(false);
    expect(() => ledger.register("b", ["s-b"])).toThrow(/ended/);
  });

  it("bounds retained identities without silently evicting deduplication history", () => {
    const { ledger, store } = harness({ maxTurns: 1, maxReplies: 1 });
    store("a");
    ledger.reply(answer("reply-a", ["input-a"]));
    expect(() => store("b")).toThrow(/上限/);
    expect(() => ledger.reply(answer("reply-b", ["input-a"]))).toThrow(/上限/);
    expect(ledger.reply(answer("reply-a", ["input-a"]))).toBe(true);
    expect(ledger.getTurns()).toHaveLength(1);
  });
});
