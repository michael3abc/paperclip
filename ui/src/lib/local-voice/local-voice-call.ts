import {
  LOCAL_VOICE_CALL_MAX_SECONDS,
  LOCAL_VOICE_CALL_WARNING_SECONDS,
  LOCAL_VOICE_RELAY_PROTOCOL,
  LOCAL_VOICE_RELAY_TOKEN_PREFIX,
  LOCAL_VOICE_SILENCE_PAUSE_SECONDS,
  type LocalVoiceRelayClientMessage,
  type LocalVoiceRelayServerEvent,
} from "@paperclipai/shared";
import { localVoiceApi } from "@/api/localVoice";
import { buildSameOriginWebSocketUrl } from "@/lib/websocket-url";
import { loadVoiceWorklets } from "./worklets";

/** Speech above this RMS level counts as caller activity for the 60-second silence pause. */
export const SPEECH_RMS_THRESHOLD = 0.02;

export type LocalVoicePhase = "idle" | "starting" | "live" | "ending" | "ended" | "error";
export interface LocalVoiceTranscriptEntry { id: number; role: "user" | "model"; text: string }
export interface LocalVoiceDraftView {
  draftId: string; revision: number; text: string;
  status: "pending" | "submitting" | "submitted" | "failed";
  via?: "spoken" | "ui"; error?: string;
}
export interface LocalVoiceReplyView { commentId: string; body: string; voiceSummary: string | null; createdAt: string }
export interface LocalVoiceCallSnapshot {
  phase: LocalVoicePhase;
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
  notice: string | null;
  error: string | null;
  endedReason: string | null;
}

/** Browser audio for one call. Created synchronously inside the user's click. */
export interface VoiceAudioEngine {
  start(handlers: { onFrame(pcm: ArrayBuffer, rms: number): void; onPlaying(playing: boolean): void }): Promise<void>;
  play(pcm: ArrayBuffer): void;
  flush(): void;
  close(): Promise<void>;
}

export interface LocalVoiceCallDependencies {
  api: Pick<typeof localVoiceApi, "ensureEndpoint" | "start" | "end" | "relayPath">;
  createSocket(url: string, protocols: string[]): WebSocket;
  createAudio(): VoiceAudioEngine;
  now(): number;
  randomId(): string;
  setInterval(fn: () => void, ms: number): unknown;
  clearInterval(handle: unknown): void;
  wakeLock?: () => Promise<{ release(): Promise<void> } | null>;
}

const MAX_TRANSCRIPT = 60;
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
    phase: "idle", mic: "live", micPausedReason: null, modelSpeaking: false, issue: null, agentName: null, startedAt: null,
    maxSeconds: LOCAL_VOICE_CALL_MAX_SECONDS, warningSeconds: LOCAL_VOICE_CALL_WARNING_SECONDS, timeWarning: false,
    transcript: [], draft: null, replies: [], notice: null, error: null, endedReason: null,
  };
}

export function errorMessage(error: unknown) {
  if (error && typeof error === "object") {
    const name = (error as { name?: unknown }).name;
    if (name === "NotAllowedError" || name === "SecurityError") return "Microphone permission was denied. Allow microphone access for this site and try again.";
    if (name === "NotFoundError") return "No microphone was found.";
    const body = (error as { body?: { error?: unknown } }).body;
    if (body && typeof body.error === "string") return body.error;
    const message = (error as { message?: unknown }).message;
    if (typeof message === "string" && message) return message;
  }
  return "Voice could not start.";
}

export class LocalVoiceCall {
  private snapshot: LocalVoiceCallSnapshot = initialSnapshot();
  private readonly listeners = new Set<() => void>();
  private socket: WebSocket | null = null;
  private audio: VoiceAudioEngine | null = null;
  private session: { companyId: string; sessionId: string } | null = null;
  private lastActivityAt = 0;
  private silenceTimer: unknown = null;
  private nextTranscriptId = 1;
  private openTurn: { role: "user" | "model"; id: number } | null = null;
  private wakeLock: { release(): Promise<void> } | null = null;
  private ending = false;
  /** Each start owns one attempt; end() or a newer start makes older attempts stale. */
  private attempt = 0;

  constructor(private readonly deps: LocalVoiceCallDependencies) {}

  subscribe = (listener: () => void) => { this.listeners.add(listener); return () => { this.listeners.delete(listener); }; };
  getSnapshot = () => this.snapshot;

  private update(patch: Partial<LocalVoiceCallSnapshot>) {
    this.snapshot = { ...this.snapshot, ...patch };
    for (const listener of this.listeners) listener();
  }

  /** Must be called from a user gesture: it creates the AudioContext synchronously. */
  async start(input: { companyId: string; agentId: string; issueId?: string; newConversation?: boolean }) {
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
    this.snapshot = { ...initialSnapshot(), phase: "starting", replies: [], transcript: [] };
    this.update({});
    try {
      const endpoint = await this.deps.api.ensureEndpoint(input.companyId, input.agentId);
      if (stale()) return void await abandon();
      const startOnce = (newConversation: boolean) => this.deps.api.start(input.companyId, {
        endpointId: endpoint.endpointId, ...(input.issueId && !newConversation ? { issueId: input.issueId } : {}), ...(newConversation ? { newConversation: true } : {}),
        idempotencyKey: this.deps.randomId(), maxDurationSeconds: LOCAL_VOICE_CALL_MAX_SECONDS + 30,
      });
      let started: Awaited<ReturnType<typeof startOnce>>;
      try {
        started = await startOnce(Boolean(input.newConversation));
      } catch (error) {
        // An earlier call on the same voice task is still open (for example in another tab).
        // Calls never preempt each other, so continue on a fresh voice task instead.
        if (!input.newConversation && (error as { status?: number; body?: { code?: unknown } })?.status === 409
          && (error as { body?: { code?: unknown } }).body?.code === "voice_call_already_active") {
          started = await startOnce(true);
          this.update({ notice: "Another call is still open on the previous voice task, so this call uses a new voice task." });
        } else throw error;
      }
      createdSession = { companyId: input.companyId, sessionId: started.session.id };
      if (stale()) return void await abandon();
      if (!started.media) throw new Error("This voice call was already started elsewhere. End it there or start a new one.");
      this.session = createdSession;
      this.update({ issue: { id: started.session.issueId, identifier: null }, agentName: endpoint.agentName });
      await audio.start({
        onFrame: (pcm, rms) => this.onMicFrame(pcm, rms),
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
      socket.onclose = () => { if (this.socket === socket) this.onSocketClosed(); };
      this.socket = socket;
    } catch (error) {
      if (stale()) return void await abandon();
      await this.cleanup({ endRemote: true });
      this.update({ phase: "error", error: errorMessage(error) });
    }
  }

  private onMicFrame(pcm: ArrayBuffer, rms: number) {
    const now = this.deps.now();
    if (rms >= SPEECH_RMS_THRESHOLD) this.lastActivityAt = now;
    if (this.snapshot.phase !== "live" || this.snapshot.mic !== "live") return;
    if (this.socket?.readyState === OPEN) this.socket.send(pcm);
  }

  private onEvent(event: LocalVoiceRelayServerEvent) {
    switch (event.type) {
      case "ready":
        this.lastActivityAt = this.deps.now();
        this.update({ phase: "live", issue: { id: event.issueId, identifier: event.issueIdentifier }, agentName: event.agentName,
          startedAt: this.deps.now(), maxSeconds: event.maxSeconds, warningSeconds: event.warningSeconds });
        void this.deps.wakeLock?.().then((lock) => { if (this.snapshot.phase === "live") this.wakeLock = lock; else void lock?.release(); }).catch(() => undefined);
        this.silenceTimer = this.deps.setInterval(() => this.checkSilence(), 1000);
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
        void this.cleanup({ endRemote: false }).then(() => this.update({ phase: "ended" }));
        return;
    }
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
    await this.cleanup({ endRemote: !socketOpen });
    this.update({ phase: "ended", endedReason: this.snapshot.endedReason ?? END_REASONS.caller_ended! });
  }

  private onSocketClosed() {
    if (this.snapshot.phase === "ended" || this.snapshot.phase === "ending") return;
    void this.cleanup({ endRemote: true }).then(() => this.update({ phase: "error", error: "The voice connection was lost. Start the call again to continue the same voice task." }));
  }

  private send(message: LocalVoiceRelayClientMessage) {
    if (this.socket?.readyState !== OPEN) return false;
    this.socket.send(JSON.stringify(message));
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

/** Browser implementation: one AudioContext, mic capture and player worklets. */
export function createBrowserAudioEngine(): VoiceAudioEngine {
  const AudioContextCtor = window.AudioContext ?? (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
  if (!AudioContextCtor) throw new Error("This browser does not support Web Audio.");
  const context = new AudioContextCtor({ latencyHint: "interactive" });
  void context.resume().catch(() => undefined);
  let stream: MediaStream | null = null;
  let player: AudioWorkletNode | null = null;
  let capture: AudioWorkletNode | null = null;
  let source: MediaStreamAudioSourceNode | null = null;
  let closed = false;
  return {
    async start(handlers) {
      if (!window.isSecureContext || !navigator.mediaDevices?.getUserMedia) {
        throw new Error("Voice needs a secure page (HTTPS) with microphone access. Open Paperclip through its HTTPS address.");
      }
      const granted = await navigator.mediaDevices.getUserMedia({ audio: { channelCount: 1, echoCancellation: true, noiseSuppression: true, autoGainControl: true } });
      if (closed) { for (const track of granted.getTracks()) track.stop(); throw new Error("The call ended before the microphone opened."); }
      stream = granted;
      await loadVoiceWorklets(context);
      player = new AudioWorkletNode(context, "pc-voice-player", { numberOfInputs: 0, numberOfOutputs: 1, outputChannelCount: [2] });
      player.port.onmessage = (event) => { if (event.data?.type === "playing") handlers.onPlaying(Boolean(event.data.playing)); };
      player.connect(context.destination);
      source = context.createMediaStreamSource(stream);
      capture = new AudioWorkletNode(context, "pc-mic-capture", { numberOfInputs: 1, numberOfOutputs: 0, channelCount: 1, channelCountMode: "explicit" });
      capture.port.onmessage = (event) => { if (event.data?.pcm) handlers.onFrame(event.data.pcm as ArrayBuffer, Number(event.data.rms) || 0); };
      source.connect(capture);
      if (context.state !== "running") await context.resume();
    },
    play(pcm) { player?.port.postMessage({ type: "pcm", data: pcm }, [pcm]); },
    flush() { player?.port.postMessage({ type: "flush" }); },
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
