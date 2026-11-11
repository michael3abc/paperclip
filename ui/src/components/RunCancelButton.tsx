import { useMutation, useQueryClient } from "@tanstack/react-query";
import { heartbeatsApi } from "@/api/heartbeats";
import { Button } from "@/components/ui/button";
import { queryKeys } from "@/lib/queryKeys";
import { waitForStoppedRuns } from "@/lib/wait-for-stopped-runs";

/** Cancel exactly the displayed run; never cancel a successor implicitly. */
export function RunCancelButton({ runId, issueId, companyId, agentId, finishCancellation = false }: {
  runId: string; issueId?: string | null; companyId?: string; agentId: string; finishCancellation?: boolean;
}) {
  const client = useQueryClient();
  const cancel = useMutation({
    retry: false,
    mutationFn: async () => {
      const stopped = await heartbeatsApi.cancel(runId);
      await waitForStoppedRuns([runId], { initialRuns: [stopped] });
    },
    onSettled: async () => {
      const keys = [queryKeys.runDetail(runId)];
      const related = [
        ...(companyId ? [queryKeys.heartbeats(companyId, agentId)] : []),
        ...(issueId ? [queryKeys.issues.detail(issueId), queryKeys.issues.runs(issueId),
          queryKeys.issues.liveRuns(issueId), queryKeys.issues.activeRun(issueId)] : []),
      ];
      await Promise.all([...keys, ...related].map(queryKey => client.invalidateQueries({ queryKey })));
    },
  });
  return <div className="flex flex-col gap-1">
    <Button type="button" variant="outline" size="sm" disabled={cancel.isPending || cancel.isSuccess}
      onClick={() => cancel.mutate()}>
      {cancel.isPending ? "Cancelling…" : cancel.isSuccess ? "Cancelled" : finishCancellation ? "Finish cancellation" : "Cancel run"}
    </Button>
    {cancel.error && <p role="alert" className="text-xs text-destructive">
      {cancel.error instanceof Error ? cancel.error.message : "Cancellation could not be confirmed."}
    </p>}
  </div>;
}
