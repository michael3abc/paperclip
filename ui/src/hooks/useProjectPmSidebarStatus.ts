import { useEffect, useMemo } from "react";
import { useQuery } from "@tanstack/react-query";
import { agentsApi } from "@/api/agents";
import { attentionApi } from "@/api/attention";
import type { LiveRunForIssue } from "@/api/heartbeats";
import { sidebarPreferencesApi } from "@/api/sidebarPreferences";
import { useToastActions } from "@/context/ToastContext";
import { deriveProjectPmSidebarStatus, type AgentSidebarStatus } from "@/lib/agent-sidebar-status";
import { coordinatorAttentionQueryKey } from "@/lib/coordinator-attention";
import { queryKeys } from "@/lib/queryKeys";

function useStatusReadError(companyId: string | null | undefined, source: string, title: string,
  query: { isError: boolean; error: unknown; errorUpdatedAt: number }) {
  const { pushToast } = useToastActions();
  const { isError, error, errorUpdatedAt } = query;
  useEffect(() => {
    if (!isError) return;
    pushToast({
      dedupeKey: `sidebar-pm-status-${source}:${companyId}`,
      title,
      body: error instanceof Error ? error.message : "PM working and needs-input status is hidden until they load.",
      tone: "error",
    });
  }, [companyId, source, title, isError, error, errorUpdatedAt, pushToast]);
}

/**
 * Presentation only; callers retain live-run ownership and shared polling.
 * `selfRunAgentIds` opts listed non-PM agents (project main agents) into
 * `working` for their own running runs; the viewer's exclusions still apply.
 */
export function useProjectPmSidebarStatus(
  companyId: string | null | undefined,
  userId: string | null | undefined,
  liveRuns: readonly LiveRunForIssue[] | undefined,
  options: { selfRunAgentIds?: readonly string[] } = {},
) {
  const bindings = useQuery({
    queryKey: queryKeys.pmWorkspaces(companyId!),
    queryFn: () => agentsApi.listPmWorkspaces(companyId!),
    enabled: !!companyId,
    staleTime: 60_000,
  });
  const hasBindings = (bindings.data?.length ?? 0) > 0;
  const selfRunAgentIds = options.selfRunAgentIds;
  const hasSelfRunAgents = (selfRunAgentIds?.length ?? 0) > 0;
  const preferences = useQuery({
    queryKey: queryKeys.sidebarPreferences.projectOrder(companyId ?? "__none__", userId ?? "__anon__"),
    queryFn: () => sidebarPreferencesApi.getProjectOrder(companyId!),
    // Exclusions apply to own-run status too, so it waits for the same list.
    enabled: !!companyId && !!userId && (hasBindings || (!!bindings.data && hasSelfRunAgents)),
  });
  // Deliberate full-feed navigation exception for bound PMs. Share the page's
  // complete snapshot and invalidation prefix; the count-only key stays separate.
  const attention = useQuery({
    queryKey: coordinatorAttentionQueryKey(companyId!),
    queryFn: () => attentionApi.list(companyId!, { all: true }),
    enabled: !!companyId && hasBindings,
    // Bindings may finish after the page's feed. Reuse that fresh snapshot
    // instead of downloading it again when this observer becomes enabled.
    staleTime: 60_000,
    refetchInterval: 60_000,
  });
  useStatusReadError(companyId, "binding", "Could not load project PM bindings", bindings);
  useStatusReadError(companyId, "preference", "Could not load PM status settings", preferences);
  useStatusReadError(companyId, "attention", "Could not load PM input requests", attention);

  const exclusions = preferences.data?.excludedPmStatusAgentIds;
  return useMemo(() => {
    // Unknown snapshots are not empty snapshots. React Query retains successful
    // data after a refetch failure; keep that status while reporting the failure.
    // Bindings decide which rules an agent follows, so they are always required.
    if (!userId || !bindings.data || !Array.isArray(exclusions)) {
      return new Map<string, AgentSidebarStatus>();
    }
    // PM rows need the complete attention snapshot even for blue. Until it
    // loads, bound agents claim nothing; own-run rows do not depend on it.
    const pmReady = !!attention.data;
    const boundIds = new Set(bindings.data.map(binding => binding.agentId));
    return deriveProjectPmSidebarStatus({
      liveRuns,
      pmWorkspaces: pmReady ? bindings.data : [],
      attentionItems: attention.data?.items ?? [],
      excludedAgentIds: exclusions,
      selfRunAgentIds: selfRunAgentIds?.filter(id => !boundIds.has(id)),
    });
    // Refetch timestamps re-evaluate snooze expiry even for unchanged data.
  }, [userId, bindings.data, exclusions, attention.data, attention.dataUpdatedAt, liveRuns, selfRunAgentIds]);
}
