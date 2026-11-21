import type { DashboardSummary, ProviderQuotaResult } from "@paperclipai/shared";
import { api } from "./client";
export type HostClaudeSession = { id: string; hostId: string; status: "starting" | "waiting" | "verifying" | "authenticated" | "failed" | "cancelled"; authorizationUrl?: string; expiresAt: string };
export type HostCodexSession = Omit<HostClaudeSession, "authorizationUrl"> & { verificationUrl?: string; userCode?: string };

export const dashboardApi = {
  codexHosts: (companyId: string) => api.get<{ id: string; label: string; available: boolean }[]>(`/companies/${companyId}/dashboard/host-codex`),
  checkHostCodex: (companyId: string, hostId: string) => api.post<{ loggedIn: boolean | null }>(`/companies/${companyId}/dashboard/host-codex/${encodeURIComponent(hostId)}/check`, {}),
  startHostCodex: (companyId: string, hostId: string) => api.post<HostCodexSession>(`/companies/${companyId}/dashboard/host-codex/${encodeURIComponent(hostId)}/login`, {}),
  hostCodexSession: (companyId: string, id: string) => api.get<HostCodexSession>(`/companies/${companyId}/dashboard/host-codex/sessions/${id}`),
  cancelHostCodex: (companyId: string, id: string) => api.post<HostCodexSession>(`/companies/${companyId}/dashboard/host-codex/sessions/${id}/cancel`, {}),
  claudeHosts: (companyId: string) => api.get<{ id: string; label: string; available: boolean }[]>(`/companies/${companyId}/dashboard/host-claude`),
  checkHostClaude: (companyId: string, hostId: string) => api.post<{ loggedIn: boolean | null }>(`/companies/${companyId}/dashboard/host-claude/${encodeURIComponent(hostId)}/check`, {}),
  startHostClaude: (companyId: string, hostId: string) => api.post<HostClaudeSession>(`/companies/${companyId}/dashboard/host-claude/${encodeURIComponent(hostId)}/login`, {}),
  hostClaudeSession: (companyId: string, id: string) => api.get<HostClaudeSession>(`/companies/${companyId}/dashboard/host-claude/sessions/${id}`),
  hostClaudeAction: (companyId: string, id: string, action: "code" | "cancel", code?: string) => api.post<HostClaudeSession>(`/companies/${companyId}/dashboard/host-claude/sessions/${id}/${action}`, code ? { browserCode: code } : {}),
  summary: (companyId: string) => api.get<DashboardSummary>(`/companies/${companyId}/dashboard`),
  subscriptionQuotas: (companyId: string) => api.get<ProviderQuotaResult[]>("/companies/" + companyId + "/dashboard/subscription-quotas"),
};
