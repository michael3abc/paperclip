import { LOCAL_VOICE_GEMINI_INPUT_SAMPLE_RATE } from "@paperclipai/shared";
import {
  VoiceRelayCore,
  numberOr0,
  voiceSystemInstruction,
  voiceToolDeclarations,
  type CallerUtterance,
  type VoiceUpstream,
} from "./voice-relay-core.js";

export {
  voiceSystemInstruction,
  voiceToolDeclarations,
  type VoiceAgentReply,
  type VoiceRelayBrowser,
  type VoiceRelayOptions,
  type VoiceSubmitResult,
  type VoiceTaskPort,
  type VoiceUpstream,
  type VoiceUpstreamFactory,
  type VoiceUpstreamHandlers,
} from "./voice-relay-core.js";

/**
 * Gemini Live engine for the local voice relay (HOM-311), kept as the
 * fallback engine after HOM-318. Compass/Vertex rejects `behavior:
 * NON_BLOCKING`, so every tool returns immediately and later agent replies
 * arrive as new `clientContent` turns.
 */
export class GeminiLiveRelay extends VoiceRelayCore {
  protected readonly engine = "gemini";
  readonly inputSampleRate = LOCAL_VOICE_GEMINI_INPUT_SAMPLE_RATE;
  protected readonly defaultTranscriptGraceMs = 1500;
  protected readonly dropStaleToolResults = false;
  /** Gemini Live answers every utterance, so the relay does not add its own acknowledgement. */
  protected readonly acknowledgesSpeech = true;
  private noticeResponse = false;
  private callerResponsePending = false;
  private resumeHandle: string | null = null;
  /** The caller utterance being transcribed, closed when the model reacts. */
  private openUtterance: CallerUtterance | null = null;
  /** Counter naming each caller utterance for the agent_chat echo filter. */
  private utteranceSegment = 0;
  private usage = { promptTokens: 0, responseTokens: 0, totalTokens: 0, messages: 0 };

  protected onUpstreamOpen(socket: VoiceUpstream) {
    socket.send(JSON.stringify({ setup: this.setupMessage() }));
  }

  protected handshake(message: Record<string, any>) {
    return message.setupComplete ? "ready" as const : null;
  }

  private setupMessage() {
    return {
      responseModalities: ["AUDIO"],
      speechConfig: { voiceConfig: { prebuiltVoiceConfig: { voiceName: this.options.voiceName ?? "Kore" } } },
      systemInstruction: { parts: [{ text: voiceSystemInstruction(this.options.binding) }] },
      // agent_chat has no tools: the caller's words reach the Chat without the model.
      tools: this.chatMode ? [] : [{ functionDeclarations: voiceToolDeclarations(this.options.binding.agentName) }],
      inputAudioTranscription: {},
      outputAudioTranscription: {},
      sessionResumption: this.resumeHandle ? { handle: this.resumeHandle } : {},
      contextWindowCompression: { slidingWindow: {} },
    };
  }

  protected handleUpstreamMessage(message: Record<string, any>) {
    if (message.setupComplete) return;
    if (message.sessionResumptionUpdate) {
      const update = message.sessionResumptionUpdate;
      if (update.resumable !== false && typeof update.newHandle === "string" && update.newHandle) this.resumeHandle = update.newHandle;
    }
    if (message.goAway) {
      this.log("voice_relay_go_away", { engine: this.engine, timeLeft: message.goAway.timeLeft ?? null });
      void this.reconnect("go_away");
    }
    if (message.usageMetadata) this.recordUsage(message.usageMetadata);
    const calls = message.toolCall?.functionCalls;
    if (Array.isArray(calls)) {
      this.openUtterance = null;
      for (const call of calls) if (call && typeof call === "object") void this.runToolCall(call);
    }
    const content = message.serverContent;
    if (!content || typeof content !== "object") return;
    if (typeof content.inputTranscription?.text === "string" && content.inputTranscription.text) {
      const text = content.inputTranscription.text;
      if (this.mainAnswerChat) this.callerResponsePending = true;
      if (this.mainAnswerChat && !this.openUtterance) {
        this.interruptChatPlayback();
        this.noticeResponse = false;
        this.browser.sendEvent({ type: "interrupted" });
        this.browserPlaying = false;
      }
      this.browser.sendEvent({ type: "transcript", role: "user", text });
      if (!this.openUtterance) { this.openUtterance = this.beginUtterance(); this.utteranceSegment += 1; }
      this.openUtterance.text += text;
      // Gemini streams fragments; the core merges them after a quiet gap and judges echo per utterance.
      if (this.chatMode) this.collectDictation(text, { duringPlayback: this.browserPlaying || this.modelTurnActive, segment: `g${this.utteranceSegment}` });
    }
    const parts = content.modelTurn?.parts;
    for (const part of Array.isArray(parts) ? parts : []) {
      const data = part?.inlineData;
      if (typeof data?.data === "string" && String(data.mimeType ?? "").startsWith("audio/pcm")) {
        if (!this.modelTurnActive) this.openUtterance = null;
        this.modelTurnActive = true;
        if (this.mainAnswerChat && !this.noticeResponse) continue;
        this.browserPlaying = true;
        this.noteChatAudio();
        this.browser.sendAudio(Buffer.from(data.data, "base64"));
      }
    }
    if ((!this.mainAnswerChat || this.noticeResponse) && typeof content.outputTranscription?.text === "string" && content.outputTranscription.text) {
      this.turnOutput += content.outputTranscription.text;
      this.browser.sendEvent({ type: "transcript", role: "model", text: content.outputTranscription.text });
    }
    if (content.interrupted) {
      this.interruptChatPlayback();
      this.noticeResponse = false;
      this.browser.sendEvent({ type: "interrupted" });
      // The browser flushes its playback on barge-in.
      this.browserPlaying = false;
      this.finishModelTurn({ completed: false });
    }
    if (content.turnComplete) {
      this.openUtterance = null;
      this.callerResponsePending = false;
      this.noticeResponse = false;
      this.browser.sendEvent({ type: "turn_complete" });
      this.finishModelTurn({ completed: true });
    }
  }

  protected onRecited() { this.openUtterance = null; }
  protected beforeNewDraft() { this.openUtterance = null; }

  protected beginReconnect() {
    const hadHandle = this.resumeHandle !== null;
    return () => hadHandle && this.resumeHandle !== null;
  }

  protected onReconnected() {
    this.callerResponsePending = false;
    this.noticeResponse = false;
    this.openUtterance = null;
  }

  protected onReconnectAttemptFailed() {
    // A stale handle must not block a fresh session on the next attempt.
    this.resumeHandle = null;
  }

  protected sendAudio(pcm: Buffer) {
    this.sendUpstream({ realtimeInput: { audio: { mimeType: `audio/pcm;rate=${this.inputSampleRate}`, data: pcm.toString("base64") } } });
  }

  protected engineBusy() { return this.mainAnswerChat && (this.callerResponsePending || this.browserPlaying); }

  protected sendUserTurn(text: string) {
    this.noticeResponse = true;
    return this.sendUpstream({ clientContent: { turns: [{ role: "user", parts: [{ text }] }], turnComplete: true } });
  }

  protected onMicPaused() {
    this.sendUpstream({ realtimeInput: { audioStreamEnd: true } });
  }

  protected sendToolResult(call: { id: unknown; name: string }, response: Record<string, unknown>) {
    this.sendUpstream({ toolResponse: { functionResponses: [{ id: call.id, name: call.name, response }] } });
  }

  private recordUsage(usage: Record<string, unknown>) {
    this.usage.messages += 1;
    this.usage.promptTokens += numberOr0(usage.promptTokenCount);
    this.usage.responseTokens += numberOr0(usage.responseTokenCount);
    this.usage.totalTokens += numberOr0(usage.totalTokenCount);
  }

  protected usageSnapshot() { return { ...this.usage }; }
  protected snapshotExtras() { return { hasResumeHandle: this.resumeHandle !== null }; }
}
