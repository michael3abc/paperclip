import { MAIN_ANSWER_POLICY, localGreeting, mainAnswerInstruction } from "./voice-chat-policy.js";
import { VoiceTurnLedger } from "./voice-turn-ledger.js";
import { randomUUID } from "node:crypto";
import {
  LOCAL_VOICE_CALL_MAX_SECONDS,
  LOCAL_VOICE_CALL_WARNING_SECONDS,
  LOCAL_VOICE_CONFIRMATION_PHRASE,
  type LocalVoiceDraft,
  type LocalVoiceRelayClientMessage,
  type LocalVoiceRelayEndReason,
  type LocalVoiceRelayServerEvent,
  type VoiceBindingMode,
} from "@paperclipai/shared";
import { isConfirmationUtterance, recitationCoverage } from "./voice-summary.js";
import { DICTATION_DRAIN_MS, DICTATION_HOLD_MS, DICTATION_MAX_CHARS, DICTATION_MERGE_MS, FORWARD_WINDOW_MS, SEND_TO_AGENT_TOOL, agentChatVoiceMessageBody, isDictationNoise, isLikelyEcho } from "./voice-dictation.js";
import { toTaiwanTraditional } from "./zh-tw.js";

/**
 * Engine-independent part of the local voice relay (HOM-311, HOM-318).
 *
 * The browser talks only to Paperclip; the relay owns the upstream model
 * connection, its gateway key, every tool call and the spoken-confirmation
 * check. Engines (Gemini Live, OpenAI Realtime) translate their wire protocol
 * into the hooks below; drafts, confirmation, agent replies, notices, the
 * call limits and the reconnect loop live here once.
 */

export interface VoiceRelayBrowser {
  sendEvent(event: LocalVoiceRelayServerEvent): void;
  sendAudio(pcm24k: Buffer): void;
  close(code: number, reason: string): void;
}

/** One upstream realtime WebSocket. Implementations must not log frames or headers. */
export interface VoiceUpstream {
  send(json: string): void;
  close(): void;
}
export interface VoiceUpstreamHandlers {
  onMessage(json: string): void;
  onClose(code: number, reason: string): void;
}
export type VoiceUpstreamFactory = (handlers: VoiceUpstreamHandlers) => Promise<VoiceUpstream>;

export interface VoiceAgentReply {
  commentId: string;
  body: string;
  voiceSummary: string | null;
  spoken: string;
  createdAt: string;
  sourceCommentIds?: string[];
  runId?: string;
}

export interface VoiceSubmitResult {
  status: "accepted" | "failed";
  operationId: string;
  code?: string;
  message?: string;
}

/** Server-owned Paperclip operations, bound to one authorized session. */
export interface VoiceTaskPort {
  /** Read-only status; `identifier` such as HOM-307 selects another readable task. */
  status(identifier?: string): Promise<Record<string, unknown>>;
  /** Create the trusted confirmation receipt and submit exactly the confirmed text. */
  submit(draft: LocalVoiceDraft & { operationId: string }, via: "spoken" | "ui"): Promise<VoiceSubmitResult>;
  /** Agent replies on the voice task not returned before (oldest first). */
  newReplies(): Promise<VoiceAgentReply[]>;
  /** Verify the browser receipt against this caller/session, without resending. */
  resolveInput?(operationId: string, commentId?: string): Promise<string | null>;
  /** Wake the relay when the voice task may have new replies. Returns an unsubscribe. */
  watch(onChange: () => void): () => void;
  /** End the persisted voice session. */
  end(reason: LocalVoiceRelayEndReason): Promise<void>;
}

export interface VoiceRelayOptions {
  browser: VoiceRelayBrowser;
  port: VoiceTaskPort;
  connectUpstream: VoiceUpstreamFactory;
  /** `mode` defaults to voice_task; agent_chat (HOM-326) dictates every finished utterance to the bound Chat. */
  binding: { issueId: string; issueIdentifier: string | null; issueTitle: string; agentName: string; mode?: VoiceBindingMode; policyVersion?: typeof MAIN_ANSWER_POLICY };
  voiceName?: string;
  /** Upstream model id, used for logs and the OpenAI session. */
  model?: string;
  maxSeconds?: number;
  warningSeconds?: number;
  /** Time source and timers are injectable for tests. */
  now?: () => number;
  setTimer?: (fn: () => void, ms: number) => unknown;
  clearTimer?: (handle: unknown) => void;
  log?: (event: string, fields?: Record<string, unknown>) => void;
  /** How long submit waits for a late caller transcription before refusing. */
  transcriptGraceMs?: number;
  replyDebounceMs?: number;
  reconnectDelaysMs?: number[];
  /** agent_chat: quiet time after the caller's last words before a dictation is sent. */
  dictationMergeMs?: number;
  /** agent_chat: longest wait for a transcription once the caller started speaking. */
  dictationHoldMs?: number;
  /** agent_chat: longest wait for transcriptions in progress when the mic pauses or the call ends. */
  dictationDrainMs?: number;
}

/**
 * One caller transcription waiting to be merged into a dictation. `segment`
 * names the caller utterance it belongs to (an OpenAI input item, a Gemini
 * run of fragments); echo is judged per whole utterance, never per fragment.
 */
interface DictationPart { text: string; duringPlayback: boolean; segment: string }

/** One caller utterance; `eligible` is fixed when the caller started speaking. */
export interface CallerUtterance { text: string; eligible: boolean }

export interface DraftState extends LocalVoiceDraft {
  operationId: string;
  /** A completed model turn whose output transcription covered the draft text. */
  recited: boolean;
  /** Caller utterances that began after the recitation finished playing in the browser. */
  utterances: CallerUtterance[];
  uiConfirmed: boolean;
  submitting?: Promise<VoiceSubmitResult>;
  result?: VoiceSubmitResult;
}

/** What a finished model turn did, for the recitation check. */
export interface ModelTurnOutcome { completed: boolean }

export const NOTICE_PREFIX = "[Paperclip 通知]";
const MAX_DRAFT_CHARS = 4000;
const MAX_BUFFERED_AUDIO_FRAMES = 50;
/** Share of the draft's character bigrams that the read-back turn must contain. */
const RECITATION_COVERAGE = 0.6;

export function voiceToolDeclarations(agentName: string) {
  return [
    {
      name: "query_task_status",
      description: `唯讀查詢 Paperclip 任務狀態。不帶參數時回傳這通語音綁定的任務與 ${agentName} 最近的回覆；帶 identifier（例如 HOM-307）時查那張任務。`,
      parameters: { type: "OBJECT", properties: { identifier: { type: "STRING", description: "任務編號，例如 HOM-307" } } },
    },
    {
      name: "prepare_request",
      description: `把 Owner 要交代給 ${agentName} 的話整理成精簡的書面草稿。之後要逐字覆誦草稿，請 Owner 說「${LOCAL_VOICE_CONFIRMATION_PHRASE}」或在畫面上按確認。Owner 修改時再呼叫一次。`,
      parameters: { type: "OBJECT", properties: { text: { type: "STRING", description: "要送出的留言全文（繁體中文）" } }, required: ["text"] },
    },
    {
      name: "submit_request",
      description: `Owner 親口說「${LOCAL_VOICE_CONFIRMATION_PHRASE}」之後，把目前草稿以留言送給 ${agentName}。只會送出留言；結果稍後才會回來，不要等待。`,
      parameters: { type: "OBJECT", properties: { draftId: { type: "STRING" } }, required: ["draftId"] },
    },
    {
      name: "get_updates",
      description: `取得 ${agentName} 在這張語音任務上尚未播報的新回覆。沒有新回覆代表還在處理，不代表完成。`,
      parameters: { type: "OBJECT", properties: {} },
    },
  ];
}

/** agent_chat with a routing model (HOM-265 Owner choice b): the model chats and forwards requests with a tool. */
export function sendToAgentToolDeclaration(agentName: string) {
  return {
    name: SEND_TO_AGENT_TOOL,
    description: `把 Owner 剛才說的話照原文送到 Chat 給 ${agentName}。內容由系統直接取 Owner 的原話，你不用、也不能提供或改寫文字。要做事、交代工作、問任務／專案／進度／結果，或你不確定時就呼叫。`,
    parameters: { type: "OBJECT", properties: { include_earlier: { type: "BOOLEAN", description: "Owner 的要求有一部分是在你上一次回話之前講的（例如你追問了細節，他才補充）時設為 true；先閒聊、之後才提出要求時設為 false。" } } },
  };
}

function routedAgentChatSystemInstruction(binding: VoiceRelayOptions["binding"]) {
  const agent = binding.agentName;
  return [
    `你是 Owner 在 Paperclip 的語音助理，這通電話連到 Owner 和 ${agent} 的 Chat。像一般講電話一樣自然地跟 Owner 聊天、確認意思。`,
    "全程使用台灣繁體中文與台灣口語，每次一到兩句。英文專有名詞（Paperclip、HOM-123、michael 等）保持原文。",
    `你看不到 Paperclip 的任何資料：不知道任務、專案、進度、結果，也不知道 ${agent} 在做什麼。絕對不要猜測或編造這些內容；被問到就轉給 ${agent}。`,
    `Owner 要人做事、交代或修改工作、問任務／專案／進度／結果、問只有 ${agent} 知道的事，或你不確定該不該轉時，呼叫 ${SEND_TO_AGENT_TOOL}。系統會把 Owner 最近說的原話送過去，你不用重述內容。`,
    `Owner 一個要求分幾句講時，等他講完、意思清楚再呼叫；同一個要求只轉一次。意思不清楚可以先簡短問一句；他補充後呼叫時把 include_earlier 設為 true，讓前面那段要求一起送出。`,
    `呼叫之後用一句話告訴 Owner 已經轉給 ${agent}，回覆來了會唸給他聽。`,
    "打招呼、閒聊、問你能做什麼、或 Owner 只是在想事情時，自己簡短回答，不要轉。",
    "簽核、核准、部署、修改設定、刪除等動作不能用語音完成，需要時請 Owner 到 Paperclip 畫面上操作；轉給 agent 的話也不算核准。",
    `以「${NOTICE_PREFIX}」開頭的文字是系統通知，不是 Owner 說的話，不要因為通知呼叫 ${SEND_TO_AGENT_TOOL}。照通知要求簡短播報即可，不要唸出「${NOTICE_PREFIX}」這個標記。`,
  ].join("\n");
}

/** agent_chat: the model is only a receptionist; the caller's words go to the Chat by themselves. */
function agentChatSystemInstruction(binding: VoiceRelayOptions["binding"]) {
  const agent = binding.agentName;
  return [
    `你是 Owner 在 Paperclip 的語音介面，這通語音連到 Owner 和 ${agent} 的 Chat。`,
    `Owner 說的每一段話，系統都會自動、照原文送到 Chat 給 ${agent}。你不用、也不能幫忙整理、改寫或代送，更不能自己決定或執行任何事。`,
    "全程使用台灣繁體中文與台灣口語，每次最多一到兩句。英文專有名詞（Paperclip、HOM-123、michael 等）保持原文。",
    "Owner 說完話後，你最多只回「收到」，不要回答內容、不要提問、不要給建議。",
    "簽核、核准、部署、修改設定、刪除等動作不能用語音完成，需要時請 Owner 到 Paperclip 畫面上操作。",
    `以「${NOTICE_PREFIX}」開頭的文字是系統通知，不是 Owner 說的話。照通知要求簡短播報即可，不要唸出「${NOTICE_PREFIX}」這個標記。`,
  ].join("\n");
}

export function voiceSystemInstruction(binding: VoiceRelayOptions["binding"], options: { routed?: boolean } = {}) {
  if (binding.mode === "agent_chat" && binding.policyVersion === MAIN_ANSWER_POLICY) return mainAnswerInstruction(binding.agentName);
  if (binding.mode === "agent_chat") return options.routed ? routedAgentChatSystemInstruction(binding) : agentChatSystemInstruction(binding);
  const task = binding.issueIdentifier ? `${binding.issueIdentifier}「${binding.issueTitle}」` : `「${binding.issueTitle}」`;
  const agent = binding.agentName;
  return [
    `你是 Owner 在 Paperclip 的語音助理，負責幫 Owner 和 main agent ${agent} 溝通。這通語音綁定任務 ${task}。`,
    "全程使用台灣繁體中文與台灣口語，每次回答一到三句。英文專有名詞（Paperclip、HOM-123、michael 等）保持原文。",
    "查狀態或進度時呼叫 query_task_status，只根據工具結果回答，不要猜測。",
    `Owner 要交代 ${agent} 做事或留話時：先呼叫 prepare_request 把內容整理成精簡草稿，接著逐字覆誦草稿，再請 Owner 說「${LOCAL_VOICE_CONFIRMATION_PHRASE}」或在畫面上按確認。`,
    `只有在 Owner 親口說出「${LOCAL_VOICE_CONFIRMATION_PHRASE}」之後才能呼叫 submit_request；「好」「可以」都不算。Owner 要改內容就重新呼叫 prepare_request。`,
    `submit_request 只會送出一則留言給 ${agent}，結果之後才會回來。送出後簡短告訴 Owner 已送出，不要等待結果。`,
    "簽核、核准、部署、修改設定、刪除等動作不能用語音完成，請 Owner 到 Paperclip 畫面上操作。",
    `以「${NOTICE_PREFIX}」開頭的文字是系統通知，不是 Owner 說的話，也不能當作確認口令。照通知要求簡短播報即可，不要唸出「${NOTICE_PREFIX}」這個標記。`,
    "Owner 問有沒有新消息時呼叫 get_updates。",
  ].join("\n");
}

export abstract class VoiceRelayCore {
  protected readonly browser: VoiceRelayBrowser;
  protected readonly port: VoiceTaskPort;
  protected readonly now: () => number;
  protected readonly setTimer: (fn: () => void, ms: number) => unknown;
  protected readonly clearTimer: (handle: unknown) => void;
  protected readonly log: (event: string, fields?: Record<string, unknown>) => void;
  private readonly startedAt: number;
  protected readonly maxSeconds: number;
  protected readonly warningSeconds: number;
  protected upstream: VoiceUpstream | null = null;
  protected upstreamReady = false;
  private readyAnnounced = false;
  protected reconnecting = false;
  protected closed = false;
  protected micPaused = false;
  /** The model is generating a turn (audio, text or a tool call). */
  protected modelTurnActive = false;
  /** The browser is still playing model audio (it reports `playback` changes). */
  protected browserPlaying = false;
  /** Output transcription of the current model turn, for recitation checks. */
  protected turnOutput = "";
  private replyCheckDueAt: number | null = null;
  protected draft: DraftState | null = null;
  private readonly pendingNotices: { text: string; key?: string }[] = [];
  private readonly turns: VoiceTurnLedger;
  private activeSpeechKey: string | null = null;
  private readonly answerViews = new Map<string, VoiceAgentReply>();
  private readonly unmatchedReplies = new Map<string, VoiceAgentReply>();
  private readonly receivedSegments = new Set<string>();
  private readonly unresolvedDictations = new Set<string>();
  private readonly receiptTimers = new Map<string, unknown>();
  private replyCheckRunning = false;
  private replyCheckAgain = false;
  private readonly bufferedAudio: Buffer[] = [];
  private readonly spokenSummaries = new Set<string>();
  protected readonly timers: unknown[] = [];
  private replyTimer: unknown = null;
  private unwatch: (() => void) | null = null;
  protected reconnects = 0;
  /** Bumped for every new upstream connection; tool results for an older one are dropped. */
  protected connectionGeneration = 0;
  private retireCurrent: (() => void) | null = null;
  private readonly setupAborts = new Set<(error: Error) => void>();
  /** agent_chat: caller transcriptions not yet sent, and the merge timer. */
  private dictationParts: DictationPart[] = [];
  private dictationTimer: unknown = null;
  /** When the merge window first ended while more caller speech was still pending. */
  private dictationHeldSince: number | null = null;
  /** agent_chat: dictations handed to the browser and not yet reported back. */
  private readonly pendingDictations = new Map<string, string>();
  /** Routed agent_chat: caller utterances heard but not yet forwarded or dropped, by segment. */
  private readonly undecidedSegments = new Map<string, { startedAt: number; answered: boolean }>();
  /** Routed agent_chat: segments the model forwarded (true) or that were dropped (false). */
  private readonly segmentFates = new Map<string, boolean>();
  private routeTimer: unknown = null;
  private routeWaitSince: number | null = null;
  /** Recent model speech, for the echo filter. */
  private recentModelOutput: string[] = [];

  /** Engine name for logs: "gemini" or "openai". */
  protected abstract readonly engine: string;
  /** PCM16 mono rate the browser must send. */
  abstract readonly inputSampleRate: number;
  protected abstract readonly defaultTranscriptGraceMs: number;
  /** Whether a tool result produced for a replaced connection is dropped instead of sent on the new one. */
  protected abstract readonly dropStaleToolResults: boolean;

  constructor(protected readonly options: VoiceRelayOptions) {
    this.browser = options.browser;
    this.port = options.port;
    this.now = options.now ?? Date.now;
    this.setTimer = options.setTimer ?? ((fn, ms) => setTimeout(fn, ms));
    this.clearTimer = options.clearTimer ?? ((handle) => clearTimeout(handle as ReturnType<typeof setTimeout>));
    this.log = options.log ?? (() => undefined);
    this.turns = new VoiceTurnLedger({
      now: this.now,
      setTimer: (fn, ms) => this.setTimer(fn, ms) as ReturnType<typeof setTimeout>,
      clearTimer: (timer) => this.clearTimer(timer),
      onTurn: (turn) => {
        this.browser.sendEvent({ type: "voice_turn", turnId: turn.turnId, operationId: turn.operationId,
          state: turn.state, ...(turn.inputCommentId ? { inputCommentId: turn.inputCommentId } : {}),
          ...(turn.answerCommentId ? { answerCommentId: turn.answerCommentId } : {}),
          ...(turn.error ? { error: turn.error } : {}) });
        this.log("voice_turn_state", { turnId: turn.turnId, state: turn.state, elapsedMs: this.now() - turn.createdAt });
      },
      onAnswer: (answer) => {
        const reply = this.answerViews.get(answer.commentId);
        if (reply) this.browser.sendEvent({ type: "agent_reply", commentId: reply.commentId, body: reply.body,
          voiceSummary: reply.voiceSummary, createdAt: reply.createdAt,
          turnIds: answer.turnIds,
          playbackState: answer.state === "answer_ready" || answer.state === "speaking" ? "queued" : answer.state });
      },
      onNotice: (text, key) => this.queueNotice(this.exactSpeech(text), key),
      onSpeechReady: () => this.flushNotices(),
    });
    this.startedAt = this.now();
    this.maxSeconds = options.maxSeconds ?? LOCAL_VOICE_CALL_MAX_SECONDS;
    this.warningSeconds = options.warningSeconds ?? LOCAL_VOICE_CALL_WARNING_SECONDS;
  }

  /** agent_chat binding (HOM-326): no tools, no drafts; every finished utterance is dictated to the Chat. */
  protected get mainAnswerChat() { return this.chatMode && this.options.binding.policyVersion === MAIN_ANSWER_POLICY; }
  protected get chatMode() { return this.options.binding.mode === "agent_chat"; }
  /** Whether the engine speaks a short acknowledgement by itself (Gemini answers every utterance). */
  protected readonly acknowledgesSpeech: boolean = false;
  /**
   * agent_chat where the model talks with the caller and forwards requests
   * with {@link SEND_TO_AGENT_TOOL} (HOM-265). Only forwarded utterances reach
   * the Chat, still as the caller's own words; small talk stays in the call.
   */
  protected get routedChat() { return false; }

  // ---- engine hooks -------------------------------------------------------

  /** A new socket is open; send whatever the protocol needs first. */
  protected abstract onUpstreamOpen(socket: VoiceUpstream): void;
  /** Handshake progress for a not-yet-ready socket: "ready", "failed" or null (keep waiting). */
  protected abstract handshake(message: Record<string, any>, socket: VoiceUpstream): "ready" | "failed" | null;
  /** Every parsed upstream frame (including handshake frames). */
  protected abstract handleUpstreamMessage(message: Record<string, any>): void;
  protected abstract sendAudio(pcm: Buffer): void;
  /** Add a user text turn and ask the model to answer it. Returns false when nothing was sent. */
  protected abstract sendUserTurn(text: string): boolean;
  protected abstract onMicPaused(): void;
  /** Return a tool result to the model on the current connection. */
  protected abstract sendToolResult(call: { id: unknown; name: string }, response: Record<string, unknown>): void;
  /** Called before the first reconnect attempt; returns whether context survived once reconnected. */
  protected abstract beginReconnect(): () => boolean;
  protected onReconnectAttemptFailed() { /* engine-specific */ }
  /** Fresh connection state after a successful reconnect. */
  protected onReconnected() { /* engine-specific */ }
  /** Busy beyond `modelTurnActive` (for example a tool result still being produced). */
  protected engineBusy() { return false; }
  protected abstract usageSnapshot(): Record<string, unknown>;

  async start() {
    this.timers.push(this.setTimer(() => this.warnDuration(), this.warningSeconds * 1000));
    this.timers.push(this.setTimer(() => void this.end("max_duration"), this.maxSeconds * 1000));
    this.unwatch = this.port.watch(() => this.scheduleReplyCheck());
    try {
      const upstream = await this.openUpstream();
      if (this.closed) { this.retireCurrent?.(); try { upstream.close(); } catch { /* closed */ } return; }
      this.upstream = upstream;
    } catch (error) {
      this.log("voice_relay_upstream_failed", { engine: this.engine, error: safeError(error) });
      await this.end("upstream_unavailable");
    }
  }

  // ---- browser side -------------------------------------------------------

  handleBrowserAudio(pcm: Buffer) {
    if (this.closed || this.micPaused || pcm.length === 0 || pcm.length % 2 !== 0) return;
    if (!this.upstreamReady || this.reconnecting) {
      this.bufferedAudio.push(pcm);
      if (this.bufferedAudio.length > MAX_BUFFERED_AUDIO_FRAMES) this.bufferedAudio.shift();
      return;
    }
    this.sendAudio(pcm);
  }

  async handleBrowserMessage(message: LocalVoiceRelayClientMessage) {
    if (this.closed) return;
    switch (message.type) {
      case "text":
        if (this.chatMode) {
          // Typed text is already exact: send it at once, after anything still being merged.
          if (this.routedChat) this.routeDictation(true); else this.flushDictation();
          this.emitDictation(message.text.trim());
          return;
        }
        this.sendUserTurn(message.text);
        return;
      case "dictation_result":
        await this.onDictationResult(message);
        return;
      case "replay_reply":
        if (this.mainAnswerChat && this.turns.replay(message.commentId)) this.flushNotices();
        return;
      case "playback":
        this.browserPlaying = message.playing;
        if (this.mainAnswerChat && this.activeSpeechKey) {
          if (message.playing) this.turns.playbackStarted(this.activeSpeechKey);
          else if (!this.modelTurnActive) {
            const key = this.activeSpeechKey;
            this.activeSpeechKey = null;
            this.turns.playbackDrained(key);
          }
        }
        this.onBrowserPlayback(message.playing);
        if (!message.playing) this.flushNotices();
        return;
      case "mic":
        this.micPaused = message.state === "paused";
        if (this.micPaused) {
          this.bufferedAudio.length = 0;
          this.onMicPaused();
          // Words already heard are still sent, including a transcription still in progress.
          // Routed: the committed audio still gets a model answer, which decides whether it is forwarded.
          if (this.chatMode && this.routedChat) this.commitCallerAudio();
          else if (this.chatMode) void this.drainDictation(this.options.dictationDrainMs ?? DICTATION_DRAIN_MS);
        }
        return;
      case "confirm_draft": {
        const draft = this.draft;
        if (!draft || draft.draftId !== message.draftId || draft.revision !== message.revision) {
          this.browser.sendEvent({ type: "submit_failed", draftId: message.draftId, revision: message.revision, code: "voice_draft_stale", message: "這份草稿已經更新或不存在" });
          return;
        }
        draft.uiConfirmed = true;
        const result = await this.submitDraft(draft, "ui");
        this.queueNotice(result.status === "accepted"
          ? `${NOTICE_PREFIX} Owner 已在畫面上按確認，草稿已送給 ${this.options.binding.agentName}。請用一句話告訴 Owner 已送出。`
          : `${NOTICE_PREFIX} 草稿送出失敗：${result.message ?? result.code ?? "未知錯誤"}。請用一句話告訴 Owner。`);
        return;
      }
      case "cancel_draft":
        if (this.draft?.draftId === message.draftId && !this.draft.result && !this.draft.submitting) {
          this.draft = null;
          this.browser.sendEvent({ type: "draft_cleared", draftId: message.draftId });
          this.queueNotice(`${NOTICE_PREFIX} Owner 在畫面上取消了草稿，沒有送出。`);
        }
        return;
      case "end":
        await this.end("caller_ended");
        return;
    }
  }

  protected onBrowserPlayback(_playing: boolean) { /* engine-specific */ }

  handleBrowserClosed() {
    this.browserGone = true;
    void this.end("caller_ended");
  }

  // ---- upstream connection ------------------------------------------------

  private async openUpstream(): Promise<VoiceUpstream> {
    const connection: { socket: VoiceUpstream | null; retired: boolean; ready: boolean } = { socket: null, retired: false, ready: false };
    /** Frames that arrive before the factory resolves (OpenAI sends session.created right after the upgrade). */
    const early: string[] = [];
    const setupDone = new Promise<void>((resolve, reject) => {
      // end() aborts a setup in flight so the caller never waits for the timeout.
      this.setupAborts.add(reject);
      const handlers: VoiceUpstreamHandlers = {
        onMessage: (json) => {
          if (connection.retired || this.closed) return;
          if (!connection.socket) { if (early.length < 32) early.push(json); return; }
          let message: Record<string, any>;
          try { message = JSON.parse(json); } catch { return; }
          if (!message || typeof message !== "object") return;
          // A malformed gateway frame must never throw into the socket listener.
          try {
            if (!connection.ready) {
              const state = this.handshake(message, connection.socket);
              if (state === "failed") { reject(new Error("upstream session setup was rejected")); return; }
              if (state === "ready") {
                connection.ready = true;
                this.connectionGeneration += 1;
                this.markReady();
                resolve();
              }
            }
            this.handleUpstreamMessage(message);
          } catch (error) { this.log("voice_relay_frame_rejected", { engine: this.engine, error: safeError(error) }); }
        },
        onClose: (code, reason) => {
          reject(new Error(`upstream closed ${code}`));
          if (!connection.retired && connection.socket !== null && connection.socket === this.upstream) this.handleUpstreamClosed(code, reason);
        },
      };
      this.options.connectUpstream(handlers).then((socket) => {
        connection.socket = socket;
        // A connection that resolves after its timeout or after the call ended is closed at once.
        if (connection.retired || this.closed) { try { socket.close(); } catch { /* closed */ } return; }
        this.onUpstreamOpen(socket);
        for (const json of early.splice(0)) handlers.onMessage(json);
      }, reject);
    });
    try {
      await withTimeout(setupDone, 15_000);
    } catch (error) {
      this.setupAborts.clear();
      connection.retired = true;
      try { connection.socket?.close(); } catch { /* already closed */ }
      throw error;
    }
    this.setupAborts.clear();
    if (this.closed) {
      connection.retired = true;
      try { connection.socket?.close(); } catch { /* closed */ }
      throw new Error("call ended during upstream setup");
    }
    this.retireCurrent = () => { connection.retired = true; };
    return connection.socket!;
  }

  private markReady() {
    this.upstreamReady = true;
    if (this.readyAnnounced) return;
    this.readyAnnounced = true;
    const { issueId, issueIdentifier, agentName } = this.options.binding;
    this.browser.sendEvent({ type: "ready", issueId, issueIdentifier, agentName, maxSeconds: this.maxSeconds, warningSeconds: this.warningSeconds, inputSampleRate: this.inputSampleRate,
      bindingMode: this.options.binding.mode ?? "voice_task", ...(this.mainAnswerChat ? { policyVersion: MAIN_ANSWER_POLICY } : {}) });
  }

  private handleUpstreamClosed(code: number, reason: string) {
    this.upstreamReady = false;
    if (this.closed) return;
    this.log("voice_relay_upstream_closed", { engine: this.engine, code, reason: reason.slice(0, 120) });
    void this.reconnect(`closed_${code}`);
  }

  protected async reconnect(reason: string) {
    if (this.closed || this.reconnecting) return;
    if (this.mainAnswerChat) this.interruptChatPlayback();
    this.reconnecting = true;
    this.reconnects += 1;
    this.browser.sendEvent({ type: "reconnecting", reason });
    const previous = this.upstream;
    const retirePrevious = this.retireCurrent;
    const contextKept = this.beginReconnect();
    const delays = this.options.reconnectDelaysMs ?? [0, 500, 1500, 4000];
    for (const delay of delays) {
      if (this.closed) return;
      if (delay > 0) await new Promise<void>((resolve) => this.setTimer(resolve, delay));
      try {
        const next = await this.openUpstream();
        if (this.closed) { this.retireCurrent?.(); try { next.close(); } catch { /* closed */ } return; }
        this.upstream = next;
        // Retire the previous connection only after the new one is ready.
        retirePrevious?.();
        if (previous && previous !== next) { try { previous.close(); } catch { /* already closed */ } }
        this.reconnecting = false;
        this.upstreamReady = true;
        this.modelTurnActive = false;
        this.turnOutput = "";
        this.onReconnected();
        const kept = contextKept();
        this.browser.sendEvent({ type: "resumed", contextKept: kept });
        // Audio held during the switch is judged only when the new session hears it, after the
        // read-back stopped playing. While a read-back draft awaits confirmation it could carry a
        // 「確認送出」 spoken over (or echoed from) the read-back, so it is dropped instead.
        const frames = this.bufferedAudio.splice(0);
        if (!(this.draft?.recited && this.draft.result === undefined)) for (const frame of frames) this.sendAudio(frame);
        if (!kept) this.queueNotice(`${NOTICE_PREFIX} 語音連線剛重新建立，先前的對話內容可能遺失。請用一句話請 Owner 繼續說。`);
        this.flushNotices();
        return;
      } catch (error) {
        this.log("voice_relay_reconnect_failed", { engine: this.engine, error: safeError(error) });
        this.onReconnectAttemptFailed();
      }
    }
    this.reconnecting = false;
    await this.end("upstream_unavailable");
  }

  protected sendUpstream(message: Record<string, unknown>) {
    if (!this.upstream || !this.upstreamReady || this.closed) return false;
    try { this.upstream.send(JSON.stringify(message)); return true; } catch { return false; }
  }

  // ---- model turns and caller speech ---------------------------------------

  /**
   * A draft counts as read back only after a model turn that completed (not
   * interrupted) and whose output transcription covers most of the draft.
   */
  protected finishModelTurn(outcome: ModelTurnOutcome) {
    this.modelTurnActive = false;
    const draft = this.draft;
    if (outcome.completed && draft && !draft.recited && draft.result === undefined
      && recitationCoverage(this.recitationText(draft.text), this.recitationText(this.turnOutput)) >= RECITATION_COVERAGE) {
      draft.recited = true;
      draft.utterances = [];
      this.onRecited(draft);
    }
    if (this.turnOutput.trim()) {
      this.recentModelOutput.push(this.turnOutput);
      if (this.recentModelOutput.length > 2) this.recentModelOutput.shift();
    }
    this.turnOutput = "";
    if (this.mainAnswerChat && this.activeSpeechKey && !this.browserPlaying) {
      const key = this.activeSpeechKey;
      this.activeSpeechKey = null;
      if (outcome.completed) this.turns.playbackDrained(key); else this.turns.interrupt();
    }
    this.flushNotices();
  }

  protected onRecited(_draft: DraftState) { /* engine-specific */ }
  /** Normalization applied to both the draft and the spoken output before the read-back check. */
  protected recitationText(text: string) { return text; }

  /**
   * A caller utterance begins. Only one that starts after the read-back
   * finished, while neither the model is generating nor the browser is still
   * playing its audio, can confirm a draft. This keeps the model's own voice
   * (speaker echo) from confirming.
   */
  protected beginUtterance(): CallerUtterance {
    const eligible = Boolean(this.draft?.recited) && !this.modelTurnActive && !this.browserPlaying;
    const utterance: CallerUtterance = { text: "", eligible };
    this.draft?.utterances.push(utterance);
    return utterance;
  }

  // ---- agent_chat dictation -------------------------------------------------

  /** Caller transcriptions still being produced by the engine (agent_chat drain). */
  protected pendingTranscriptions(): number { return 0; }
  /** Ask the engine to finish the caller audio heard so far (agent_chat drain). */
  protected commitCallerAudio() { /* engine-specific */ }

  /**
   * Finish what the caller already said, then flush it: commit their audio,
   * wait (bounded) for transcriptions in progress, then merge and send.
   */
  protected async drainDictation(maxMs: number) {
    if (!this.chatMode || this.closed) return;
    this.commitCallerAudio();
    // Routed: at the end of the call, words the model never got to answer are forwarded;
    // words it already answered as small talk are not.
    if (this.routedChat) this.settleUndecided((entry) => !entry.answered);
    const step = 100;
    for (let waited = 0; waited < maxMs && this.pendingTranscriptions() > 0 && !this.closed; waited += step) {
      await new Promise<void>((resolve) => this.setTimer(resolve, step));
    }
    if (this.closed) return;
    if (this.routedChat) this.routeDictation(true); else this.flushDictation();
  }

  // ---- routed agent_chat ----------------------------------------------------

  /** Routed: the caller began an utterance (an engine segment id). */
  protected noteCallerSegment(segment: string) {
    if (!this.routedChat || !segment || this.segmentFates.has(segment)) return;
    this.undecidedSegments.set(segment, { startedAt: this.now(), answered: false });
  }

  /**
   * Routed: the model finished answering what the caller said before `before`
   * without forwarding it. A question back (「要查哪一個？」) keeps those words
   * for the request that follows; any other answer means small talk, which is
   * never sent to the Chat.
   */
  protected resolveAnsweredSegments(before: number, askedBack: boolean) {
    let dropped = 0;
    for (const [segment, entry] of this.undecidedSegments) {
      if (entry.startedAt > before) continue;
      if (askedBack) { entry.answered = true; continue; }
      this.undecidedSegments.delete(segment);
      this.segmentFates.set(segment, false);
      dropped += 1;
    }
    if (dropped) this.routeDictation();
  }

  /** Routed: whether this segment's transcription is still in progress. */
  protected segmentPending(_segment: string) { return false; }

  /** Fix the fate of every undecided segment: forwarded when `forward` says so, otherwise dropped. */
  private settleUndecided(forward: (entry: { startedAt: number; answered: boolean }) => boolean) {
    let forwarded = 0;
    let dropped = 0;
    for (const [segment, entry] of this.undecidedSegments) {
      const keep = forward(entry);
      this.segmentFates.set(segment, keep);
      if (keep) forwarded += 1; else dropped += 1;
    }
    this.undecidedSegments.clear();
    return { forwarded, dropped };
  }

  /** The model asked to forward what the caller just said. */
  private forwardRecentSpeech(includeEarlier: boolean): Record<string, unknown> {
    const agent = this.options.binding.agentName;
    if (!this.routedChat) return { status: "error", message: "這通電話不需要轉送" };
    const cutoff = this.now() - FORWARD_WINDOW_MS;
    // Words the model already answered with a question are sent only when it says they belong to this request.
    const { forwarded, dropped } = this.settleUndecided((entry) => entry.startedAt >= cutoff && (!entry.answered || includeEarlier));
    this.log("voice_relay_forward_requested", { engine: this.engine, forwarded, dropped });
    this.routeDictation();
    return forwarded
      ? { status: "ok", message: `已把 Owner 的原話轉給 ${agent}。用一句話告訴 Owner 已轉出，回覆來了會唸給他聽。` }
      : { status: "nothing_to_send", message: "沒有新的話可以轉，不要再呼叫；如果 Owner 的要求還沒講，請他再說一次。" };
  }

  /**
   * Routed: drop parts of dropped segments, and send forwarded parts once their
   * transcriptions are in (bounded wait). Undecided parts stay buffered.
   */
  private routeDictation(immediate = false) {
    if (this.routeTimer !== null) { this.clearTimer(this.routeTimer); this.routeTimer = null; }
    if (this.closed) return;
    const dropped = this.dictationParts.filter((part) => this.segmentFates.get(part.segment) === false);
    if (dropped.length) {
      this.dictationParts = this.dictationParts.filter((part) => this.segmentFates.get(part.segment) !== false);
      this.log("voice_relay_small_talk_kept_in_call", { engine: this.engine, parts: dropped.length });
    }
    const forwardSegments = [...this.segmentFates].filter(([, keep]) => keep).map(([segment]) => segment);
    if (!forwardSegments.length) { this.routeWaitSince = null; return; }
    const at = this.now();
    this.routeWaitSince ??= at;
    const waiting = forwardSegments.some((segment) => this.segmentPending(segment));
    if (waiting && !immediate && at - this.routeWaitSince < (this.options.dictationHoldMs ?? DICTATION_HOLD_MS)) {
      this.routeTimer = this.setTimer(() => this.routeDictation(), 200);
      return;
    }
    this.routeWaitSince = null;
    const selected = new Set(forwardSegments);
    // A fate is kept while its transcription is still in progress, so a late transcript follows it.
    for (const [segment] of [...this.segmentFates]) if (!this.segmentPending(segment)) this.segmentFates.delete(segment);
    this.flushDictation((part) => selected.has(part.segment));
  }

  /** The caller started speaking: keep merging until their words are transcribed. */
  protected holdDictation() {
    if (!this.chatMode || this.closed || this.dictationParts.length === 0 || this.routedChat) return;
    this.armDictationTimer(this.options.dictationHoldMs ?? DICTATION_HOLD_MS);
  }

  /** A caller transcription (a whole utterance or a fragment) for the bound Chat. */
  protected collectDictation(text: string, meta: { duringPlayback: boolean; segment: string }) {
    // Transcriptions that arrive after a pause are of audio heard before it, so they are kept.
    if (!this.chatMode || this.closed) return;
    const clean = toTaiwanTraditional(text);
    if (!clean.trim()) return;
    if (this.mainAnswerChat && this.receivedSegments.size >= 2048) {
      this.browser.sendEvent({ type: "error", code: "voice_segment_limit", message: "這通電話的語音段數已達上限，請重新通話。" });
      void this.end("relay_error");
      return;
    }
    if (this.mainAnswerChat && meta.segment && this.receivedSegments.has(meta.segment)) return;
    if (this.routedChat && this.segmentFates.get(meta.segment) === false) {
      this.log("voice_relay_small_talk_kept_in_call", { engine: this.engine, parts: 1 });
      return;
    }
    this.dictationParts.push({ text: clean, duringPlayback: meta.duringPlayback, segment: meta.segment });
    if (this.routedChat) { this.routeDictation(); return; }
    this.armDictationTimer(this.options.dictationMergeMs ?? DICTATION_MERGE_MS);
  }

  private armDictationTimer(ms: number) {
    if (this.dictationTimer !== null) this.clearTimer(this.dictationTimer);
    this.dictationTimer = this.setTimer(() => this.onDictationTimer(), ms);
  }

  /** The quiet gap passed; still wait while the caller's next utterance is being heard or transcribed (bounded). */
  private onDictationTimer() {
    this.dictationTimer = null;
    const now = this.now();
    this.dictationHeldSince ??= now;
    if (this.pendingTranscriptions() > 0 && now - this.dictationHeldSince < (this.options.dictationHoldMs ?? DICTATION_HOLD_MS)) {
      this.dictationTimer = this.setTimer(() => this.onDictationTimer(), 200);
      return;
    }
    this.flushDictation();
  }

  /** Merge, filter and hand the dictation to the browser, which posts it as the caller's Chat message. */
  protected flushDictation(select?: (part: DictationPart) => boolean) {
    if (this.dictationTimer !== null) { this.clearTimer(this.dictationTimer); this.dictationTimer = null; }
    this.dictationHeldSince = null;
    const parts = select ? this.dictationParts.filter(select) : this.dictationParts.splice(0);
    if (select) this.dictationParts = this.dictationParts.filter((part) => !select(part));
    if (!parts.length || this.closed) return;
    // Rebuild whole utterances from their fragments before judging echo.
    const utterances: { texts: string[]; duringPlayback: boolean; segment: string }[] = [];
    for (const part of parts) {
      const last = utterances[utterances.length - 1];
      if (last && last.segment === part.segment) { last.texts.push(part.text); last.duringPlayback ||= part.duringPlayback; }
      else utterances.push({ texts: [part.text], duringPlayback: part.duringPlayback, segment: part.segment });
    }
    const recent = this.recentModelOutput.join(" ") + " " + this.turnOutput;
    const kept: string[] = [];
    for (const utterance of utterances) {
      const text = joinDictation(utterance.texts);
      // Only speech that began while (or just after) model audio played can be its echo.
      if (utterance.duringPlayback && isLikelyEcho(text, recent)) {
        this.log("voice_relay_dictation_echo_dropped", { engine: this.engine, chars: Array.from(text).length });
        this.browser.sendEvent({ type: "dictation_dropped", text, reason: "echo" });
      } else kept.push(text);
    }
    const text = joinDictation(kept);
    if (!text) return;
    if (this.mainAnswerChat) {
      for (const part of parts) if (part.segment) this.receivedSegments.add(part.segment);
      const greeting = localGreeting(text);
      if (greeting) { this.queueNotice(this.exactSpeech(greeting)); return; }
    }
    if (isDictationNoise(text, this.mainAnswerChat)) {
      this.log("voice_relay_dictation_noise_dropped", { engine: this.engine, chars: Array.from(text).length });
      if (text.trim()) this.browser.sendEvent({ type: "dictation_dropped", text, reason: "noise" });
      return;
    }
    this.emitDictation(text, [...new Set(parts.map((part) => part.segment).filter(Boolean))]);
  }

  private emitDictation(raw: string, segmentIds: string[] = []) {
    const text = Array.from(raw).slice(0, DICTATION_MAX_CHARS).join("");
    if (!text) return;
    const operationId = randomUUID();
    if (this.mainAnswerChat) {
      try { if (this.turns.register(operationId, segmentIds).operationId !== operationId) return; }
      catch { this.browser.sendEvent({ type: "error", code: "voice_turn_limit", message: "這通電話的對話輪數已達上限，請重新通話。" }); return; }
    }
    this.pendingDictations.set(operationId, text);
    this.browser.sendEvent({ type: "dictation", operationId, text, body: agentChatVoiceMessageBody(text, this.mainAnswerChat ? operationId : undefined),
      ...(this.mainAnswerChat ? { turnId: operationId, segmentIds } : {}) });
    if (this.mainAnswerChat) this.receiptTimers.set(operationId, this.setTimer(() => {
      this.receiptTimers.delete(operationId);
      void this.onDictationResult({ type: "dictation_result", operationId, status: "unknown", message: "送出結果尚未確認，請查看原對話。" });
    }, 15_000));
  }

  private async onDictationResult(message: Extract<LocalVoiceRelayClientMessage, { type: "dictation_result" }>) {
    if (!this.chatMode || !this.pendingDictations.has(message.operationId)) return;
    const timer = this.receiptTimers.get(message.operationId);
    if (timer !== undefined) this.clearTimer(timer);
    this.receiptTimers.delete(message.operationId);
    if (this.mainAnswerChat) {
      let commentId: string | null = null;
      try { commentId = await this.port.resolveInput?.(message.operationId, message.commentId) ?? null; }
      catch { this.log("voice_input_receipt_check_failed", { operationId: message.operationId }); }
      if (this.closed) return;
      if (commentId) {
        this.pendingDictations.delete(message.operationId);
        this.unresolvedDictations.delete(message.operationId);
        this.turns.stored(message.operationId, commentId);
        for (const [id, reply] of this.unmatchedReplies) {
          if (this.turns.reply({ ...reply, sourceCommentIds: reply.sourceCommentIds ?? [] })) this.unmatchedReplies.delete(id);
        }
        this.scheduleReplyCheck();
      } else {
        if (message.status !== "failed") this.unresolvedDictations.add(message.operationId);
        this.turns.fail(message.operationId, message.status === "failed" ? "failed" : "unknown", message.message ?? "尚未確認留言收據，請查看原對話。");
      }
      return;
    }
    this.pendingDictations.delete(message.operationId);
    const agent = this.options.binding.agentName;
    if (message.status === "sent") {
      this.log("voice_relay_dictation_sent", { engine: this.engine });
      if (!this.acknowledgesSpeech && !this.routedChat) this.queueNotice(`${NOTICE_PREFIX} Owner 剛才的話已經照原文送到 Chat 給 ${agent}。只說「收到」兩個字，不要加其他內容。`);
    } else {
      this.log("voice_relay_dictation_failed", { engine: this.engine });
      this.queueNotice(`${NOTICE_PREFIX} 剛才那段話沒有送到 ${agent} 的 Chat。請用一句話請 Owner 看畫面上的錯誤，或再說一次。`);
    }
  }

  // ---- tools --------------------------------------------------------------

  protected async runToolCall(call: { id?: unknown; name?: unknown; args?: unknown }) {
    const name = typeof call.name === "string" ? call.name : "";
    const args = call.args && typeof call.args === "object" && !Array.isArray(call.args) ? call.args as Record<string, unknown> : {};
    const generation = this.connectionGeneration;
    let response: Record<string, unknown>;
    try {
      response = await this.runTool(name, args);
    } catch (error) {
      this.log("voice_relay_tool_failed", { engine: this.engine, tool: name, error: safeError(error) });
      response = { status: "error", message: "Paperclip 暫時無法完成這個動作" };
    }
    if (this.dropStaleToolResults && generation !== this.connectionGeneration) {
      // The call id belongs to a replaced upstream session; the draft state is kept server-side.
      this.log("voice_relay_tool_result_dropped", { engine: this.engine, tool: name });
      this.onToolResultDropped({ id: call.id, name });
      return;
    }
    this.sendToolResult({ id: call.id, name }, response);
  }

  protected onToolResultDropped(_call: { id: unknown; name: string }) { /* engine-specific */ }

  private async runTool(name: string, args: Record<string, unknown>): Promise<Record<string, unknown>> {
    switch (name) {
      case "query_task_status": {
        const identifier = typeof args.identifier === "string" && args.identifier.trim() ? args.identifier.trim() : undefined;
        return this.port.status(identifier);
      }
      case "prepare_request": return this.prepareDraft(String(args.text ?? ""));
      case "submit_request": return this.submitFromModel(String(args.draftId ?? ""));
      case SEND_TO_AGENT_TOOL: return this.forwardRecentSpeech(args.include_earlier === true);
      case "get_updates": {
        const replies = await this.port.newReplies();
        for (const reply of replies) this.announceReplyToBrowser(reply);
        for (const reply of replies) this.spokenSummaries.add(reply.spoken);
        return replies.length
          ? { status: "ok", replies: replies.map((reply) => ({ at: reply.createdAt, summary: reply.spoken })) }
          : { status: "pending", replies: [], message: `${this.options.binding.agentName} 還沒有新的回覆` };
      }
      default:
        return { status: "error", message: `未知的工具 ${name}` };
    }
  }

  protected beforeNewDraft() { /* engine-specific */ }

  private prepareDraft(raw: string): Record<string, unknown> {
    const text = raw.trim();
    if (!text) return { status: "error", message: "草稿內容是空的" };
    if (Array.from(text).length > MAX_DRAFT_CHARS) return { status: "error", message: `草稿太長，請精簡到 ${MAX_DRAFT_CHARS} 字以內` };
    if (this.draft?.submitting) return { status: "busy", message: "上一版草稿正在送出，請等送出結果出來再修改" };
    const current = this.draft && !this.draft.result ? this.draft : null;
    this.beforeNewDraft();
    // Only speech after this draft exists can count as its read-back.
    this.turnOutput = "";
    this.draft = {
      draftId: current?.draftId ?? randomUUID(),
      revision: (current?.revision ?? 0) + 1,
      text,
      operationId: randomUUID(),
      recited: false,
      utterances: [],
      uiConfirmed: false,
    };
    const { draftId, revision } = this.draft;
    this.browser.sendEvent({ type: "draft", draft: { draftId, revision, text } });
    return {
      status: "draft_ready", draftId, revision, text,
      next: `逐字覆誦這份草稿，然後請 Owner 說「${LOCAL_VOICE_CONFIRMATION_PHRASE}」，或在畫面上按確認。Owner 說出口令之前不要呼叫 submit_request。`,
    };
  }

  private async submitFromModel(draftId: string): Promise<Record<string, unknown>> {
    const draft = this.draft;
    if (!draft || draft.draftId !== draftId) return { status: "error", message: "找不到這份草稿，請先呼叫 prepare_request" };
    if (draft.result?.status === "accepted") return { status: "accepted", message: "這份草稿已經送出過了" };
    if (!draft.uiConfirmed && !(await this.heardConfirmation(draft))) {
      return {
        status: "confirmation_required",
        message: `還沒聽到 Owner 在覆誦之後親口說「${LOCAL_VOICE_CONFIRMATION_PHRASE}」。請覆誦草稿並請 Owner 說出口令，或請 Owner 在畫面上按確認。`,
      };
    }
    const result = await this.submitDraft(draft, draft.uiConfirmed ? "ui" : "spoken");
    return result.status === "accepted"
      ? { status: "accepted", message: `已送給 ${this.options.binding.agentName}，結果稍後會通知 Owner。` }
      : { status: "failed", code: result.code ?? "submit_failed", message: result.message ?? "送出失敗" };
  }

  /** Caller audio transcribed after the recitation, possibly arriving just after the tool call. */
  private async heardConfirmation(draft: DraftState) {
    const check = () => draft.recited && draft.utterances.some((utterance) => utterance.eligible && isConfirmationUtterance(utterance.text, LOCAL_VOICE_CONFIRMATION_PHRASE));
    if (check()) return true;
    const grace = this.options.transcriptGraceMs ?? this.defaultTranscriptGraceMs;
    if (grace <= 0) return false;
    // Poll so a transcription that lands early ends the wait early.
    const step = Math.min(250, grace);
    for (let waited = 0; waited < grace; waited += step) {
      await new Promise<void>((resolve) => this.setTimer(resolve, step));
      if (this.draft !== draft || this.closed) return false;
      if (check()) return true;
    }
    return false;
  }

  private submitDraft(draft: DraftState, via: "spoken" | "ui"): Promise<VoiceSubmitResult> {
    if (draft.result?.status === "accepted") return Promise.resolve(draft.result);
    if (draft.submitting) return draft.submitting;
    draft.submitting = (async () => {
      let result: VoiceSubmitResult;
      try {
        result = await this.port.submit({ draftId: draft.draftId, revision: draft.revision, text: draft.text, operationId: draft.operationId }, via);
      } catch (error) {
        result = { status: "failed", operationId: draft.operationId, code: "submit_unknown", message: "送出結果不明，請在畫面上查看任務留言" };
        this.log("voice_relay_submit_unknown", { engine: this.engine, error: safeError(error) });
      }
      draft.submitting = undefined;
      if (result.status === "accepted") {
        draft.result = result;
        this.browser.sendEvent({ type: "submitted", draftId: draft.draftId, revision: draft.revision, operationId: result.operationId, via });
      } else {
        // Keep the same operation id: a retry of an unknown outcome must stay idempotent.
        this.browser.sendEvent({ type: "submit_failed", draftId: draft.draftId, revision: draft.revision, code: result.code ?? "submit_failed", message: result.message ?? "送出失敗" });
      }
      return result;
    })();
    return draft.submitting;
  }

  // ---- agent replies and notices -----------------------------------------

  private scheduleReplyCheck() {
    if (this.closed) return;
    const debounce = this.options.replyDebounceMs ?? (this.mainAnswerChat ? 100 : 3000);
    const now = this.now();
    // Debounce bursts of activity, but never delay a check by more than three debounce windows.
    this.replyCheckDueAt ??= now + debounce * 3;
    if (this.replyTimer !== null) this.clearTimer(this.replyTimer);
    const wait = Math.max(0, Math.min(debounce, this.replyCheckDueAt - now));
    this.replyTimer = this.setTimer(() => { this.replyTimer = null; this.replyCheckDueAt = null; void this.checkReplies(); }, wait);
  }

  private async checkReplies() {
    if (this.closed) return;
    if (this.replyCheckRunning) { this.replyCheckAgain = true; return; }
    this.replyCheckRunning = true;
    try { await this.readReplies(); } catch (error) {
      this.log("voice_reply_processing_failed", { error: safeError(error) });
      this.browser.sendEvent({ type: "error", code: "voice_reply_processing_failed", message: "回答無法繼續播報，請查看原對話或重新通話。" });
      await this.end("relay_error");
    } finally {
      this.replyCheckRunning = false;
      if (this.replyCheckAgain) { this.replyCheckAgain = false; this.scheduleReplyCheck(); }
    }
  }

  private async readReplies() {
    if (this.closed) return;
    if (this.mainAnswerChat) for (const operationId of [...this.unresolvedDictations]) {
      await this.onDictationResult({ type: "dictation_result", operationId, status: "unknown", message: "仍未確認送出收據，請查看原對話。" });
    }
    let replies: VoiceAgentReply[];
    try { replies = await this.port.newReplies(); } catch (error) {
      this.log("voice_relay_reply_check_failed", { engine: this.engine, error: safeError(error) });
      if (this.mainAnswerChat) this.browser.sendEvent({ type: "error", code: "voice_reply_read_failed", message: "暫時無法讀取回答，請查看原對話。" });
      // Revoked access, an ended or expired session: stop the call instead of talking without authority.
      const status = (error as { status?: unknown })?.status;
      if (status === 403 || status === 404) await this.end("session_unavailable");
      return;
    }
    if (!replies.length || this.closed) return;
    if (this.mainAnswerChat) {
      for (const reply of replies) {
        if (!reply.sourceCommentIds?.length) continue;
        this.answerViews.set(reply.commentId, reply);
        this.announceReplyToBrowser(reply);
        if (!this.turns.reply({ ...reply, sourceCommentIds: reply.sourceCommentIds }) && this.unmatchedReplies.size < 256) this.unmatchedReplies.set(reply.commentId, reply);
      }
      this.flushNotices();
      return;
    }
    for (const reply of replies) this.announceReplyToBrowser(reply);
    // Speak one reply per batch: the newest one with an explicit voice summary,
    // otherwise the newest reply. A run-completion copy of the same answer
    // repeats an already spoken summary and stays silent.
    const chosen = [...replies].reverse().find((reply) => reply.voiceSummary) ?? replies[replies.length - 1]!;
    if (this.spokenSummaries.has(chosen.spoken)) return;
    for (const reply of replies) this.spokenSummaries.add(reply.spoken);
    const agent = this.options.binding.agentName;
    this.queueNotice(chosen.voiceSummary
      ? `${NOTICE_PREFIX} ${agent} 回覆了。請用自然口語把下面的語音摘要唸給 Owner 聽，不要增加內容：「${chosen.voiceSummary}」`
      : `${NOTICE_PREFIX} ${agent} 回覆了。請用兩到三句口語摘要下面的內容告訴 Owner，細節請 Owner 看畫面：「${chosen.spoken}」`);
  }

  private announceReplyToBrowser(reply: VoiceAgentReply) {
    this.browser.sendEvent({ type: "agent_reply", commentId: reply.commentId, body: reply.body, voiceSummary: reply.voiceSummary, createdAt: reply.createdAt, ...(this.mainAnswerChat ? { playbackState: "available" as const } : {}) });
  }

  private warnDuration() {
    if (this.closed) return;
    const remainingSeconds = Math.max(0, this.maxSeconds - this.warningSeconds);
    this.browser.sendEvent({ type: "time_warning", remainingSeconds });
    this.queueNotice(`${NOTICE_PREFIX} 通話已經 ${Math.round(this.warningSeconds / 60)} 分鐘，${Math.round(remainingSeconds / 60)} 分鐘後會自動結束。請用一句話提醒 Owner。`);
  }

  /** Emulates WHEN_IDLE scheduling: notices wait until the model finishes speaking. */
  protected queueNotice(text: string, key?: string) {
    this.pendingNotices.push({ text, key });
    this.flushNotices();
  }

  protected flushNotices() {
    if (this.closed || this.modelTurnActive || this.engineBusy() || !this.upstreamReady || this.reconnecting
      || this.mainAnswerChat && (this.browserPlaying || this.pendingTranscriptions() > 0)) return;
    if (this.mainAnswerChat && !this.activeSpeechKey) {
      const speech = this.turns.takeNextSpeech();
      if (speech) {
        this.activeSpeechKey = speech.key;
        if (this.sendUserTurn(this.exactSpeech(speech.text))) this.modelTurnActive = true;
        else this.interruptChatPlayback();
        return;
      }
    }
    let notice = this.pendingNotices.shift();
    while (notice?.key && !this.turns.isNoticeCurrent(notice.key)) notice = this.pendingNotices.shift();
    if (!notice) return;
    if (!this.sendUserTurn(notice.text)) { this.pendingNotices.unshift(notice); return; }
    this.modelTurnActive = true;
  }

  private exactSpeech(text: string) {
    return `${NOTICE_PREFIX} 只逐字唸出以下播報文字，不加前言或結論：${JSON.stringify(text)}`;
  }

  /** Only audio is interrupted; the original Chat run continues. */
  protected interruptChatPlayback() {
    if (!this.mainAnswerChat) return;
    this.turns.interrupt();
    this.activeSpeechKey = null;
    this.pendingNotices.length = 0;
  }

  protected noteChatAudio() {
    if (this.mainAnswerChat && this.activeSpeechKey) this.turns.playbackStarted(this.activeSpeechKey);
  }

  // ---- lifecycle ----------------------------------------------------------

  private ending: Promise<void> | null = null;
  /** The browser socket closed; nothing more can be delivered to it. */
  private browserGone = false;

  end(reason: LocalVoiceRelayEndReason): Promise<void> {
    if (this.closed) return Promise.resolve();
    return this.ending ??= this.endOnce(reason);
  }

  private async endOnce(reason: LocalVoiceRelayEndReason) {
    // agent_chat: the caller's last words still reach the Chat before the call closes.
    if (this.chatMode && !this.browserGone) {
      await this.drainDictation(reason === "upstream_unavailable" ? 0 : this.options.dictationDrainMs ?? DICTATION_DRAIN_MS).catch(() => undefined);
    }
    if (this.closed) return;
    this.closed = true;
    this.turns.dispose();
    for (const timer of this.receiptTimers.values()) this.clearTimer(timer);
    this.receiptTimers.clear();
    for (const timer of this.timers) this.clearTimer(timer);
    if (this.replyTimer !== null) this.clearTimer(this.replyTimer);
    if (this.dictationTimer !== null) { this.clearTimer(this.dictationTimer); this.dictationTimer = null; }
    if (this.routeTimer !== null) { this.clearTimer(this.routeTimer); this.routeTimer = null; }
    this.unwatch?.();
    for (const abort of this.setupAborts) abort(new Error("call ended during upstream setup"));
    this.setupAborts.clear();
    try { this.upstream?.close(); } catch { /* already closed */ }
    this.upstream = null;
    this.log("voice_relay_ended", {
      engine: this.engine,
      model: this.options.model ?? null,
      reason,
      durationSeconds: Math.round((this.now() - this.startedAt) / 1000),
      reconnects: this.reconnects,
      usage: this.usageSnapshot(),
    });
    try { this.browser.sendEvent({ type: "ended", reason }); } catch { /* browser gone */ }
    try { this.browser.close(1000, reason); } catch { /* browser gone */ }
    try { await this.port.end(reason); } catch (error) { this.log("voice_relay_session_end_failed", { engine: this.engine, error: safeError(error) }); }
  }

  get isClosed() { return this.closed; }
  protected snapshotExtras(): Record<string, unknown> { return {}; }
  /** Test and diagnostics view; never contains audio, transcripts or credentials. */
  get snapshot() {
    return { engine: this.engine, closed: this.closed, upstreamReady: this.upstreamReady, reconnecting: this.reconnecting, micPaused: this.micPaused,
      modelTurnActive: this.modelTurnActive, pendingNotices: this.pendingNotices.length,
      dictation: this.chatMode ? { buffered: this.dictationParts.length, pending: this.pendingDictations.size } : null,
      draft: this.draft ? { draftId: this.draft.draftId, revision: this.draft.revision, recited: this.draft.recited, submitted: this.draft.result?.status === "accepted" } : null,
      usage: this.usageSnapshot(), ...this.snapshotExtras() };
  }
}

/** Join caller utterances: Chinese runs together, Latin words keep a space. */
export function joinDictation(parts: string[]) {
  let result = "";
  for (const raw of parts) {
    const part = raw.trim();
    if (!part) continue;
    if (result && /[A-Za-z0-9]$/.test(result) && /^[A-Za-z0-9]/.test(part)) result += " ";
    result += part;
  }
  return result;
}

export function numberOr0(value: unknown) { return typeof value === "number" && Number.isFinite(value) ? value : 0; }
export function safeError(error: unknown) { return error instanceof Error ? error.message.slice(0, 200) : typeof error; }
function withTimeout<T>(promise: Promise<T>, ms: number) {
  let handle: ReturnType<typeof setTimeout> | undefined;
  return Promise.race([
    promise,
    new Promise<never>((_, reject) => { handle = setTimeout(() => reject(new Error("upstream setup timed out")), ms); }),
  ]).finally(() => { if (handle) clearTimeout(handle); });
}
