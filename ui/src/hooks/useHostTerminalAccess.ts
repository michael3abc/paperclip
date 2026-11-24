import { useQuery } from "@tanstack/react-query";
import { detachInflightGet } from "@/api/client";
import { accessApi } from "@/api/access";
import { useAccountIdentity } from "@/api/companies-query";

export function useHostTerminalAccess(companyId: string | null) {
  const { userId, settled, failed } = useAccountIdentity();
  const access = useQuery({
    queryKey: ["host-terminal-access", userId],
    queryFn: () => {
      detachInflightGet("/cli-auth/me");
      return accessApi.getCurrentBoardAccess();
    },
    enabled: settled && !!userId && !!companyId,
    retry: false,
  });
  return { ...access, userId, pending: !settled || (!!userId && access.isPending), allowed: settled && !failed && !access.isError && !!userId && access.data?.userId === userId
    && access.data.source === "session" && access.data.isInstanceAdmin === true
    && !!companyId && access.data.companyIds.includes(companyId) };
}
