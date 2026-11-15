import type { LocalVoiceTurnState } from "@paperclipai/shared";

export interface VoiceTurn {
  turnId: string;
  operationId: string;
  segmentIds: string[];
  inputCommentId: string | null;
  answerCommentId: string | null;
  runId: string | null;
  state: LocalVoiceTurnState;
  createdAt: number;
  storedAt: number | null;
  error: string | null;
}

export interface VoiceTurnReply {
  commentId: string;
  sourceCommentIds: readonly string[];
  runId?: string | null;
  voiceSummary?: string | null;
  body: string;
  createdAt: string | number | Date;
}

export interface VoiceTurnSpeech {
  key: string;
  commentId: string;
  text: string;
  turnIds: string[];
  replay: boolean;
}

interface TurnRecord {
  turn: VoiceTurn;
  sequence: number;
  suppressed: boolean;
  timers: Set<ReturnType<typeof setTimeout>>;
  notices: Set<string>;
}

interface AnswerRecord {
  speech: VoiceTurnSpeech;
  sourceCommentIds: Set<string>;
  runId: string | null;
  autoScheduled: boolean;
  playbackState: VoiceAnswerPlayback["state"];
}

export interface VoiceAnswerPlayback {
  commentId: string;
  turnIds: string[];
  state: "available" | "answer_ready" | "speaking" | "interrupted" | "completed";
}

export interface VoiceTurnLedgerOptions {
  onTurn?: (turn: VoiceTurn) => void;
  onAnswer?: (answer: VoiceAnswerPlayback) => void;
  onNotice?: (text: string, key: string) => void;
  onSpeechReady?: () => void;
  now?: () => number;
  setTimer?: (callback: () => void, delay: number) => ReturnType<typeof setTimeout>;
  clearTimer?: (timer: ReturnType<typeof setTimeout>) => void;
  maxTurns?: number;
  maxReplies?: number;
}

/** Call-scoped correlation and playback; it never starts, cancels or retries agent work. */
export class VoiceTurnLedger {
  private readonly turns = new Map<string, TurnRecord>();
  private readonly segments = new Map<string, string>();
  private readonly comments = new Map<string, TurnRecord>();
  private readonly answers = new Map<string, AnswerRecord>();
  private readonly queue: VoiceTurnSpeech[] = [];
  private readonly now: () => number;
  private readonly setTimer: NonNullable<VoiceTurnLedgerOptions["setTimer"]>;
  private readonly clearTimer: NonNullable<VoiceTurnLedgerOptions["clearTimer"]>;
  private active: VoiceTurnSpeech | null = null;
  private replaySequence = 0;
  private disposed = false;

  constructor(private readonly options: VoiceTurnLedgerOptions = {}) {
    this.now = options.now ?? Date.now;
    this.setTimer = options.setTimer ?? setTimeout;
    this.clearTimer = options.clearTimer ?? clearTimeout;
  }

  register(operationId: string, segmentIds: readonly string[]): VoiceTurn {
    if (this.disposed) throw new Error("Voice call has ended");
    const prior = this.turns.get(operationId);
    if (prior) return this.snapshot(prior);
    if (!operationId || operationId.length > 256 || segmentIds.length > 128
      || segmentIds.some((id) => !id || id.length > 256)) {
      throw new Error("Invalid voice turn identity");
    }
    const uniqueSegments = [...new Set(segmentIds)];
    const ownerIds = uniqueSegments.map((id) => this.segments.get(id));
    if (ownerIds.length && ownerIds.every((id) => id && id === ownerIds[0])) {
      return this.snapshot(this.turns.get(ownerIds[0]!)!);
    }
    if (ownerIds.some(Boolean)) throw new Error("Voice segment already belongs to another turn");
    // Do not evict deduplication identities while a call remains live.
    if (this.turns.size >= (this.options.maxTurns ?? 256)) {
      throw new Error("這通電話的對話輪數已達上限，請重新通話。");
    }
    const record: TurnRecord = {
      turn: {
        turnId: operationId, operationId, segmentIds: uniqueSegments,
        inputCommentId: null, answerCommentId: null, runId: null,
        state: "sending", createdAt: this.now(), storedAt: null, error: null,
      },
      sequence: this.turns.size, suppressed: false, timers: new Set(), notices: new Set(),
    };
    this.turns.set(operationId, record);
    for (const id of uniqueSegments) this.segments.set(id, operationId);
    this.emit(record);
    return this.snapshot(record);
  }

  stored(operationId: string, commentId: string): boolean {
    const record = this.turns.get(operationId);
    if (this.disposed || !record || !commentId) return false;
    if (record.turn.inputCommentId) return record.turn.inputCommentId === commentId;
    if (this.comments.has(commentId)) return false;
    record.turn.inputCommentId = commentId;
    record.turn.storedAt = this.now();
    record.turn.error = null;
    record.turn.state = "stored";
    this.comments.set(commentId, record);
    this.emit(record);
    // A combined answer can arrive after one input receipt and before another.
    for (const answer of this.answers.values()) {
      if (answer.sourceCommentIds.has(commentId)) {
        this.attachAnswer(record, answer);
        const scheduled = this.scheduleAnswer(answer);
        this.emitAnswer(answer);
        if (scheduled) this.options.onSpeechReady?.();
      }
    }
    if (!record.turn.answerCommentId && !record.suppressed) {
      this.noticeAfter(record, 800, "ack", "我確認一下。");
      this.noticeAfter(record, 20_000, "waiting", "還在等結果。");
    }
    return true;
  }

  processing(operationId: string, runId: string): boolean {
    const record = this.turns.get(operationId);
    if (this.disposed || !record?.turn.inputCommentId || record.turn.answerCommentId) return false;
    if (record.turn.state !== "stored" && record.turn.state !== "processing") return false;
    record.turn.runId = runId;
    record.turn.state = "processing";
    this.emit(record);
    return true;
  }

  fail(operationId: string, state: "failed" | "unknown", message: string): void {
    const record = this.turns.get(operationId);
    if (this.disposed || !record || record.turn.inputCommentId || record.turn.answerCommentId) return;
    this.clearNotices(record);
    record.turn.state = state;
    record.turn.error = message.slice(0, 2000);
    this.emit(record);
  }

  /** Unmatched replies return false; the caller can reconcile again when input receipts arrive. */
  reply(reply: VoiceTurnReply): boolean {
    if (this.disposed) return false;
    if (this.answers.has(reply.commentId)) return true;
    const matched = [...new Set(reply.sourceCommentIds)].map((id) => this.comments.get(id))
      .filter((record): record is TurnRecord => !!record);
    if (!matched.length) return false;
    if (this.answers.size >= (this.options.maxReplies ?? 1024)) {
      throw new Error("這通電話的回答數已達上限，請重新通話。");
    }
    if (!reply.commentId || reply.commentId.length > 256 || reply.sourceCommentIds.length > 256
      || reply.sourceCommentIds.some((id) => !id || id.length > 256)) {
      throw new Error("Invalid voice answer identity");
    }
    const speech: VoiceTurnSpeech = {
      key: `answer:${reply.commentId}`, commentId: reply.commentId,
      text: reply.voiceSummary?.trim().slice(0, 16_000) || "我已經回覆在對話中，請看畫面的文字。",
      turnIds: [], replay: false,
    };
    const answer: AnswerRecord = {
      speech, sourceCommentIds: new Set(reply.sourceCommentIds), runId: reply.runId ?? null,
      autoScheduled: false, playbackState: "answer_ready",
    };
    this.answers.set(reply.commentId, answer);
    for (const record of matched) this.attachAnswer(record, answer);
    const scheduled = this.scheduleAnswer(answer);
    if (!scheduled) answer.playbackState = "available";
    // A combined answer is published once, after every known source is attached.
    this.emitAnswer(answer);
    if (scheduled) this.options.onSpeechReady?.();
    return true;
  }

  takeNextSpeech(): VoiceTurnSpeech | null {
    if (this.disposed || this.active) return null;
    while (this.queue.length) {
      const speech = this.queue.shift()!;
      if (speech.replay || speech.turnIds.some((id) => {
        const record = this.turns.get(id);
        return record && !record.suppressed && !this.hasNewerTurn(record);
      })) {
        this.active = speech;
        return this.copySpeech(speech);
      }
      this.setSpeechState(speech, "interrupted");
    }
    return null;
  }

  isSpeechCurrent(key: string): boolean {
    return !this.disposed && this.active?.key === key;
  }

  playbackStarted(key: string): boolean {
    if (!this.isSpeechCurrent(key)) return false;
    this.setSpeechState(this.active!, "speaking");
    return true;
  }

  playbackDrained(key: string): boolean {
    if (!this.isSpeechCurrent(key)) return false;
    this.setSpeechState(this.active!, "completed");
    this.active = null;
    if (this.queue.length) this.options.onSpeechReady?.();
    return true;
  }

  /** Barge-in or lost audio interrupts playback only, including replies that arrive later. */
  interrupt(): void {
    if (this.disposed) return;
    for (const record of this.turns.values()) {
      record.suppressed = true;
      this.clearNotices(record);
    }
    if (this.active) this.setSpeechState(this.active, "interrupted");
    for (const speech of this.queue) this.setSpeechState(speech, "interrupted");
    this.active = null;
    this.queue.length = 0;
  }

  replay(commentId: string): boolean {
    const answer = this.answers.get(commentId);
    if (this.disposed || !answer) return false;
    if (this.active?.commentId === commentId || this.queue.some((item) => item.commentId === commentId)) return false;
    this.queue.push({ ...this.copySpeech(answer.speech), key: `replay:${++this.replaySequence}:${commentId}`, replay: true });
    answer.playbackState = "answer_ready";
    this.emitAnswer(answer);
    this.options.onSpeechReady?.();
    return true;
  }

  isNoticeCurrent(key: string): boolean {
    if (this.disposed) return false;
    return [...this.turns.values()].some((record) => record.notices.has(key) && this.isWaiting(record));
  }

  getTurns(): VoiceTurn[] { return [...this.turns.values()].map((record) => this.snapshot(record)); }

  dispose(): void {
    if (this.disposed) return;
    this.interrupt();
    this.disposed = true;
  }

  private hasNewerTurn(record: TurnRecord): boolean {
    return record.sequence < this.turns.size - 1;
  }

  private scheduleAnswer(answer: AnswerRecord): boolean {
    if (answer.autoScheduled) return false;
    if (!answer.speech.turnIds.some((id) => {
      const record = this.turns.get(id)!;
      return !record.suppressed && !this.hasNewerTurn(record);
    })) return false;
    answer.autoScheduled = true;
    answer.playbackState = "answer_ready";
    this.queue.push(answer.speech);
    return true;
  }

  private attachAnswer(record: TurnRecord, answer: AnswerRecord): void {
    if (answer.speech.turnIds.includes(record.turn.turnId)) return;
    answer.speech.turnIds.push(record.turn.turnId);
    record.turn.answerCommentId = answer.speech.commentId;
    record.turn.runId = answer.runId;
    record.turn.state = record.suppressed || this.hasNewerTurn(record) ? "interrupted"
      : answer.playbackState === "available" ? "answer_ready" : answer.playbackState;
    this.clearNotices(record);
    this.emit(record);
  }

  private isWaiting(record: TurnRecord): boolean {
    return !record.suppressed && !this.hasNewerTurn(record) && !!record.turn.inputCommentId
      && !record.turn.answerCommentId && (record.turn.state === "stored" || record.turn.state === "processing");
  }

  private noticeAfter(record: TurnRecord, delay: number, phase: string, text: string): void {
    const key = `notice:${record.turn.turnId}:${phase}`;
    const timer = this.setTimer(() => {
      record.timers.delete(timer);
      if (this.disposed || !this.isWaiting(record)) return;
      record.notices.add(key);
      this.options.onNotice?.(text, key);
    }, delay);
    record.timers.add(timer);
  }

  private clearNotices(record: TurnRecord): void {
    for (const timer of record.timers) this.clearTimer(timer);
    record.timers.clear();
    record.notices.clear();
  }

  private setSpeechState(speech: VoiceTurnSpeech, state: "speaking" | "interrupted" | "completed"): void {
    const answer = this.answers.get(speech.commentId);
    if (answer) answer.playbackState = state;
    for (const id of speech.turnIds) {
      const record = this.turns.get(id);
      // A late drain from an earlier answer cannot complete a newer answer.
      if (!record || record.turn.answerCommentId !== speech.commentId) continue;
      record.turn.state = state;
      this.emit(record);
    }
    // Old-answer replay still owns playback receipts when a newer answer owns the turn.
    if (answer) this.emitAnswer(answer);
  }

  private emitAnswer(answer: AnswerRecord): void {
    this.options.onAnswer?.({ commentId: answer.speech.commentId, turnIds: [...answer.speech.turnIds], state: answer.playbackState });
  }

  private snapshot(record: TurnRecord): VoiceTurn { return { ...record.turn, segmentIds: [...record.turn.segmentIds] }; }
  private copySpeech(speech: VoiceTurnSpeech): VoiceTurnSpeech { return { ...speech, turnIds: [...speech.turnIds] }; }
  private emit(record: TurnRecord): void { this.options.onTurn?.(this.snapshot(record)); }
}
