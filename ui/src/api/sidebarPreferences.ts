import type {
  CompanySidebarPreference,
  SidebarOrderPreference,
  UpsertCompanySidebarPreference,
  UpsertSidebarOrderPreference,
} from "@paperclipai/shared";
import { api } from "./client";

export const sidebarPreferencesApi = {
  getCompanyOrder: () => api.get<SidebarOrderPreference>("/sidebar-preferences/me"),
  updateCompanyOrder: (data: UpsertSidebarOrderPreference) =>
    api.put<SidebarOrderPreference>("/sidebar-preferences/me", data),
  // The company-scoped preference carries the project order and the agents the
  // user excluded from the project-PM sidebar status. A PUT writes only the
  // fields it sends, so an order-only payload leaves the exclusions untouched.
  getProjectOrder: (companyId: string) =>
    api.get<CompanySidebarPreference>(`/companies/${companyId}/sidebar-preferences/me`),
  updateProjectOrder: (companyId: string, data: UpsertCompanySidebarPreference) =>
    api.put<CompanySidebarPreference>(`/companies/${companyId}/sidebar-preferences/me`, data),
};
