import type { DashboardSummary, ProviderQuotaResult } from "@paperclipai/shared";
import { api } from "./client";

export const dashboardApi = {
  summary: (companyId: string) => api.get<DashboardSummary>(`/companies/${companyId}/dashboard`),
  subscriptionQuotas: (companyId: string) => api.get<ProviderQuotaResult[]>("/companies/" + companyId + "/dashboard/subscription-quotas"),
};
