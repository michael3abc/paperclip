import { createHash } from "node:crypto";
import type { VoiceProvider } from "@paperclipai/shared";

/**
 * Provider-neutral tool command. Provider protocols (Speko webhooks, the local
 * voice.control.v1 messages) translate into this shape; the session store
 * never sees provider wire formats.
 */
export type VoiceToolCommand =
  | { tool: "submit_request"; args: { text: string } }
  | { tool: "answer_question"; args: { interactionId: string; answers: Array<{ questionId: string; optionIds: string[]; otherText?: string | null }> } }
  | { tool: "get_updates"; args: { cursor: number; repeat?: boolean } };

export interface VoiceCommandEnvelope {
  provider: VoiceProvider;
  /** Provider media/session identifier stored in chat_voice_sessions.provider_session_id. */
  providerSessionId: string;
  /** Provider tool call identifier; replays of the same id return the stored result. */
  toolCallId: string;
  command: VoiceToolCommand;
  /** sha256 of the provider's canonical message; a reused toolCallId must match it. */
  fingerprint: string;
  /** Unique per company; local commands derive it from session and toolCallId. */
  webhookId: string;
  /** Local-only logical operation and confirmation references. */
  operationId?: string;
  confirmation?: { draftId: string; revision: number };
}

/** Stored tool response returned to the provider. Never contains credentials. */
export type VoiceToolReceipt = Record<string, unknown>;

export const sha256Hex = (value: string | Buffer) => createHash("sha256").update(value).digest("hex");
