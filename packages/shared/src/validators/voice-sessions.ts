import { z } from "zod";
export const startVoiceSessionSchema = z.object({
  endpointId: z.string().uuid(),
  issueId: z.string().uuid().optional(),
  newConversation: z.boolean().optional(),
  idempotencyKey: z.string().uuid(),
  maxDurationSeconds: z.number().int().min(30).max(1800).default(600),
  /** Server-owned binding. Only voice_task exists; any other value is rejected. */
  bindingMode: z.literal("voice_task").optional(),
}).strict().refine((value) => !(value.issueId && value.newConversation), { message: "Choose an existing task or a new conversation", path: ["newConversation"] });
export const voiceCallbackPreferenceSchema = z.object({
  phoneNumber: z.string().regex(/^\+[1-9]\d{6,14}$/, "Use an international phone number, such as +12015551234"),
  enabled: z.boolean(),
}).strict();
export const voiceSessionCursorSchema = z.object({ cursor: z.coerce.number().int().min(0).max(Number.MAX_SAFE_INTEGER).default(0) }).strict();

export const voicePhoneConfigurationSchema = z.object({ numberId: z.string().regex(/^[A-Za-z0-9_-]{1,200}$/), enabled: z.boolean(), guestIntake: z.boolean().default(false), lowTrustEnvironmentId: z.string().uuid().nullable().optional() }).strict();
export const voiceInboundDecisionSchema = z.object({ approve: z.boolean(), approvalCode: z.string().regex(/^[0-9]{6}$/), issueId: z.string().uuid().optional() }).strict();

const VOICE_TEXT_LIMIT = 16_000;
/**
 * Confirmed voice text is canonical: non-empty and without leading or trailing
 * whitespace, because the chat work queue stores the trimmed message as the
 * issue comment. Requiring the canonical form keeps the confirmed hash equal to
 * the hash of the text the agent receives.
 */
export const voiceConfirmedTextSchema = z.string().max(VOICE_TEXT_LIMIT)
  .refine((value) => /\S/.test(value), { message: "Confirmed text must not be empty" })
  .refine((value) => value === value.trim(), { message: "Confirmed text must not have leading or trailing whitespace" });
export const localVoiceConfirmationSchema = z.object({
  draftId: z.string().uuid(),
  revision: z.number().int().min(1).max(1_000_000),
  text: voiceConfirmedTextSchema,
}).strict();
export const voiceOperationIdSchema = z.string().uuid();
