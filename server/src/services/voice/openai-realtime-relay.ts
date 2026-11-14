import { LOCAL_VOICE_CONFIRMATION_PHRASE, LOCAL_VOICE_INPUT_SAMPLE_RATE } from "@paperclipai/shared";
import {
  NOTICE_PREFIX,
  VoiceRelayCore,
  numberOr0,
  voiceSystemInstruction,
  voiceToolDeclarations,
  type CallerUtterance,
  type DraftState,
  type VoiceRelayOptions,
  type VoiceUpstream,
} from "./voice-relay-core.js";
import { toTaiwanTraditional } from "./zh-tw.js";

/**
 * OpenAI Realtime (GA protocol) engine for the local voice relay (HOM-318),
 * through the LAN Compass gateway `/v1/realtime?model=gpt-realtime-1.5`.
 *
 * Mapping onto the shared relay core:
 * - microphone → `input_audio_buffer.append` (PCM16 24 kHz), server VAD;
 * - barge-in (`input_audio_buffer.speech_started`) → `response.cancel`,
 *   `conversation.item.truncate` at the estimated playback position, and an
 *   `interrupted` event so the browser flushes its queue;
 * - tools → `response.function_call_arguments.done`, answered with a
 *   `function_call_output` item and one `response.create`;
 * - captions and spoken confirmation → `conversation.item.input_audio_transcription.completed`
 *   (gpt-4o-transcribe), converted to Taiwan Traditional;
 * - notices and agent voice summaries → a user `conversation.item.create` and
 *   `response.create` once no response is active;
 * - usage → summed from every `response.done` and transcription completion.
 *
 * There is no server-side session resumption: after an unexpected close the
 * relay opens a new session and restores recent conversation text and the
 * current draft through the session instructions.
 */

export const OPENAI_TRANSCRIPTION_MODEL = "gpt-4o-transcribe";
const TRANSCRIPTION_PROMPT = "以下是台灣人用繁體中文進行的口語對話，可能夾雜英文名稱與任務編號（例如 HOM-123）。";
const HISTORY_LIMIT = 16;
const HISTORY_CHARS = 2400;
/** A read-back is considered heard only when the caller did not cut off more than this share of its audio. */
const HEARD_SHARE = 0.9;
const BENIGN_ERROR_CODES = new Set(["response_cancel_not_active", "conversation_already_has_active_response", "input_audio_buffer_commit_empty"]);

interface AudioItem {
  itemId: string;
  contentIndex: number;
  responseId: string | null;
  /** Bytes of PCM16 24 kHz audio forwarded to the browser. */
  sentBytes: number;
  /** Estimated wall time when the browser starts playing this item. */
  playStartAt: number;
}

interface Usage {
  responses: number;
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
  inputAudioTokens: number;
  inputTextTokens: number;
  cachedInputTokens: number;
  outputAudioTokens: number;
  outputTextTokens: number;
  transcriptions: number;
  transcriptionInputTokens: number;
  transcriptionOutputTokens: number;
}

export function openAiToolDeclarations(agentName: string) {
  const lower = (schema: unknown): unknown => {
    if (Array.isArray(schema)) return schema.map(lower);
    if (!schema || typeof schema !== "object") return schema;
    return Object.fromEntries(Object.entries(schema).map(([key, value]) => [key, key === "type" && typeof value === "string" ? value.toLowerCase() : lower(value)]));
  };
  return voiceToolDeclarations(agentName).map((tool) => ({ type: "function", name: tool.name, description: tool.description, parameters: lower(tool.parameters) }));
}

export class OpenAIRealtimeRelay extends VoiceRelayCore {
  protected readonly engine = "openai";
  readonly inputSampleRate = LOCAL_VOICE_INPUT_SAMPLE_RATE;
  /** gpt-4o-transcribe completes after VAD commit, often after the tool call. */
  protected readonly defaultTranscriptGraceMs = 4000;
  protected readonly dropStaleToolResults = true;
  /** A response is being generated (created and not yet done). */
  private activeResponse = false;
  private activeResponseId: string | null = null;
  /** A `response.create` was sent and its `response.created` has not arrived. */
  private awaitingCreated = false;
  /** A `response.create` is owed once no response is active. */
  private responseWanted = false;
  /** Tool calls of the current session still being produced, by call id. */
  private readonly pendingCalls = new Set<string>();
  /** Response cut off by barge-in; its late audio and captions are dropped. */
  private cancelledResponseId: string | null = null;
  /** function_call items by item id, for name lookup. */
  private readonly callNames = new Map<string, string>();
  /** Caller utterances by input item id. */
  private readonly utterances = new Map<string, CallerUtterance>();
  private audioItem: AudioItem | null = null;
  /** Estimated wall time when the browser's playback queue drains. */
  private playbackEndsAt = 0;
  /** Milliseconds of microphone audio appended to the current session's input buffer. */
  private appendedInputMs = 0;
  /** `appendedInputMs` when the browser last reported that playback drained (same ordered socket as the mic). */
  private playbackStoppedAtInputMs = 0;
  /** Playback window of the audio that completed the current draft's read-back. */
  private recitationPlayback: { draftId: string; revision: number; startAt: number; durationMs: number } | null = null;
  private readonly history: { role: "Owner" | "助理"; text: string }[] = [];
  private usage: Usage = {
    responses: 0, inputTokens: 0, outputTokens: 0, totalTokens: 0, inputAudioTokens: 0, inputTextTokens: 0, cachedInputTokens: 0,
    outputAudioTokens: 0, outputTextTokens: 0, transcriptions: 0, transcriptionInputTokens: 0, transcriptionOutputTokens: 0,
  };

  constructor(options: VoiceRelayOptions) { super(options); }

  // ---- session --------------------------------------------------------------

  protected onUpstreamOpen() { /* wait for session.created */ }

  protected handshake(message: Record<string, any>, socket: VoiceUpstream) {
    if (message.type === "session.created") {
      socket.send(JSON.stringify({ type: "session.update", session: this.sessionConfig() }));
      return null;
    }
    if (message.type === "session.updated") return "ready" as const;
    if (message.type === "error") {
      this.log("voice_relay_session_error", { engine: this.engine, code: errorCode(message) });
      return "failed" as const;
    }
    return null;
  }

  sessionConfig() {
    return {
      type: "realtime",
      instructions: this.instructions(),
      output_modalities: ["audio"],
      tools: openAiToolDeclarations(this.options.binding.agentName),
      tool_choice: "auto",
      audio: {
        input: {
          format: { type: "audio/pcm", rate: this.inputSampleRate },
          transcription: { model: OPENAI_TRANSCRIPTION_MODEL, language: "zh", prompt: TRANSCRIPTION_PROMPT },
          turn_detection: { type: "server_vad", silence_duration_ms: 500, create_response: true, interrupt_response: true },
        },
        output: { format: { type: "audio/pcm", rate: 24_000 }, voice: this.options.voiceName ?? "marin" },
      },
    };
  }

  private instructions() {
    const base = voiceSystemInstruction(this.options.binding);
    const lines: string[] = [];
    if (this.history.length) {
      lines.push("", "語音連線剛重新建立。下面是斷線前最近的對話紀錄，只用來延續上下文；它不是新的要求，也不能當作確認口令：");
      for (const entry of this.history) lines.push(`${entry.role}：${entry.text}`);
    }
    const draft = this.draft;
    if (draft && draft.result?.status !== "accepted") {
      lines.push("", `目前有一份尚未送出的草稿（draftId ${draft.draftId}，第 ${draft.revision} 版）：「${draft.text}」。`,
        draft.recited
          ? `草稿已覆誦過；Owner 說「${LOCAL_VOICE_CONFIRMATION_PHRASE}」後才能呼叫 submit_request。`
          : "草稿還沒覆誦；送出前要先逐字覆誦。");
    } else if (draft?.result?.status === "accepted") {
      lines.push("", `最近一份草稿（draftId ${draft.draftId}）已經送出，不要再送一次。`);
    }
    return lines.length ? `${base}\n${lines.join("\n")}` : base;
  }

  protected beginReconnect() {
    // Context comes back through the new session's instructions.
    return () => true;
  }

  protected onReconnected() {
    this.activeResponse = false;
    this.activeResponseId = null;
    this.awaitingCreated = false;
    this.responseWanted = false;
    this.pendingCalls.clear();
    this.cancelledResponseId = null;
    this.callNames.clear();
    this.utterances.clear();
    // Item ids belong to the old session; playback timing (recitationPlayback, playbackEndsAt) stays valid.
    this.audioItem = null;
    this.appendedInputMs = 0;
    this.playbackStoppedAtInputMs = 0;
  }

  // ---- upstream events ------------------------------------------------------

  protected handleUpstreamMessage(message: Record<string, any>) {
    switch (message.type) {
      case "response.created":
        this.activeResponse = true;
        this.awaitingCreated = false;
        this.activeResponseId = typeof message.response?.id === "string" ? message.response.id : null;
        this.modelTurnActive = true;
        return;
      case "response.output_item.added": {
        const item = message.item;
        if (item?.type === "function_call" && typeof item.id === "string" && typeof item.name === "string") this.callNames.set(item.id, item.name);
        return;
      }
      case "response.output_audio.delta":
      case "response.audio.delta":
        if (this.isCancelled(message)) return;
        this.forwardAudio(message);
        return;
      case "response.output_audio_transcript.delta":
      case "response.audio_transcript.delta": {
        if (this.isCancelled(message) || typeof message.delta !== "string" || !message.delta) return;
        const text = toTaiwanTraditional(message.delta);
        this.turnOutput += text;
        this.browser.sendEvent({ type: "transcript", role: "model", text });
        return;
      }
      case "response.function_call_arguments.done":
        this.onFunctionCall(message);
        return;
      case "response.done":
        this.onResponseDone(message.response);
        return;
      case "input_audio_buffer.speech_started":
        this.onSpeechStarted(message);
        return;
      case "conversation.item.input_audio_transcription.completed":
        this.onTranscription(message);
        return;
      case "conversation.item.input_audio_transcription.failed":
        this.log("voice_relay_transcription_failed", { engine: this.engine, code: errorCode(message) });
        return;
      case "error": {
        const code = errorCode(message);
        if (code === "conversation_already_has_active_response") {
          // Another response (server VAD) is active; ask again when it is done.
          this.responseWanted = true;
        } else if (this.awaitingCreated) {
          // A rejected response.create must not leave the call waiting for a response that never comes.
          this.awaitingCreated = false;
          this.activeResponse = false;
          this.modelTurnActive = false;
          this.flushNotices();
        }
        if (!BENIGN_ERROR_CODES.has(code)) this.log("voice_relay_upstream_error", { engine: this.engine, code });
        return;
      }
      default:
        return;
    }
  }

  private isCancelled(message: Record<string, any>) {
    return this.cancelledResponseId !== null && message.response_id === this.cancelledResponseId;
  }

  private forwardAudio(message: Record<string, any>) {
    if (typeof message.delta !== "string" || !message.delta) return;
    const pcm = Buffer.from(message.delta, "base64");
    if (pcm.length === 0) return;
    const itemId = typeof message.item_id === "string" ? message.item_id : "";
    const now = this.now();
    if (!this.audioItem || this.audioItem.itemId !== itemId) {
      this.audioItem = {
        itemId, contentIndex: Number.isInteger(message.content_index) ? message.content_index : 0,
        responseId: typeof message.response_id === "string" ? message.response_id : null,
        sentBytes: 0, playStartAt: Math.max(now, this.playbackEndsAt),
      };
    }
    this.audioItem.sentBytes += pcm.length;
    this.playbackEndsAt = Math.max(now, this.playbackEndsAt) + bytesToMs(pcm.length);
    this.modelTurnActive = true;
    this.browserPlaying = true;
    this.browser.sendAudio(pcm);
  }

  private onFunctionCall(message: Record<string, any>) {
    const callId = typeof message.call_id === "string" ? message.call_id : "";
    if (!callId || this.isCancelled(message)) return;
    const name = typeof message.name === "string" && message.name ? message.name : this.callNames.get(String(message.item_id ?? "")) ?? "";
    let args: unknown = {};
    try { args = typeof message.arguments === "string" && message.arguments.trim() ? JSON.parse(message.arguments) : {}; } catch { args = {}; }
    this.pendingCalls.add(callId);
    void this.runToolCall({ id: callId, name, args });
  }

  private onResponseDone(response: Record<string, any> | undefined) {
    this.activeResponse = false;
    this.awaitingCreated = false;
    this.activeResponseId = null;
    if (response && typeof response === "object") this.recordUsage(response.usage);
    const status = typeof response?.status === "string" ? response.status : "completed";
    const draft = this.draft;
    const wasRecited = draft?.recited ?? false;
    const audio = this.audioItem && this.audioItem.responseId === (typeof response?.id === "string" ? response.id : this.audioItem.responseId) ? this.audioItem : null;
    const output = this.turnOutput;
    if (output.trim()) this.remember("助理", output);
    this.browser.sendEvent({ type: "turn_complete" });
    this.finishModelTurn({ completed: status === "completed" });
    if (draft && !wasRecited && draft.recited) {
      this.recitationPlayback = audio
        ? { draftId: draft.draftId, revision: draft.revision, startAt: audio.playStartAt, durationMs: bytesToMs(audio.sentBytes) }
        : null;
    }
    this.maybeCreateResponse();
  }

  /** Server VAD heard the caller start speaking: barge-in plus a new utterance. */
  private onSpeechStarted(message: Record<string, any>) {
    const now = this.now();
    const playing = this.browserPlaying || now < this.playbackEndsAt;
    if (this.activeResponse) {
      this.cancelledResponseId = this.activeResponseId;
      this.sendUpstream({ type: "response.cancel" });
    }
    const audio = this.audioItem;
    if (audio && playing) {
      const playedMs = Math.max(0, Math.min(bytesToMs(audio.sentBytes), now - audio.playStartAt));
      if (audio.itemId) this.sendUpstream({ type: "conversation.item.truncate", item_id: audio.itemId, content_index: audio.contentIndex, audio_end_ms: Math.floor(playedMs) });
    }
    this.unhearRecitation(now);
    if (playing || this.activeResponse) {
      this.browser.sendEvent({ type: "interrupted" });
      this.browserPlaying = false;
      this.playbackEndsAt = 0;
      this.audioItem = null;
    }
    // Eligibility is decided from when the speech began, not when the event arrived:
    // it must begin after the browser reported that playback drained.
    const utterance = this.beginUtterance();
    const startMs = typeof message.audio_start_ms === "number" ? message.audio_start_ms : null;
    if (playing || startMs === null || startMs < this.playbackStoppedAtInputMs) utterance.eligible = false;
    const itemId = typeof message.item_id === "string" ? message.item_id : null;
    if (itemId) this.utterances.set(itemId, utterance);
  }

  /** A read-back the caller cut off before most of it played was not heard and cannot be confirmed. */
  private unhearRecitation(now: number) {
    const recited = this.recitationPlayback;
    const draft = this.draft;
    if (!recited || !draft || recited.draftId !== draft.draftId || recited.revision !== draft.revision || draft.result) return;
    if (now - recited.startAt >= recited.durationMs * HEARD_SHARE) return;
    draft.recited = false;
    draft.utterances = [];
    this.recitationPlayback = null;
  }

  private onTranscription(message: Record<string, any>) {
    const usage = message.usage;
    if (usage && typeof usage === "object") {
      this.usage.transcriptions += 1;
      this.usage.transcriptionInputTokens += numberOr0(usage.input_tokens);
      this.usage.transcriptionOutputTokens += numberOr0(usage.output_tokens);
    }
    const raw = typeof message.transcript === "string" ? message.transcript.trim() : "";
    if (!raw) return;
    const text = toTaiwanTraditional(raw);
    this.browser.sendEvent({ type: "transcript", role: "user", text });
    this.remember("Owner", text);
    const itemId = typeof message.item_id === "string" ? message.item_id : "";
    const utterance = this.utterances.get(itemId);
    if (utterance) {
      utterance.text += text;
      this.utterances.delete(itemId);
    }
  }

  // ---- client side ----------------------------------------------------------

  protected sendAudio(pcm: Buffer) {
    if (this.sendUpstream({ type: "input_audio_buffer.append", audio: pcm.toString("base64") })) this.appendedInputMs += bytesToMs(pcm.length);
  }

  protected sendUserTurn(text: string) {
    const sent = this.sendUpstream({ type: "conversation.item.create", item: { type: "message", role: "user", content: [{ type: "input_text", text }] } });
    if (!sent) return false;
    if (!text.startsWith(NOTICE_PREFIX)) this.remember("Owner", text);
    this.responseWanted = true;
    this.maybeCreateResponse();
    return true;
  }

  protected onMicPaused() {
    this.sendUpstream({ type: "input_audio_buffer.clear" });
  }

  protected sendToolResult(call: { id: unknown; name: string }, response: Record<string, unknown>) {
    this.pendingCalls.delete(String(call.id));
    this.sendUpstream({ type: "conversation.item.create", item: { type: "function_call_output", call_id: String(call.id), output: JSON.stringify(response) } });
    if (this.pendingCalls.size === 0) {
      this.responseWanted = true;
      this.maybeCreateResponse();
    }
  }

  protected onToolResultDropped(call: { id: unknown; name: string }) {
    // Only ids of the current session are tracked; a replaced session's id is already gone.
    this.pendingCalls.delete(String(call.id));
  }

  /** Notices wait for the model, pending tool results and the browser's playback. */
  protected engineBusy() {
    return this.activeResponse || this.responseWanted || this.pendingCalls.size > 0 || this.browserPlaying;
  }

  /** One `response.create` at a time, and never while tool results are still being produced. */
  private maybeCreateResponse() {
    if (this.responseWanted && !this.activeResponse && this.pendingCalls.size === 0 && !this.reconnecting) {
      if (this.sendUpstream({ type: "response.create" })) {
        this.responseWanted = false;
        // Optimistic until response.created; an error before it clears this again.
        this.activeResponse = true;
        this.awaitingCreated = true;
        this.modelTurnActive = true;
      }
    }
    if (!this.activeResponse) this.flushNotices();
  }

  protected onBrowserPlayback(playing: boolean) {
    if (playing) return;
    this.playbackStoppedAtInputMs = this.appendedInputMs;
    this.flushNotices();
  }

  protected recitationText(text: string) { return toTaiwanTraditional(text); }
  protected beforeNewDraft() { this.recitationPlayback = null; }
  protected onRecited(_draft: DraftState) { /* playback window is recorded in onResponseDone */ }

  // ---- bookkeeping ----------------------------------------------------------

  private remember(role: "Owner" | "助理", text: string) {
    const clean = text.replace(/\s+/g, " ").trim();
    if (!clean) return;
    this.history.push({ role, text: Array.from(clean).slice(0, 400).join("") });
    while (this.history.length > HISTORY_LIMIT) this.history.shift();
    while (this.history.length > 1 && this.history.reduce((sum, entry) => sum + entry.text.length, 0) > HISTORY_CHARS) this.history.shift();
  }

  private recordUsage(usage: unknown) {
    this.usage.responses += 1;
    if (!usage || typeof usage !== "object") return;
    const value = usage as Record<string, any>;
    this.usage.inputTokens += numberOr0(value.input_tokens);
    this.usage.outputTokens += numberOr0(value.output_tokens);
    this.usage.totalTokens += numberOr0(value.total_tokens);
    this.usage.inputAudioTokens += numberOr0(value.input_token_details?.audio_tokens);
    this.usage.inputTextTokens += numberOr0(value.input_token_details?.text_tokens);
    this.usage.cachedInputTokens += numberOr0(value.input_token_details?.cached_tokens);
    this.usage.outputAudioTokens += numberOr0(value.output_token_details?.audio_tokens);
    this.usage.outputTextTokens += numberOr0(value.output_token_details?.text_tokens);
  }

  protected usageSnapshot() { return { ...this.usage }; }
  protected snapshotExtras() {
    return { activeResponse: this.activeResponse, responseWanted: this.responseWanted, pendingToolCalls: this.pendingCalls.size, historyEntries: this.history.length };
  }
}

function errorCode(message: Record<string, any>) { return String(message.error?.code ?? message.error?.type ?? "unknown").slice(0, 80); }

/** PCM16 mono 24 kHz: 48 bytes per millisecond. */
function bytesToMs(bytes: number) { return bytes / 48; }
