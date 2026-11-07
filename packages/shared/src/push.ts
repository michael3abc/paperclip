import { z } from "zod";

export const PUSH_CATEGORIES = ["approval", "question", "completed", "problem", "chat", "progress", "subtask"] as const;
export type PushCategory = typeof PUSH_CATEGORIES[number];
export const DEFAULT_PUSH_CATEGORIES: Record<PushCategory, boolean> = {
  approval: true, question: true, completed: true, problem: true, chat: true, progress: false, subtask: false,
};
export const pushPreferencesSchema = z.object({
  enabled: z.boolean(),
  categories: z.object({ approval: z.boolean(), question: z.boolean(), completed: z.boolean(),
    problem: z.boolean(), chat: z.boolean(), progress: z.boolean(), subtask: z.boolean() }).strict(),
}).strict();
export type PushPreferences = z.infer<typeof pushPreferencesSchema>;
export const pushSubscriptionSchema = z.object({
  endpoint: z.string().url().max(2048),
  keys: z.object({ p256dh: z.string().regex(/^[A-Za-z0-9_-]{87}$/), auth: z.string().regex(/^[A-Za-z0-9_-]{22}$/) }).strict(),
  name: z.string().trim().min(1).max(80),
}).strict();
export type PushSubscriptionInput = z.infer<typeof pushSubscriptionSchema>;
export const pushRequestContextSchema = z.object({ companyId: z.string().uuid(), expectedUserId: z.string().min(1) }).strict();
export const pushPreferencesRequestSchema = pushRequestContextSchema.extend({ preferences: pushPreferencesSchema }).strict();
export const pushSubscribeRequestSchema = pushRequestContextSchema.extend({ subscription: pushSubscriptionSchema }).strict();
export interface PushDevice { id: string; name: string; active: boolean; createdAt: string; }
export interface PushDeliveryStatus {
  id: string; subscriptionId: string; category: PushCategory | "test"; status: string;
  attempts: number; error: string | null; createdAt: string; nextAttemptAt: string;
}
export interface PushSettings {
  userId: string; configured: boolean; publicKey: string | null; preferences: PushPreferences;
  devices: PushDevice[]; recent: PushDeliveryStatus[];
}
export interface PushPayload { title: string; body: string; url: string; tag: string; subscriptionId?: string; }
