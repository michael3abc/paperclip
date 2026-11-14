import { randomUUID } from "node:crypto";
import {
  LOCAL_VOICE_CALL_MAX_SECONDS,
  LOCAL_VOICE_CALL_WARNING_SECONDS,
  LOCAL_VOICE_CONFIRMATION_PHRASE,
  LOCAL_VOICE_INPUT_SAMPLE_RATE,
  type LocalVoiceDraft,
  type LocalVoiceRelayClientMessage,
  type LocalVoiceRelayEndReason,
  type LocalVoiceRelayServerEvent,
} from "@paperclipai/shared";
import { containsConfirmationPhrase } from "./voice-summary.js";

/**
 * Gemini Live relay for one local voice call (HOM-311).
 *
 * The browser talks only to Paperclip; this relay owns the upstream model
 * connection, its gateway key, every tool call and the spoken-confirmation
 * check. Compass/Vertex rejects `behavior: NON_BLOCKING`, so every tool returns
 * immediately and later agent replies arrive as new `clientContent` turns.
 */

export interface VoiceRelayBrowser {
  sendEvent(event: LocalVoiceRelayServerEvent): void;
  sendAudio(pcm24k: Buffer): void;
  close(code: number, reason: string): void;
}

/** One upstream Live API WebSocket. Implementations must not log frames or headers. */
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
  submit(draft: LocalVoiceDraft & { operationId: string }): Promise<VoiceSubmitResult>;
  /** Agent replies on the voice task not returned before (oldest first). */
  newReplies(): Promise<VoiceAgentReply[]>;
  /** Wake the relay when the voice task may have new replies. Returns an unsubscribe. */
  watch(onChange: () => void): () => void;
  /** End the persisted voice session. */
  end(reason: LocalVoiceRelayEndReason): Promise<void>;
}

export interface VoiceRelayOptions {
  browser: VoiceRelayBrowser;
  port: VoiceTaskPort;
  connectUpstream: VoiceUpstreamFactory;
  binding: { issueId: string; issueIdentifier: string | null; issueTitle: string; agentName: string };
  voiceName?: string;
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
}

interface DraftState extends LocalVoiceDraft {
  operationId: string;
  /** The model finished (or was interrupted during) the turn that recited the draft. */
  recited: boolean;
  /** Caller speech transcribed after the recitation turn ended. */
  heardAfterRecital: string;
  uiConfirmed: boolean;
  submitting?: Promise<VoiceSubmitResult>;
  result?: VoiceSubmitResult;
}

const NOTICE_PREFIX = "[Paperclip 通知]";
const MAX_DRAFT_CHARS = 4000;
const MAX_BUFFERED_AUDIO_FRAMES = 50;

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

export function voiceSystemInstruction(binding: VoiceRelayOptions["binding"]) {
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
    `以「${NOTICE_PREFIX}」開頭的文字是系統通知，不是 Owner 說的話，也不能當作確認口令。照通知要求簡短播報即可。`,
    "Owner 問有沒有新消息時呼叫 get_updates。",
  ].join("\n");
}

export class GeminiLiveRelay {
  private readonly browser: VoiceRelayBrowser;
  private readonly port: VoiceTaskPort;
  private readonly now: () => number;
  private readonly setTimer: (fn: () => void, ms: number) => unknown;
  private readonly clearTimer: (handle: unknown) => void;
  private readonly log: (event: string, fields?: Record<string, unknown>) => void;
  private readonly startedAt: number;
  private readonly maxSeconds: number;
  private readonly warningSeconds: number;
  private upstream: VoiceUpstream | null = null;
  private upstreamReady = false;
  private readyAnnounced = false;
  private resumeHandle: string | null = null;
  private reconnecting = false;
  private closed = false;
  private micPaused = false;
  private modelTurnActive = false;
  private draft: DraftState | null = null;
  private readonly pendingNotices: string[] = [];
  private readonly bufferedAudio: Buffer[] = [];
  private readonly spokenSummaries = new Set<string>();
  private readonly timers: unknown[] = [];
  private replyTimer: unknown = null;
  private unwatch: (() => void) | null = null;
  private usage = { promptTokens: 0, responseTokens: 0, totalTokens: 0, messages: 0 };
  private reconnects = 0;

  constructor(private readonly options: VoiceRelayOptions) {
    this.browser = options.browser;
    this.port = options.port;
    this.now = options.now ?? Date.now;
    this.setTimer = options.setTimer ?? ((fn, ms) => setTimeout(fn, ms));
    this.clearTimer = options.clearTimer ?? ((handle) => clearTimeout(handle as ReturnType<typeof setTimeout>));
    this.log = options.log ?? (() => undefined);
    this.startedAt = this.now();
    this.maxSeconds = options.maxSeconds ?? LOCAL_VOICE_CALL_MAX_SECONDS;
    this.warningSeconds = options.warningSeconds ?? LOCAL_VOICE_CALL_WARNING_SECONDS;
  }

  async start() {
    this.timers.push(this.setTimer(() => this.warnDuration(), this.warningSeconds * 1000));
    this.timers.push(this.setTimer(() => void this.end("max_duration"), this.maxSeconds * 1000));
    this.unwatch = this.port.watch(() => this.scheduleReplyCheck());
    try {
      this.upstream = await this.openUpstream();
    } catch (error) {
      this.log("voice_relay_upstream_failed", { error: safeError(error) });
      await this.end("upstream_unavailable");
    }
  }

  // ---- browser side -------------------------------------------------------

  handleBrowserAudio(pcm16k: Buffer) {
    if (this.closed || this.micPaused || pcm16k.length === 0 || pcm16k.length % 2 !== 0) return;
    if (!this.upstreamReady || this.reconnecting) {
      this.bufferedAudio.push(pcm16k);
      if (this.bufferedAudio.length > MAX_BUFFERED_AUDIO_FRAMES) this.bufferedAudio.shift();
      return;
    }
    this.sendAudio(pcm16k);
  }

  async handleBrowserMessage(message: LocalVoiceRelayClientMessage) {
    if (this.closed) return;
    switch (message.type) {
      case "text":
        this.sendUpstream({ clientContent: { turns: [{ role: "user", parts: [{ text: message.text }] }], turnComplete: true } });
        return;
      case "mic":
        this.micPaused = message.state === "paused";
        if (this.micPaused) {
          this.bufferedAudio.length = 0;
          this.sendUpstream({ realtimeInput: { audioStreamEnd: true } });
        }
        return;
      case "confirm_draft": {
        const draft = this.draft;
        if (!draft || draft.draftId !== message.draftId || draft.revision !== message.revision) {
          this.browser.sendEvent({ type: "submit_failed", draftId: message.draftId, code: "voice_draft_stale", message: "這份草稿已經更新或不存在" });
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
        if (this.draft?.draftId === message.draftId && !this.draft.result) {
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

  handleBrowserClosed() {
    void this.end("caller_ended");
  }

  // ---- upstream side ------------------------------------------------------

  private async openUpstream(): Promise<VoiceUpstream> {
    const connection: { socket: VoiceUpstream | null; retired: boolean } = { socket: null, retired: false };
    const setupDone = new Promise<void>((resolve, reject) => {
      const handlers: VoiceUpstreamHandlers = {
        onMessage: (json) => {
          if (connection.retired || this.closed) return;
          let message: Record<string, any>;
          try { message = JSON.parse(json); } catch { return; }
          if (message.setupComplete) resolve();
          this.handleUpstreamMessage(message);
        },
        onClose: (code, reason) => {
          reject(new Error(`upstream closed ${code}`));
          if (!connection.retired && connection.socket !== null && connection.socket === this.upstream) this.handleUpstreamClosed(code, reason);
        },
      };
      this.options.connectUpstream(handlers).then((socket) => {
        connection.socket = socket;
        socket.send(JSON.stringify({ setup: this.setupMessage() }));
      }, reject);
    });
    try {
      await withTimeout(setupDone, 15_000);
    } catch (error) {
      connection.retired = true;
      try { connection.socket?.close(); } catch { /* already closed */ }
      throw error;
    }
    this.retireCurrent = () => { connection.retired = true; };
    return connection.socket!;
  }
  private retireCurrent: (() => void) | null = null;

  private setupMessage() {
    return {
      responseModalities: ["AUDIO"],
      speechConfig: { voiceConfig: { prebuiltVoiceConfig: { voiceName: this.options.voiceName ?? "Kore" } } },
      systemInstruction: { parts: [{ text: voiceSystemInstruction(this.options.binding) }] },
      tools: [{ functionDeclarations: voiceToolDeclarations(this.options.binding.agentName) }],
      inputAudioTranscription: {},
      outputAudioTranscription: {},
      sessionResumption: this.resumeHandle ? { handle: this.resumeHandle } : {},
      contextWindowCompression: { slidingWindow: {} },
    };
  }

  private handleUpstreamMessage(message: Record<string, any>) {
    if (message.setupComplete) {
      this.upstreamReady = true;
      if (!this.readyAnnounced) {
        this.readyAnnounced = true;
        const { issueId, issueIdentifier, agentName } = this.options.binding;
        this.browser.sendEvent({ type: "ready", issueId, issueIdentifier, agentName, maxSeconds: this.maxSeconds, warningSeconds: this.warningSeconds });
      }
      return;
    }
    if (message.sessionResumptionUpdate) {
      const update = message.sessionResumptionUpdate;
      if (update.resumable !== false && typeof update.newHandle === "string" && update.newHandle) this.resumeHandle = update.newHandle;
    }
    if (message.goAway) {
      this.log("voice_relay_go_away", { timeLeft: message.goAway.timeLeft ?? null });
      void this.reconnect("go_away");
    }
    if (message.usageMetadata) this.recordUsage(message.usageMetadata);
    if (message.toolCall?.functionCalls) {
      for (const call of message.toolCall.functionCalls) void this.handleToolCall(call);
    }
    const content = message.serverContent;
    if (!content) return;
    for (const part of content.modelTurn?.parts ?? []) {
      const data = part?.inlineData;
      if (typeof data?.data === "string" && String(data.mimeType ?? "").startsWith("audio/pcm")) {
        this.modelTurnActive = true;
        this.browser.sendAudio(Buffer.from(data.data, "base64"));
      }
    }
    if (typeof content.inputTranscription?.text === "string" && content.inputTranscription.text) {
      const text = content.inputTranscription.text;
      this.browser.sendEvent({ type: "transcript", role: "user", text });
      if (this.draft?.recited) this.draft.heardAfterRecital += text;
    }
    if (typeof content.outputTranscription?.text === "string" && content.outputTranscription.text) {
      this.browser.sendEvent({ type: "transcript", role: "model", text: content.outputTranscription.text });
    }
    if (content.interrupted) {
      this.browser.sendEvent({ type: "interrupted" });
      this.finishModelTurn();
    }
    if (content.turnComplete) {
      this.browser.sendEvent({ type: "turn_complete" });
      this.finishModelTurn();
    }
  }

  private finishModelTurn() {
    this.modelTurnActive = false;
    if (this.draft && !this.draft.recited && this.draft.result === undefined) this.draft.recited = true;
    this.flushNotices();
  }

  private handleUpstreamClosed(code: number, reason: string) {
    this.upstreamReady = false;
    if (this.closed) return;
    this.log("voice_relay_upstream_closed", { code, reason: reason.slice(0, 120) });
    void this.reconnect(`closed_${code}`);
  }

  private async reconnect(reason: string) {
    if (this.closed || this.reconnecting) return;
    this.reconnecting = true;
    this.reconnects += 1;
    this.browser.sendEvent({ type: "reconnecting", reason });
    const previous = this.upstream;
    const retirePrevious = this.retireCurrent;
    const hadHandle = this.resumeHandle !== null;
    const delays = this.options.reconnectDelaysMs ?? [0, 500, 1500, 4000];
    for (const delay of delays) {
      if (this.closed) return;
      if (delay > 0) await new Promise<void>((resolve) => this.setTimer(resolve, delay));
      try {
        const next = await this.openUpstream();
        this.upstream = next;
        // Retire the previous connection only after the new one is ready.
        retirePrevious?.();
        if (previous && previous !== next) { try { previous.close(); } catch { /* already closed */ } }
        this.reconnecting = false;
        this.upstreamReady = true;
        this.modelTurnActive = false;
        const contextKept = hadHandle && this.resumeHandle !== null;
        this.browser.sendEvent({ type: "resumed", contextKept });
        for (const frame of this.bufferedAudio.splice(0)) this.sendAudio(frame);
        if (!contextKept) this.queueNotice(`${NOTICE_PREFIX} 語音連線剛重新建立，先前的對話內容可能遺失。請用一句話請 Owner 繼續說。`);
        this.flushNotices();
        return;
      } catch (error) {
        this.log("voice_relay_reconnect_failed", { error: safeError(error) });
        // A stale handle must not block a fresh session on the next attempt.
        this.resumeHandle = null;
      }
    }
    this.reconnecting = false;
    await this.end("upstream_unavailable");
  }

  private sendAudio(pcm16k: Buffer) {
    this.sendUpstream({ realtimeInput: { audio: { mimeType: `audio/pcm;rate=${LOCAL_VOICE_INPUT_SAMPLE_RATE}`, data: pcm16k.toString("base64") } } });
  }

  private sendUpstream(message: Record<string, unknown>) {
    if (!this.upstream || !this.upstreamReady || this.closed) return false;
    try { this.upstream.send(JSON.stringify(message)); return true; } catch { return false; }
  }

  private recordUsage(usage: Record<string, unknown>) {
    this.usage.messages += 1;
    this.usage.promptTokens += numberOr0(usage.promptTokenCount);
    this.usage.responseTokens += numberOr0(usage.responseTokenCount);
    this.usage.totalTokens += numberOr0(usage.totalTokenCount);
  }

  // ---- tools --------------------------------------------------------------

  private async handleToolCall(call: { id?: string; name?: string; args?: Record<string, unknown> }) {
    const name = String(call.name ?? "");
    let response: Record<string, unknown>;
    try {
      response = await this.runTool(name, call.args ?? {});
    } catch (error) {
      this.log("voice_relay_tool_failed", { tool: name, error: safeError(error) });
      response = { status: "error", message: "Paperclip 暫時無法完成這個動作" };
    }
    this.sendUpstream({ toolResponse: { functionResponses: [{ id: call.id, name, response }] } });
  }

  private async runTool(name: string, args: Record<string, unknown>): Promise<Record<string, unknown>> {
    switch (name) {
      case "query_task_status": {
        const identifier = typeof args.identifier === "string" && args.identifier.trim() ? args.identifier.trim() : undefined;
        return this.port.status(identifier);
      }
      case "prepare_request": return this.prepareDraft(String(args.text ?? ""));
      case "submit_request": return this.submitFromModel(String(args.draftId ?? ""));
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

  private prepareDraft(raw: string): Record<string, unknown> {
    const text = raw.trim();
    if (!text) return { status: "error", message: "草稿內容是空的" };
    if (Array.from(text).length > MAX_DRAFT_CHARS) return { status: "error", message: `草稿太長，請精簡到 ${MAX_DRAFT_CHARS} 字以內` };
    const current = this.draft && !this.draft.result ? this.draft : null;
    this.draft = {
      draftId: current?.draftId ?? randomUUID(),
      revision: (current?.revision ?? 0) + 1,
      text,
      operationId: randomUUID(),
      recited: false,
      heardAfterRecital: "",
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
    const check = () => draft.recited && containsConfirmationPhrase(draft.heardAfterRecital, LOCAL_VOICE_CONFIRMATION_PHRASE);
    if (check()) return true;
    const grace = this.options.transcriptGraceMs ?? 1500;
    if (grace <= 0) return false;
    await new Promise<void>((resolve) => this.setTimer(resolve, grace));
    return this.draft === draft && check();
  }

  private submitDraft(draft: DraftState, via: "spoken" | "ui"): Promise<VoiceSubmitResult> {
    if (draft.result?.status === "accepted") return Promise.resolve(draft.result);
    if (draft.submitting) return draft.submitting;
    draft.submitting = (async () => {
      let result: VoiceSubmitResult;
      try {
        result = await this.port.submit({ draftId: draft.draftId, revision: draft.revision, text: draft.text, operationId: draft.operationId });
      } catch (error) {
        result = { status: "failed", operationId: draft.operationId, code: "submit_unknown", message: "送出結果不明，請在畫面上查看任務留言" };
        this.log("voice_relay_submit_unknown", { error: safeError(error) });
      }
      draft.submitting = undefined;
      if (result.status === "accepted") {
        draft.result = result;
        this.browser.sendEvent({ type: "submitted", draftId: draft.draftId, revision: draft.revision, operationId: result.operationId, via });
      } else {
        // Keep the same operation id: a retry of an unknown outcome must stay idempotent.
        this.browser.sendEvent({ type: "submit_failed", draftId: draft.draftId, code: result.code ?? "submit_failed", message: result.message ?? "送出失敗" });
      }
      return result;
    })();
    return draft.submitting;
  }

  // ---- agent replies and notices -----------------------------------------

  private scheduleReplyCheck() {
    if (this.closed) return;
    if (this.replyTimer !== null) this.clearTimer(this.replyTimer);
    this.replyTimer = this.setTimer(() => { this.replyTimer = null; void this.checkReplies(); }, this.options.replyDebounceMs ?? 3000);
  }

  private async checkReplies() {
    if (this.closed) return;
    let replies: VoiceAgentReply[];
    try { replies = await this.port.newReplies(); } catch (error) {
      this.log("voice_relay_reply_check_failed", { error: safeError(error) });
      // Revoked access, an ended or expired session: stop the call instead of talking without authority.
      const status = (error as { status?: unknown })?.status;
      if (status === 403 || status === 404) await this.end("session_unavailable");
      return;
    }
    if (!replies.length) return;
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
    this.browser.sendEvent({ type: "agent_reply", commentId: reply.commentId, body: reply.body, voiceSummary: reply.voiceSummary, createdAt: reply.createdAt });
  }

  private warnDuration() {
    if (this.closed) return;
    const remainingSeconds = Math.max(0, this.maxSeconds - this.warningSeconds);
    this.browser.sendEvent({ type: "time_warning", remainingSeconds });
    this.queueNotice(`${NOTICE_PREFIX} 通話已經 ${Math.round(this.warningSeconds / 60)} 分鐘，${Math.round(remainingSeconds / 60)} 分鐘後會自動結束。請用一句話提醒 Owner。`);
  }

  /** Emulates WHEN_IDLE scheduling: notices wait until the model finishes speaking. */
  private queueNotice(text: string) {
    this.pendingNotices.push(text);
    this.flushNotices();
  }

  private flushNotices() {
    if (this.modelTurnActive || !this.upstreamReady || this.reconnecting) return;
    const text = this.pendingNotices.shift();
    if (!text) return;
    if (!this.sendUpstream({ clientContent: { turns: [{ role: "user", parts: [{ text }] }], turnComplete: true } })) {
      this.pendingNotices.unshift(text);
      return;
    }
    this.modelTurnActive = true;
  }

  // ---- lifecycle ----------------------------------------------------------

  async end(reason: LocalVoiceRelayEndReason) {
    if (this.closed) return;
    this.closed = true;
    for (const timer of this.timers) this.clearTimer(timer);
    if (this.replyTimer !== null) this.clearTimer(this.replyTimer);
    this.unwatch?.();
    try { this.upstream?.close(); } catch { /* already closed */ }
    this.upstream = null;
    this.log("voice_relay_ended", {
      reason,
      durationSeconds: Math.round((this.now() - this.startedAt) / 1000),
      reconnects: this.reconnects,
      usage: this.usage,
    });
    try { this.browser.sendEvent({ type: "ended", reason }); } catch { /* browser gone */ }
    try { this.browser.close(1000, reason); } catch { /* browser gone */ }
    try { await this.port.end(reason); } catch (error) { this.log("voice_relay_session_end_failed", { error: safeError(error) }); }
  }

  get isClosed() { return this.closed; }
  /** Test and diagnostics view; never contains audio, transcripts or credentials. */
  get snapshot() {
    return { closed: this.closed, upstreamReady: this.upstreamReady, reconnecting: this.reconnecting, micPaused: this.micPaused,
      modelTurnActive: this.modelTurnActive, hasResumeHandle: this.resumeHandle !== null, pendingNotices: this.pendingNotices.length,
      draft: this.draft ? { draftId: this.draft.draftId, revision: this.draft.revision, recited: this.draft.recited, submitted: this.draft.result?.status === "accepted" } : null,
      usage: { ...this.usage } };
  }
}

function numberOr0(value: unknown) { return typeof value === "number" && Number.isFinite(value) ? value : 0; }
function safeError(error: unknown) { return error instanceof Error ? error.message.slice(0, 200) : typeof error; }
function withTimeout<T>(promise: Promise<T>, ms: number) {
  let handle: ReturnType<typeof setTimeout> | undefined;
  return Promise.race([
    promise,
    new Promise<never>((_, reject) => { handle = setTimeout(() => reject(new Error("upstream setup timed out")), ms); }),
  ]).finally(() => { if (handle) clearTimeout(handle); });
}
