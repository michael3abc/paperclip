import { useMutation, useQueryClient } from "@tanstack/react-query";
import { readRunStopSettlement, type RunStopSettlement } from "@paperclipai/shared";
import { heartbeatsApi } from "@/api/heartbeats";
import { Button } from "@/components/ui/button";
import { queryKeys } from "@/lib/queryKeys";
import { waitForStoppedRuns } from "@/lib/wait-for-stopped-runs";

const labels = { stopping: "正在停止", cleaning: "正在清理", needs_attention: "需處理", settled: "已結清" };
const reasons: Record<string, string> = {
  native_process_stop_unverified: "尚無對應程序的停止證據",
  controller_still_owned: "執行控制器尚未釋放",
  finalizer_still_owned: "收尾仍由原執行程序持有",
  finalizer_unsettled: "執行結果尚未完成收尾",
  recovery_still_pending: "原有復原流程尚未結束",
  instruction_process_stop_unverified: "指令副本尚無停止證據",
  instruction_cleanup_pending: "指令副本尚未清理完成",
  workspace_restore_pending: "工作目錄尚未回存完成",
  workspace_operation_pending: "工作目錄操作尚未結束",
  environment_cleanup_pending: "執行環境尚未釋放",
  bridge_unavailable: "目前無法讀取 Bridge 停止證據",
  state_not_found: "找不到原執行紀錄",
  background_active: "背景工作仍在執行",
  session_not_settled: "原會話尚未停止",
  forced_stop_unverified: "強制停止缺少獨立的終止證據",
  settlement_check_failed: "收尾檢查失敗，可重新檢查",
  execution_changed: "執行已更新，舊停止證據不適用",
};

export function RunStopSettlementStatus({ settlement }: { settlement?: RunStopSettlement | null }) {
  return settlement ? <span className="text-xs text-muted-foreground">{labels[settlement.state]}</span> : null;
}

/** Inspect exactly the displayed run. Terminal rechecks never send another Stop. */
export function RunCancelButton({ runId, issueId, companyId, agentId, finishCancellation = false, resultJson, settlement }: {
  runId: string; issueId?: string | null; companyId?: string; agentId: string; finishCancellation?: boolean;
  resultJson?: Record<string, unknown> | null; settlement?: RunStopSettlement | null;
}) {
  const client = useQueryClient();
  const cancel = useMutation({
    retry: false,
    mutationFn: async () => {
      const stopped = await heartbeatsApi.cancel(runId);
      if (!finishCancellation && !readRunStopSettlement(stopped?.resultJson)) {
        await waitForStoppedRuns([runId], { initialRuns: [stopped] });
      }
      return stopped;
    },
    onSettled: async () => {
      const keys = [queryKeys.runDetail(runId),
        ...(companyId ? [queryKeys.heartbeats(companyId, agentId)] : []),
        ...(issueId ? [queryKeys.issues.detail(issueId), queryKeys.issues.runs(issueId),
          queryKeys.issues.liveRuns(issueId), queryKeys.issues.activeRun(issueId)] : [])];
      await Promise.all(keys.map(queryKey => client.invalidateQueries({ queryKey })));
    },
  });
  const supplied = settlement ?? readRunStopSettlement(resultJson);
  const returned = readRunStopSettlement(cancel.data?.resultJson);
  const current = returned && (!supplied?.checkedAt || returned.checkedAt && returned.checkedAt >= supplied.checkedAt) ? returned : supplied;
  const showRecheck = finishCancellation || Boolean(current);
  const settled = current?.state === "settled";
  return <div className="flex flex-col gap-1">
    {current && <p role="status" className="text-xs text-muted-foreground">
      {labels[current.state]}{current.state !== "settled" && current.reason !== "checking_stop" ?
        " · " + (reasons[current.reason] ?? "尚未取得完整停止與清理證據") : ""}
      {current.nextCheckAt && " · 下次檢查 " + new Date(current.nextCheckAt).toLocaleTimeString()}
    </p>}
    {!settled && <Button type="button" variant="outline" size="sm"
      disabled={cancel.isPending || (!showRecheck && cancel.isSuccess)} onClick={() => cancel.mutate()}>
      {cancel.isPending ? (showRecheck ? "檢查中…" : "Cancelling…") : showRecheck ? "重新檢查" : cancel.isSuccess ? "Cancelled" : "Cancel run"}
    </Button>}
    {cancel.error && <p role="alert" className="text-xs text-destructive">
      {cancel.error instanceof Error ? cancel.error.message : "Cancellation could not be confirmed."}
    </p>}
  </div>;
}
