import type { PushDevice, PushPreferences, PushSettings, PushSubscriptionInput } from "@paperclipai/shared";
import { api, detachInflightGet } from "./client";
export const pushApi = {
  get: () => { detachInflightGet("/push"); return api.get<PushSettings>("/push", { cache: "no-store" }); },
  preferences: (companyId: string, expectedUserId: string, preferences: PushPreferences) => api.put<PushPreferences>("/push/preferences", { companyId, expectedUserId, preferences }),
  subscribe: (companyId: string, expectedUserId: string, subscription: PushSubscriptionInput) => api.post<PushDevice>("/push/subscriptions", { companyId, expectedUserId, subscription }),
  remove: (companyId: string, expectedUserId: string, id: string) => api.delete<void>(`/push/subscriptions/${id}`, { companyId, expectedUserId }),
  test: (companyId: string, expectedUserId: string, id: string) => api.post<{ id: string }>(`/push/subscriptions/${id}/test`, { companyId, expectedUserId }),
};
