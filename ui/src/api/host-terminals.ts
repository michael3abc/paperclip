import type { HostTerminalHost, HostTerminalSession } from "@paperclipai/shared";
import { api } from "./client";
const base = (companyId: string) => `/companies/${encodeURIComponent(companyId)}/host-terminals`;
export const hostTerminalsApi = {
  list: (companyId: string) => api.get<HostTerminalHost[]>(base(companyId)),
  create: (companyId: string, hostId: string) => api.post<HostTerminalSession>(`${base(companyId)}/${encodeURIComponent(hostId)}/sessions`, {}),
};
