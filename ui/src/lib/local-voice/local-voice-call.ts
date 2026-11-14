import {
  LOCAL_VOICE_CALL_MAX_SECONDS,
  LOCAL_VOICE_CALL_WARNING_SECONDS,
  LOCAL_VOICE_RELAY_PROTOCOL,
  LOCAL_VOICE_RELAY_TOKEN_PREFIX,
  LOCAL_VOICE_SILENCE_PAUSE_SECONDS,
  type LocalVoiceRelayClientMessage,
  type LocalVoiceRelayServerEvent,
} from "@paperclipai/shared";
import { agentChatsApi } from "@/api/agentChats";
import { issuesApi } from "@/api/issues";
import { localVoiceApi } from "@/api/localVoice";
import { buildSameOriginWebSocketUrl } from "@/lib/websocket-url";
import { loadVoiceWorklets } from "./worklets";

/** Speech above this RMS level counts as caller activity for the 60-second silence pause. */
export const SPEECH_RMS_THRESHOLD = 0.02;

export type LocalVoicePhase = "idle" | "starting" | "live" | "ending" | "ended" | "error";
/**
 * `agent_chat` (HOM-326, default): each finished utterance is posted to the Owner's
 * Chat with the agent as the Owner's own message. `voice_task` (HOM-311): a separate
 * voice task with read-back drafts that need a spoken or UI confirmation.
 */
export type LocalVoiceMode = "agent_chat" | "voice_task";
/** agent_chat: one dictated message and the result of posting it to the Chat. */
/** `dropped`: heard but not sent because it sounded like the assistant's own voice (echo) or a lone filler (noise). */
export interface LocalVoiceSentEntry { operationId: string; text: string; status: "sending" | "sent" | "failed" | "dropped"; error?: string }
export interface LocalVoiceTranscriptEntry { id: number; role: "user" | "model"; text: string }
export interface LocalVoiceDraftView {
  draftId: string; revision: number; text: string;
  status: "pending" | "submitting" | "submitted" | "failed";
  via?: "spoken" | "ui"; error?: string;
}
export interface LocalVoiceReplyView { commentId: string; body: string; voiceSummary: string | null; createdAt: string }
export interface LocalVoiceCallSnapshot {
  phase: LocalVoicePhase;
  mode: LocalVoiceMode;
  mic: "live" | "paused";
  micPausedReason: "manual" | "silence" | null;
  modelSpeaking: boolean;
  issue: { id: string; identifier: string | null } | null;
  agentName: string | null;
  startedAt: number | null;
  maxSeconds: number;
  warningSeconds: number;
  timeWarning: boolean;
  transcript: LocalVoiceTranscriptEntry[];
  draft: LocalVoiceDraftView | null;
  replies: LocalVoiceReplyView[];
  /** agent_chat: dictated messages posted (or being posted) to the Chat, oldest first. */
  sentLog: LocalVoiceSentEntry[];
  notice: string | null;
  error: string | null;
  endedReason: string | null;
}

/** Browser audio for one call. Created synchronously inside the user's click. */
export interface VoiceAudioEngine {
  start(handlers: { onFrame(pcm: ArrayBuffer, rms: number, rate?: number): void; onPlaying(playing: boolean): void }): Promise<void>;
  play(pcm: ArrayBuffer): void;
  flush(): void;
  /** Microphone frame rate the relay expects (sent in its `ready` event). */
  setInputSampleRate(rate: number): void;
  close(): Promise<void>;
}

export interface LocalVoiceCallDependencies {
  api: Pick<typeof localVoiceApi, "ensureEndpoint" | "start" | "end" | "relayPath">;
  /** agent_chat: the caller's Chat issue with the agent, created when missing. */
  ensureChat(companyId: string, agentId: string): Promise<{ id: string; identifier?: string | null }>;
  /** agent_chat: post a dictated message to the Chat as the caller; clientRequestId keeps retries idempotent. */
  postChatMessage(issueId: string, body: string, clientRequestId: string): Promise<{ id: string }>;
  createSocket(url: string, protocols: string[]): WebSocket;
  createAudio(): VoiceAudioEngine;
  now(): number;
  randomId(): string;
  setInterval(fn: () => void, ms: number): unknown;
  clearInterval(handle: unknown): void;
  /** Defaults to the global timers. */
  setTimeout?(fn: () => void, ms: number): unknown;
  clearTimeout?(handle: unknown): void;
  wakeLock?: () => Promise<{ release(): Promise<void> } | null>;
}

const MAX_TRANSCRIPT = 60;
const MAX_SENT_LOG = 50;
/** agent_chat end: how long to wait for the relay to flush buffered words and confirm the end. */
export const AGENT_CHAT_END_WAIT_MS = 5_000;
/** agent_chat end: how long to wait for Chat posts that are still in flight. */
export const AGENT_CHAT_POST_SETTLE_MS = 5_000;
const OPEN = 1;

const END_REASONS: Record<string, string> = {
  caller_ended: "Call ended.",
  max_duration: "The call reached the 15-minute limit.",
  session_unavailable: "The voice session is no longer available.",
  upstream_unavailable: "The voice model could not be reached.",
  server_shutdown: "Paperclip restarted. Start a new call to continue.",
  relay_error: "The call stopped because of an error.",
};

function initialSnapshot(): LocalVoiceCallSnapshot {
  return {
    phase: "idle", mode: "voice_task", mic: "live", micPausedReason: null, modelSpeaking: false, issue: null, agentName: null, startedAt: null,
    maxSeconds: LOCAL_VOICE_CALL_MAX_SECONDS, warningSeconds: LOCAL_VOICE_CALL_WARNING_SECONDS, timeWarning: false,
    transcript: [], draft: null, replies: [], sentLog: [], notice: null, error: null, endedReason: null,
  };
}

export function errorMessage(error: unknown, fallback = "Voice could not start.") {
  if (error && typeof error === "object") {
    const name = (error as { name?: unknown }).name;
    if (name === "NotAllowedError" || name === "SecurityError") return "Microphone permission was denied. Allow microphone access for this site and try again.";
    if (name === "NotFoundError") return "No microphone was found.";
    const body = (error as { body?: { error?: unknown } }).body;
    if (body && typeof body.error === "string") return body.error;
    const message = (error as { message?: unknown }).message;
    if (typeof message === "string" && message) return message;
  }
  return fallback;
}

function isCallAlreadyActive(error: unknown) {
  const failure = error as { status?: number; body?: { code?: unknown } } | null;
  return failure?.status === 409 && failure.body?.code === "voice_call_already_active";
}

/** The live session that blocked a start; the error handler nests it under `details`. */
function activeSessionId(error: unknown) {
  const body = (error as { body?: { sessionId?: unknown; details?: { sessionId?: unknown } } } | null)?.body;
  const id = body?.sessionId ?? body?.details?.sessionId;
  return typeof id === "string" && id ? id : null;
}

export class LocalVoiceCall {
  private snapshot: LocalVoiceCallSnapshot = initialSnapshot();
  private readonly listeners = new Set<() => void>();
  private socket: WebSocket | null = null;
  private audio: VoiceAudioEngine | null = null;
  private session: { companyId: string; sessionId: string } | null = null;
  private lastActivityAt = 0;
  /** Microphone rate the relay announced; frames made at another rate are dropped. */
  private inputSampleRate: number | null = null;
  private silenceTimer: unknown = null;
  private nextTranscriptId = 1;
  private openTurn: { role: "user" | "model"; id: number } | null = null;
  private wakeLock: { release(): Promise<void> } | null = null;
  private ending = false;
  /** Each start owns one attempt; end() or a newer start makes older attempts stale. */
  private attempt = 0;
  private mode: LocalVoiceMode = "voice_task";
  /** agent_chat: the bound Chat issue that dictations are posted to. */
  private chatIssueId: string | null = null;
  /** agent_chat: Chat posts that have not settled yet. */
  private readonly pendingPosts = new Set<Promise<void>>();
  /** agent_chat end(): resolved by the relay's `ended` event or the socket closing. */
  private relayEnded: (() => void) | null = null;

  constructor(private readonly deps: LocalVoiceCallDependencies) {}

  subscribe = (listener: () => void) => { this.listeners.add(listener); return () => { this.listeners.delete(listener); }; };
  getSnapshot = () => this.snapshot;

  private update(patch: Partial<LocalVoiceCallSnapshot>) {
    this.snapshot = { ...this.snapshot, ...patch };
    for (const listener of this.listeners) listener();
  }

  /** Must be called from a user gesture: it creates the AudioContext synchronously. */
  async start(input: { companyId: string; agentId: string; issueId?: string; newConversation?: boolean; mode?: LocalVoiceMode }) {
    if (this.snapshot.phase === "starting" || this.snapshot.phase === "live" || this.snapshot.phase === "ending") return;
    this.ending = false;
    const attempt = ++this.attempt;
    const stale = () => attempt !== this.attempt || this.ending;
    let createdSession: { companyId: string; sessionId: string } | null = null;
    const abandon = async () => {
      // A newer start or end() took over: release only what this attempt created.
      await audio.close().catch(() => undefined);
      if (createdSession && this.session?.sessionId !== createdSession.sessionId) {
        await this.deps.api.end(createdSession.companyId, createdSession.sessionId).catch(() => undefined);
      }
    };
    const audio = this.deps.createAudio();
    this.audio = audio;
    const mode: LocalVoiceMode = input.mode ?? "voice_task";
    this.mode = mode;
    this.chatIssueId = null;
    this.snapshot = { ...initialSnapshot(), phase: "starting", mode, replies: [], transcript: [], sentLog: [] };
    this.inputSampleRate = null;
    this.update({});
    try {
      const endpoint = await this.deps.api.ensureEndpoint(input.companyId, input.agentId);
      if (stale()) return void await abandon();
      let started: Awaited<ReturnType<LocalVoiceCallDependencies["api"]["start"]>>;
      if (mode === "agent_chat") {
        const chat = await this.deps.ensureChat(input.companyId, input.agentId);
        if (stale()) return void await abandon();
        this.chatIssueId = chat.id;
        this.update({ issue: { id: chat.id, identifier: chat.identifier ?? null } });
        const startChat = () => this.deps.api.start(input.companyId, {
          endpointId: endpoint.endpointId, issueId: chat.id, bindingMode: "agent_chat",
          idempotencyKey: this.deps.randomId(), maxDurationSeconds: LOCAL_VOICE_CALL_MAX_SECONDS + 30,
        });
        try {
          started = await startChat();
        } catch (error) {
          // This caller still has a live call on the Chat (for example an old tab): end it and retry once.
          const previous = isCallAlreadyActive(error) ? activeSessionId(error) : null;
          if (!previous) throw error;
          await this.deps.api.end(input.companyId, previous);
          if (stale()) return void await abandon();
          started = await startChat();
          this.update({ notice: "An earlier voice call on this Chat was ended." });
        }
      } else {
        const startOnce = (newConversation: boolean) => this.deps.api.start(input.companyId, {
          endpointId: endpoint.endpointId, ...(input.issueId && !newConversation ? { issueId: input.issueId } : {}), ...(newConversation ? { newConversation: true } : {}),
          idempotencyKey: this.deps.randomId(), maxDurationSeconds: LOCAL_VOICE_CALL_MAX_SECONDS + 30,
        });
        try {
          started = await startOnce(Boolean(input.newConversation));
        } catch (error) {
          // An earlier call on the same voice task is still open (for example in another tab).
          // Calls never preempt each other, so continue on a fresh voice task instead.
          if (!input.newConversation && isCallAlreadyActive(error)) {
            started = await startOnce(true);
            this.update({ notice: "Another call is still open on the previous voice task, so this call uses a new voice task." });
          } else throw error;
        }
      }
      createdSession = { companyId: input.companyId, sessionId: started.session.id };
      if (stale()) return void await abandon();
      if (!started.media) throw new Error("This voice call was already started elsewhere. End it there or start a new one.");
      this.session = createdSession;
      this.update({ issue: { id: started.session.issueId, identifier: this.snapshot.issue?.identifier ?? null }, agentName: endpoint.agentName });
      await audio.start({
        onFrame: (pcm, rms, rate) => this.onMicFrame(pcm, rms, rate),
        onPlaying: (playing) => {
          if (playing) this.lastActivityAt = this.deps.now();
          this.update({ modelSpeaking: playing });
          // The relay accepts a spoken confirmation only after playback has drained.
          this.send({ type: "playback", playing });
        },
      });
      if (stale()) return void await abandon();
      const socket = this.deps.createSocket(buildSameOriginWebSocketUrl(this.deps.api.relayPath(input.companyId, started.session.id)),
        [LOCAL_VOICE_RELAY_PROTOCOL, `${LOCAL_VOICE_RELAY_TOKEN_PREFIX}${started.media.transportToken}`]);
      socket.binaryType = "arraybuffer";
      socket.onmessage = (event) => {
        if (typeof event.data === "string") {
          try { this.onEvent(JSON.parse(event.data) as LocalVoiceRelayServerEvent); } catch { /* ignore malformed */ }
        } else if (event.data instanceof ArrayBuffer) {
          this.audio?.play(event.data);
        }
      };
      socket.onclose = () => {
        if (this.socket !== socket) return;
        this.relayEnded?.();
        this.onSocketClosed();
      };
      this.socket = socket;
    } catch (error) {
      if (stale()) return void await abandon();
      await this.cleanup({ endRemote: true });
      this.update({ phase: "error", error: errorMessage(error) });
    }
  }

  private onMicFrame(pcm: ArrayBuffer, rms: number, rate?: number) {
    const now = this.deps.now();
    if (rms >= SPEECH_RMS_THRESHOLD) this.lastActivityAt = now;
    if (this.snapshot.phase !== "live" || this.snapshot.mic !== "live") return;
    // A frame captured before the rate switch would play at the wrong speed upstream.
    if (rate !== undefined && this.inputSampleRate !== null && rate !== this.inputSampleRate) return;
    if (this.socket?.readyState === OPEN) this.socket.send(pcm);
  }

  private onEvent(event: LocalVoiceRelayServerEvent) {
    switch (event.type) {
      case "ready":
        this.lastActivityAt = this.deps.now();
        // Older relays did not announce a rate; they expected 16 kHz.
        this.inputSampleRate = event.inputSampleRate ?? 16_000;
        this.audio?.setInputSampleRate(this.inputSampleRate);
        this.update({ phase: "live", issue: { id: event.issueId, identifier: event.issueIdentifier }, agentName: event.agentName,
          startedAt: this.deps.now(), maxSeconds: event.maxSeconds, warningSeconds: event.warningSeconds });
        void this.deps.wakeLock?.().then((lock) => { if (this.snapshot.phase === "live") this.wakeLock = lock; else void lock?.release(); }).catch(() => undefined);
        this.silenceTimer = this.deps.setInterval(() => this.checkSilence(), 1000);
        return;
      case "dictation": this.onDictation(event); return;
      case "dictation_dropped":
        if (this.mode !== "agent_chat") return;
        this.update({ sentLog: [...this.snapshot.sentLog, { operationId: `dropped-${this.nextTranscriptId++}`, text: event.text, status: "dropped" as const,
          error: event.reason === "echo" ? "Not sent: it sounded like the assistant's own voice." : "Not sent: too short to be a request." }].slice(-MAX_SENT_LOG) });
        return;
      case "transcript": this.appendTranscript(event.role, event.text); return;
      case "interrupted":
        this.audio?.flush();
        this.openTurn = null;
        this.update({ modelSpeaking: false });
        return;
      case "turn_complete": if (this.openTurn?.role === "model") this.openTurn = null; return;
      case "draft": this.update({ draft: { ...event.draft, status: "pending" } }); return;
      case "draft_cleared": if (this.snapshot.draft?.draftId === event.draftId) this.update({ draft: null }); return;
      case "submitted":
        if (this.snapshot.draft?.draftId === event.draftId && this.snapshot.draft.revision === event.revision) this.update({ draft: { ...this.snapshot.draft, status: "submitted", via: event.via, error: undefined } });
        return;
      case "submit_failed":
        if (this.snapshot.draft?.draftId === event.draftId && this.snapshot.draft.revision === event.revision) this.update({ draft: { ...this.snapshot.draft, status: "failed", error: event.message } });
        return;
      case "agent_reply":
        if (!this.snapshot.replies.some((reply) => reply.commentId === event.commentId)) {
          this.update({ replies: [...this.snapshot.replies, { commentId: event.commentId, body: event.body, voiceSummary: event.voiceSummary, createdAt: event.createdAt }] });
        }
        return;
      case "time_warning": this.update({ timeWarning: true }); return;
      case "reconnecting": this.update({ notice: "Reconnecting to the voice model…" }); return;
      case "resumed": this.update({ notice: event.contextKept ? null : "Reconnected. Earlier conversation context may be lost." }); return;
      case "error": this.update({ notice: event.message }); return;
      case "ended":
        this.update({ endedReason: END_REASONS[event.reason] ?? "Call ended." });
        // end() is waiting for the relay's final dictation; it cleans up itself.
        if (this.relayEnded) return void this.relayEnded();
        void this.cleanup({ endRemote: false }).then(() => this.update({ phase: "ended" }));
        return;
    }
  }

  /** agent_chat: post one dictated utterance to the Chat as the caller and report the result to the relay. */
  private onDictation(event: Extract<LocalVoiceRelayServerEvent, { type: "dictation" }>) {
    const issueId = this.chatIssueId;
    if (this.mode !== "agent_chat" || !issueId) return;
    if (this.snapshot.sentLog.some((entry) => entry.operationId === event.operationId)) return;
    const { operationId } = event;
    const socket = this.socket;
    this.update({ sentLog: [...this.snapshot.sentLog, { operationId, text: event.text, status: "sending" as const }].slice(-MAX_SENT_LOG) });
    const settle = (patch: Pick<LocalVoiceSentEntry, "status" | "error">) => {
      this.update({ sentLog: this.snapshot.sentLog.map((entry) => entry.operationId === operationId ? { operationId, text: entry.text, ...patch } : entry) });
    };
    const task = this.deps.postChatMessage(issueId, event.body, operationId).then(
      (comment) => {
        settle({ status: "sent" });
        this.sendOn(socket, { type: "dictation_result", operationId, status: "sent", ...(comment?.id ? { commentId: comment.id } : {}) });
      },
      (error: unknown) => {
        const message = errorMessage(error, "The message could not be sent to the Chat.");
        settle({ status: "failed", error: message });
        this.sendOn(socket, { type: "dictation_result", operationId, status: "failed", message: message.slice(0, 500) });
      },
    );
    this.pendingPosts.add(task);
    void task.finally(() => this.pendingPosts.delete(task));
  }

  private appendTranscript(role: "user" | "model", text: string) {
    let transcript = this.snapshot.transcript;
    if (this.openTurn?.role === role) {
      const id = this.openTurn.id;
      transcript = transcript.map((entry) => entry.id === id ? { ...entry, text: entry.text + text } : entry);
    } else {
      const id = this.nextTranscriptId++;
      this.openTurn = { role, id };
      transcript = [...transcript, { id, role, text }].slice(-MAX_TRANSCRIPT);
    }
    if (role === "user") this.lastActivityAt = this.deps.now();
    this.update({ transcript });
  }

  private checkSilence() {
    if (this.snapshot.phase !== "live" || this.snapshot.mic !== "live" || this.snapshot.modelSpeaking) return;
    if (this.deps.now() - this.lastActivityAt >= LOCAL_VOICE_SILENCE_PAUSE_SECONDS * 1000) this.pauseMic("silence");
  }

  pauseMic(reason: "manual" | "silence" = "manual") {
    if (this.snapshot.phase !== "live" || this.snapshot.mic === "paused") return;
    this.send({ type: "mic", state: "paused" });
    this.update({ mic: "paused", micPausedReason: reason });
  }

  resumeMic() {
    if (this.snapshot.phase !== "live" || this.snapshot.mic === "live") return;
    this.lastActivityAt = this.deps.now();
    this.send({ type: "mic", state: "live" });
    this.update({ mic: "live", micPausedReason: null });
  }

  sendText(text: string) {
    const trimmed = text.trim();
    if (!trimmed || this.snapshot.phase !== "live") return false;
    this.lastActivityAt = this.deps.now();
    this.appendTranscript("user", trimmed);
    this.openTurn = null;
    return this.send({ type: "text", text: trimmed });
  }

  confirmDraft() {
    const draft = this.snapshot.draft;
    if (!draft || draft.status === "submitting" || draft.status === "submitted") return;
    if (this.send({ type: "confirm_draft", draftId: draft.draftId, revision: draft.revision })) this.update({ draft: { ...draft, status: "submitting", error: undefined } });
  }

  cancelDraft() {
    const draft = this.snapshot.draft;
    if (!draft || draft.status === "submitted" || draft.status === "submitting") return;
    this.send({ type: "cancel_draft", draftId: draft.draftId });
  }

  async end() {
    if (this.snapshot.phase === "idle" || this.snapshot.phase === "ended" || this.snapshot.phase === "ending") return;
    this.ending = true;
    this.attempt += 1;
    const socketOpen = this.socket?.readyState === OPEN;
    this.update({ phase: "ending" });
    if (socketOpen) this.send({ type: "end" });
    if (socketOpen && this.mode === "agent_chat") {
      // The relay finishes and flushes what the caller already said as a final dictation, then reports `ended`.
      const relayDone = this.waitFor((resolve) => { this.relayEnded = resolve; }, AGENT_CHAT_END_WAIT_MS);
      // Release the microphone and speaker now; only the relay's final words are awaited.
      const audio = this.audio;
      this.audio = null;
      await audio?.close().catch(() => undefined);
      this.update({ modelSpeaking: false });
      await relayDone;
      this.relayEnded = null;
    }
    if (this.pendingPosts.size > 0) {
      const posts = [...this.pendingPosts];
      await this.waitFor((resolve) => { void Promise.allSettled(posts).then(() => resolve()); }, AGENT_CHAT_POST_SETTLE_MS);
    }
    await this.cleanup({ endRemote: !socketOpen });
    this.update({ phase: "ended", endedReason: this.snapshot.endedReason ?? END_REASONS.caller_ended! });
  }

  /** Resolves when `register`'s callback fires or after `ms`, whichever comes first. */
  private waitFor(register: (resolve: () => void) => void, ms: number) {
    const setTimer = this.deps.setTimeout ?? ((fn: () => void, delay: number) => globalThis.setTimeout(fn, delay));
    const clearTimer = this.deps.clearTimeout ?? ((handle: unknown) => globalThis.clearTimeout(handle as ReturnType<typeof setTimeout>));
    return new Promise<void>((resolve) => {
      let timer: unknown = null;
      const done = () => { if (timer !== null) clearTimer(timer); timer = null; resolve(); };
      timer = setTimer(done, ms);
      register(done);
    });
  }

  private onSocketClosed() {
    if (this.snapshot.phase === "ended" || this.snapshot.phase === "ending") return;
    const error = this.mode === "agent_chat"
      ? "The voice connection was lost. Start the call again to keep talking in the same Chat."
      : "The voice connection was lost. Start the call again to continue the same voice task.";
    void this.cleanup({ endRemote: true }).then(() => this.update({ phase: "error", error }));
  }

  private send(message: LocalVoiceRelayClientMessage) {
    return this.sendOn(this.socket, message);
  }

  private sendOn(socket: WebSocket | null, message: LocalVoiceRelayClientMessage) {
    if (socket?.readyState !== OPEN) return false;
    socket.send(JSON.stringify(message));
    return true;
  }

  private async cleanup(options: { endRemote: boolean }) {
    if (this.silenceTimer !== null) { this.deps.clearInterval(this.silenceTimer); this.silenceTimer = null; }
    const socket = this.socket;
    this.socket = null;
    if (socket && socket.readyState <= OPEN) { try { socket.close(1000, "caller ended"); } catch { /* closed */ } }
    const audio = this.audio;
    this.audio = null;
    await audio?.close().catch(() => undefined);
    const lock = this.wakeLock;
    this.wakeLock = null;
    await lock?.release().catch(() => undefined);
    const session = this.session;
    this.session = null;
    if (options.endRemote && session) await this.deps.api.end(session.companyId, session.sessionId).catch(() => undefined);
    this.openTurn = null;
    this.update({ modelSpeaking: false });
  }

  dispose() { void this.end(); this.listeners.clear(); }
}

/** Context rate for calls: the relay's 24 kHz model audio plays without resampling and the browser resamples the microphone. */
export const VOICE_CONTEXT_SAMPLE_RATE = 24_000;

/** Browser implementation: one AudioContext, mic capture and player worklets. */
export function createBrowserAudioEngine(): VoiceAudioEngine {
  const AudioContextCtor = window.AudioContext ?? (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
  if (!AudioContextCtor) throw new Error("This browser does not support Web Audio.");
  const createContext = (sampleRate?: number) => {
    const created = new AudioContextCtor(sampleRate ? { latencyHint: "interactive", sampleRate } : { latencyHint: "interactive" });
    void created.resume().catch(() => undefined);
    return created;
  };
  let context: AudioContext;
  try { context = createContext(VOICE_CONTEXT_SAMPLE_RATE); } catch { context = createContext(); }
  let stream: MediaStream | null = null;
  let player: AudioWorkletNode | null = null;
  let capture: AudioWorkletNode | null = null;
  let source: MediaStreamAudioSourceNode | null = null;
  let inputRate = VOICE_CONTEXT_SAMPLE_RATE;
  let closed = false;
  return {
    async start(handlers) {
      if (!window.isSecureContext || !navigator.mediaDevices?.getUserMedia) {
        throw new Error("Voice needs a secure page (HTTPS) with microphone access. Open Paperclip through its HTTPS address.");
      }
      const granted = await navigator.mediaDevices.getUserMedia({ audio: { channelCount: 1, echoCancellation: true, noiseSuppression: true, autoGainControl: true } });
      if (closed) { for (const track of granted.getTracks()) track.stop(); throw new Error("The call ended before the microphone opened."); }
      stream = granted;
      try {
        source = context.createMediaStreamSource(stream);
      } catch (error) {
        // Some browsers cannot connect a microphone to a context whose rate differs from the device rate.
        if (context.sampleRate !== VOICE_CONTEXT_SAMPLE_RATE) throw error;
        await context.close().catch(() => undefined);
        context = createContext();
        source = context.createMediaStreamSource(stream);
      }
      await loadVoiceWorklets(context);
      player = new AudioWorkletNode(context, "pc-voice-player", { numberOfInputs: 0, numberOfOutputs: 1, outputChannelCount: [2] });
      player.port.onmessage = (event) => { if (event.data?.type === "playing") handlers.onPlaying(Boolean(event.data.playing)); };
      player.connect(context.destination);
      capture = new AudioWorkletNode(context, "pc-mic-capture", { numberOfInputs: 1, numberOfOutputs: 0, channelCount: 1, channelCountMode: "explicit" });
      capture.port.postMessage({ type: "rate", rate: inputRate });
      capture.port.onmessage = (event) => {
        if (event.data?.pcm) handlers.onFrame(event.data.pcm as ArrayBuffer, Number(event.data.rms) || 0, typeof event.data.rate === "number" ? event.data.rate : undefined);
      };
      source.connect(capture);
      if (context.state !== "running") await context.resume();
    },
    play(pcm) { player?.port.postMessage({ type: "pcm", data: pcm }, [pcm]); },
    flush() { player?.port.postMessage({ type: "flush" }); },
    setInputSampleRate(rate) {
      inputRate = rate;
      capture?.port.postMessage({ type: "rate", rate });
    },
    async close() {
      closed = true;
      try { source?.disconnect(); capture?.disconnect(); player?.disconnect(); } catch { /* already disconnected */ }
      for (const track of stream?.getTracks() ?? []) track.stop();
      if (context.state !== "closed") await context.close().catch(() => undefined);
    },
  };
}

export function createLocalVoiceCall() {
  return new LocalVoiceCall({
    api: localVoiceApi,
    ensureChat: (companyId, agentId) => agentChatsApi.ensure(companyId, agentId),
    postChatMessage: (issueId, body, clientRequestId) => issuesApi.addComment(issueId, body, undefined, undefined, undefined, clientRequestId),
    createSocket: (url, protocols) => new WebSocket(url, protocols),
    createAudio: createBrowserAudioEngine,
    now: () => Date.now(),
    randomId: () => crypto.randomUUID(),
    setInterval: (fn, ms) => window.setInterval(fn, ms),
    clearInterval: (handle) => window.clearInterval(handle as number),
    wakeLock: async () => {
      const wakeLock = (navigator as Navigator & { wakeLock?: { request(type: "screen"): Promise<{ release(): Promise<void> }> } }).wakeLock;
      return wakeLock ? wakeLock.request("screen") : null;
    },
  });
}
