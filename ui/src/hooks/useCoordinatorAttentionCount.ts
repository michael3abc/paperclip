import { useEffect } from "react";
import { queryKeys } from "@/lib/queryKeys";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { attentionApi } from "@/api/attention";
import { useCoordinatorWorkspaceEnabled } from "./useCoordinatorWorkspaceEnabled";
import { ATTENTION_STALE_TIME_MS, coordinatorAttentionQueryKey, coordinatorAttentionSummaryQueryKey, coordinatorAttentionTasksQueryKey } from "@/lib/coordinator-attention";
import { useLocation } from "@/lib/router";

/** This count hook never starts a full-feed read. Bound project PM status is
 * the explicit navigation exception and shares the page-owned full-feed key.
 * Desktop and mobile counts otherwise share the separate summary read. */
export function useCoordinatorAttentionCount(companyId: string | null | undefined, enabled = true) {
  const { userId } = useCoordinatorWorkspaceEnabled();
  const location = useLocation();
  const canRead = enabled && !!companyId && !!userId;
  const feedPage = location.pathname.endsWith("/decisions");
  const taskPage = location.pathname.endsWith("/issues") && new URLSearchParams(location.search).get("view") === "needs_attention";
  const attention = useQuery({ queryKey: coordinatorAttentionQueryKey(companyId!, userId, "mine"),
    queryFn: () => attentionApi.list(companyId!, { all: true, view: "mine" }), enabled: false });
  const summary = useQuery({ queryKey: coordinatorAttentionSummaryQueryKey(companyId!, userId),
    staleTime: ATTENTION_STALE_TIME_MS,
    queryFn: () => attentionApi.summary(companyId!), enabled: canRead && !feedPage && !taskPage });
  const tasks = useQuery({ queryKey: coordinatorAttentionTasksQueryKey(companyId!, userId),
    queryFn: () => attentionApi.taskIndex(companyId!), enabled: false });
  // These are three projections of the same company/person count. Keep the
  // newest known count during route changes, including an explicit fresh zero.
  // Server generation time wins over a delayed older response arriving later.
  const queryClient = useQueryClient();
  const snapshots = feedPage ? [attention, tasks, summary] : taskPage ? [tasks, attention, summary] : [summary, attention, tasks];
  const latest = snapshots.filter(snapshot => snapshot.data !== undefined)
    .sort((a, b) => ((Date.parse(b.data?.generatedAt ?? "") || 0) - (Date.parse(a.data?.generatedAt ?? "") || 0))
      || b.dataUpdatedAt - a.dataUpdatedAt)[0]?.data;
  const nextSnoozeAt = latest?.nextSnoozeAt;
  useEffect(() => {
    if (!canRead || !companyId || !nextSnoozeAt) return;
    // One deadline per viewer. A hidden tab catches up on focus.
    const due = Date.parse(nextSnoozeAt);
    let timer: number;
    const schedule = () => {
      const remaining = due - Date.now();
      if (remaining <= 0) void queryClient.invalidateQueries({ queryKey: queryKeys.attention(companyId) });
      else timer = window.setTimeout(schedule, Math.min(remaining, 2_147_483_647));
    };
    schedule();
    return () => window.clearTimeout(timer);
  }, [canRead, companyId, nextSnoozeAt, queryClient]);
  return canRead ? latest?.deskBadgeCount ?? 0 : 0;
}
