import { z } from "zod";
import { respondIssueThreadInteractionSchema, voiceConfirmedTextSchema } from "@paperclipai/shared";
import { sha256Hex, type VoiceCommandEnvelope } from "./voice-command.js";

/** voice.control.v1: strict same-origin control messages for the local voice provider. */
export const LOCAL_VOICE_CONTROL_LIMIT = 64 * 1024;
const toolCallId = z.string().regex(/^[A-Za-z0-9_:.-]{1,200}$/);
const base = { v: z.literal(1), type: z.literal("tool"), toolCallId };
export const localVoiceToolMessageSchema = z.discriminatedUnion("tool", [
  z.object({
    ...base,
    tool: z.literal("submit_request"),
    operationId: z.string().uuid(),
    confirmation: z.object({ draftId: z.string().uuid(), revision: z.number().int().min(1).max(1_000_000) }).strict(),
    args: z.object({ text: voiceConfirmedTextSchema }).strict(),
  }).strict(),
  z.object({
    ...base,
    tool: z.literal("answer_question"),
    operationId: z.string().uuid(),
    args: respondIssueThreadInteractionSchema.pick({ answers: true }).extend({ interactionId: z.string().uuid() }).strict(),
  }).strict(),
  z.object({
    ...base,
    tool: z.literal("get_updates"),
    args: z.object({ cursor: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER), repeat: z.boolean().optional() }).strict(),
  }).strict(),
]);
export type LocalVoiceToolMessage = z.infer<typeof localVoiceToolMessageSchema>;

export class LocalVoiceProtocolError extends Error {
  constructor(readonly code: "body_too_large" | "invalid_json" | "invalid_message", readonly issues?: string[]) { super(code); }
}

/**
 * Parse the ORIGINAL request bytes. A parsed-body fallback would let Express
 * coerce or drop fields, so non-JSON, unknown tools, extra identity fields
 * (companyId, agentId, ...) and a wrong version are all rejected here.
 */
export function parseLocalVoiceToolMessage(body: Buffer | string): LocalVoiceToolMessage {
  const raw = typeof body === "string" ? Buffer.from(body, "utf8") : body;
  if (raw.length > LOCAL_VOICE_CONTROL_LIMIT) throw new LocalVoiceProtocolError("body_too_large");
  let json: unknown;
  try { json = JSON.parse(raw.toString("utf8")); } catch { throw new LocalVoiceProtocolError("invalid_json"); }
  const parsed = localVoiceToolMessageSchema.safeParse(json);
  if (!parsed.success) throw new LocalVoiceProtocolError("invalid_message", parsed.error.issues.map((issue) => `${issue.path.join(".") || "(root)"}: ${issue.message}`));
  return parsed.data;
}

/** Translate a validated v1 message into the provider-neutral command. */
export function localVoiceCommand(message: LocalVoiceToolMessage, input: { sessionId: string; providerSessionId: string }): VoiceCommandEnvelope {
  const fingerprint = sha256Hex(JSON.stringify(message));
  const common = {
    provider: "local_voice" as const,
    providerSessionId: input.providerSessionId,
    toolCallId: message.toolCallId,
    fingerprint,
    webhookId: `local:${input.sessionId}:${message.toolCallId}`,
  };
  switch (message.tool) {
    case "submit_request":
      return { ...common, command: { tool: "submit_request", args: { text: message.args.text } }, operationId: message.operationId, confirmation: message.confirmation };
    case "answer_question":
      return { ...common, command: { tool: "answer_question", args: message.args }, operationId: message.operationId };
    case "get_updates":
      return { ...common, command: { tool: "get_updates", args: message.args } };
  }
}

/**
 * v1 result frame. `status` mirrors HTTP semantics; `result` is the stored tool
 * response (its own `status` such as "accepted" or "pending" stays nested so
 * it can never overwrite the frame status).
 */
export function localVoiceToolResult(toolCallId: string, status: number, result: Record<string, unknown>) {
  return { v: 1 as const, type: "tool_result" as const, toolCallId, status, result };
}

/** The three strict tools exposed to the local voice model. */
export function localVoiceToolDefinitions() {
  return [
    { name: "submit_request", description: "Submit the caller's confirmed request to the assigned Paperclip agent on this voice task. Requires an operationId you keep for retries and the confirmation (draftId, revision) shown to the caller. Acceptance means saved, not completed.", parameters: { type: "object", properties: { operationId: { type: "string", format: "uuid" }, confirmation: { type: "object", properties: { draftId: { type: "string", format: "uuid" }, revision: { type: "integer", minimum: 1 } }, required: ["draftId", "revision"], additionalProperties: false }, text: { type: "string", minLength: 1, maxLength: 16000 } }, required: ["operationId", "confirmation", "text"], additionalProperties: false } },
    { name: "answer_question", description: "Answer the exact pending question returned by get_updates. Cannot approve actions.", parameters: { type: "object", properties: { operationId: { type: "string", format: "uuid" }, interactionId: { type: "string", format: "uuid" }, answers: { type: "array", minItems: 1, maxItems: 20, items: { type: "object", properties: { questionId: { type: "string" }, optionIds: { type: "array", items: { type: "string" } }, otherText: { type: "string", maxLength: 16000 } }, required: ["questionId", "optionIds"], additionalProperties: false } } }, required: ["operationId", "interactionId", "answers"], additionalProperties: false } },
    { name: "get_updates", description: "Retrieve the assigned agent's published answers for this voice task. Empty updates means pending, not finished. Progress is never a final answer.", parameters: { type: "object", properties: { cursor: { type: "integer", minimum: 0 }, repeat: { type: "boolean" } }, required: ["cursor"], additionalProperties: false } },
  ] as const;
}
