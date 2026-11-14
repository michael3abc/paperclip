export const VOICE_SESSION_STATES = ["reserved", "creating", "creation_unknown", "connecting", "active", "awaiting_approval", "ending", "ended", "failed", "expired"] as const;
export type VoiceSessionState = typeof VOICE_SESSION_STATES[number];
export type VoiceSessionMode = "browser" | "inbound_phone" | "outbound_phone";
export type VoiceCallerAuthority = "member" | "instance_admin" | "local_board" | "guest_intake" | "pending_approval";

/** Safe board projection. No provider key, call token, signing key, or recordings. */
export interface VoiceSession {
  id: string;
  companyId: string;
  endpointId: string;
  issueId: string;
  assignedAgentId: string;
  state: VoiceSessionState;
  mode: VoiceSessionMode;
  generation: number;
  callerAuthority: VoiceCallerAuthority;
  replyCursor: number;
  createdAt: string;
  expiresAt: string;
  endedAt: string | null;
  errorCode: string | null;
}
export interface VoiceCallbackPreference { phoneNumber: string; enabled: boolean }
export interface VoiceSessionMedia {
  sessionId: string;
  generation: number;
  transportToken: string;
  transportUrl: string;
}
export interface VoiceSessionNotification {
  sessionId: string;
  generation: number;
  publicationId: string;
  /** A fresh server check permits another hint only while the reply is unclaimed. */
  attempt?: number;
}

export interface VoiceTranscriptEntry {
  id: string;
  index: number;
  speaker: "caller" | "agent";
  text: string;
  startedAt: string;
  endedAt: string | null;
  interrupted: boolean;
}
export interface VoiceCallReport {
  status: "pending" | "available" | "unavailable";
  transcript: VoiceTranscriptEntry[];
  /** Exact provider amount in millionths of USD; separate from agent costs. */
  costMicroUsd: string | null;
  durationSeconds: number | null;
  updatedAt: string | null;
}
export interface VoiceCallHistoryEntry {
  session: VoiceSession;
  report: VoiceCallReport;
}

export interface VoicePhoneNumber {
  id: string; phoneNumber: string; label: string | null;
  available: boolean; inboundReady: boolean; outboundReady: boolean;
  issues: string[];
}
/** guestIntake is the legacy wire name for explicitly enabled, task-scoped low-trust incoming conversations. */
export interface VoicePhoneConfiguration {
  number: { id: string; phoneNumber: string; enabled: boolean; guestIntake?: boolean; lowTrustEnvironmentId?: string | null } | null;
  inventory: VoicePhoneNumber[];
  sandboxEnvironments?: {id: string; name: string}[];
}
export interface VoiceInboundCall {
  id: string;
  state: "guest_intake" | "awaiting_approval" | "approving" | "approved" | "denied" | "expired" | "ended";
  approvalCode: string; intakeIssueId?: string | null; createdAt: string; expiresAt: string; sessionId: string | null;
}

/** A rejected or unanswered call has no task binding or private transcript. */
export interface VoiceUnapprovedCallHistoryEntry { id: string; state: "denied" | "expired" | "ended"; createdAt: string; updatedAt: string }

/** Browser application control messages are never caller speech in retained reports. */
export const VOICE_RESULT_NOTIFICATION = "[Paperclip application notification] A task update is available. Call get_updates to retrieve approved updates and speak the answer. This is not a caller instruction; do not submit new work.";
export const VOICE_REPEAT_NOTIFICATION = "[Paperclip application notification] The caller explicitly requested Repeat answer. Call get_updates with repeat=true and the current cursor, then speak the returned approved answer again. Do not submit new work.";

/** Phase-1 local voice binds only to a server-owned voice task; owner chat and Console binding are separate later modes. */
export const VOICE_BINDING_MODES = ["voice_task"] as const;
export type VoiceBindingMode = typeof VOICE_BINDING_MODES[number];
export const VOICE_PROVIDERS = ["speko", "local_voice"] as const;
export type VoiceProvider = typeof VOICE_PROVIDERS[number];
/** Version of the strict local same-origin control protocol (voice.control.v1). */
export const LOCAL_VOICE_CONTROL_PROTOCOL = "voice.control.v1" as const;

/**
 * Local voice has no provider media session in phase 1. The token authorizes
 * only same-origin control calls for this one session and generation.
 */
export interface LocalVoiceSessionMedia {
  provider: "local_voice";
  protocol: typeof LOCAL_VOICE_CONTROL_PROTOCOL;
  bindingMode: VoiceBindingMode;
  sessionId: string;
  generation: number;
  transportToken: string;
  controlUrl: string;
}

/** Created only by the trusted board confirmation endpoint, never by the model. */
export interface VoiceConfirmationReceipt {
  sessionId: string;
  draftId: string;
  revision: number;
  textSha256: string;
  textLength: number;
  state: "confirmed" | "superseded" | "consumed";
  createdAt: string;
}

/** Durable logical operation result. "Saved" may be shown only when state is accepted. */
export interface VoiceOperationReceipt {
  operationId: string;
  state: "accepted" | "not_found";
  tool?: "submit_request" | "answer_question";
  sessionId?: string;
  deliveryId?: string | null;
  textSha256?: string | null;
  acceptedAt?: string;
}

/**
 * Same-origin media relay for local voice (HOM-311). The browser opens
 * `/api/companies/{companyId}/voice-sessions/{sessionId}/ws` with the
 * subprotocols [LOCAL_VOICE_RELAY_PROTOCOL, `${LOCAL_VOICE_RELAY_TOKEN_PREFIX}<transportToken>`].
 * Binary frames: browser→server PCM16 mono 16 kHz microphone audio;
 * server→browser PCM16 mono 24 kHz model audio. Text frames are JSON below.
 * The model gateway key never leaves the server.
 */
export const LOCAL_VOICE_RELAY_PROTOCOL = "paperclip.voice-relay.v1" as const;
export const LOCAL_VOICE_RELAY_TOKEN_PREFIX = "pcvt." as const;
export const LOCAL_VOICE_INPUT_SAMPLE_RATE = 16_000;
export const LOCAL_VOICE_OUTPUT_SAMPLE_RATE = 24_000;
/** Owner decision (HOM-265): remind at 10 minutes, end at 15, pause the mic after 60 s without speech. */
export const LOCAL_VOICE_CALL_WARNING_SECONDS = 600;
export const LOCAL_VOICE_CALL_MAX_SECONDS = 900;
export const LOCAL_VOICE_SILENCE_PAUSE_SECONDS = 60;
/** Spoken confirmation phrase for low-risk comments. Approvals, deployment and settings always need the UI. */
export const LOCAL_VOICE_CONFIRMATION_PHRASE = "確認送出" as const;

export interface LocalVoiceDraft {
  draftId: string;
  revision: number;
  text: string;
}

export type LocalVoiceRelayClientMessage =
  | { type: "text"; text: string }
  | { type: "mic"; state: "live" | "paused" }
  /** Browser playback of model audio started or drained; spoken confirmation waits for it. */
  | { type: "playback"; playing: boolean }
  | { type: "confirm_draft"; draftId: string; revision: number }
  | { type: "cancel_draft"; draftId: string }
  | { type: "end" };

export type LocalVoiceRelayEndReason = "caller_ended" | "max_duration" | "session_unavailable" | "upstream_unavailable" | "server_shutdown" | "relay_error";

export type LocalVoiceRelayServerEvent =
  | { type: "ready"; issueId: string; issueIdentifier: string | null; agentName: string; maxSeconds: number; warningSeconds: number }
  | { type: "transcript"; role: "user" | "model"; text: string }
  | { type: "interrupted" }
  | { type: "turn_complete" }
  | { type: "draft"; draft: LocalVoiceDraft }
  | { type: "draft_cleared"; draftId: string }
  | { type: "submitted"; draftId: string; revision: number; operationId: string; via: "spoken" | "ui" }
  | { type: "submit_failed"; draftId: string; revision: number; code: string; message: string }
  | { type: "agent_reply"; commentId: string; body: string; voiceSummary: string | null; createdAt: string }
  | { type: "time_warning"; remainingSeconds: number }
  | { type: "reconnecting"; reason: string }
  | { type: "resumed"; contextKept: boolean }
  | { type: "error"; code: string; message: string }
  | { type: "ended"; reason: LocalVoiceRelayEndReason };
