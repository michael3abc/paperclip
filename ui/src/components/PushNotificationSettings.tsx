import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { PUSH_CATEGORIES, type PushCategory, type PushPreferences } from "@paperclipai/shared";
import { pushApi } from "@/api/push";
import { clearLocalPush, currentPushBinding, disableWebPush, enableWebPush, pushSupportMessage } from "@/lib/web-push";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
const labels: Record<PushCategory, string> = { approval: "待批准", question: "待回答", completed: "任務完成",
  problem: "失敗／阻塞", chat: "聊天回覆／主動訊息", progress: "一般任務進度", subtask: "子任務變動" };
const statuses: Record<string, string> = { queued: "等待送出／重試", sending: "傳送中", submitted: "已送交推播服務", failed: "傳送失敗", cancelled: "已取消" };
export function PushNotificationSettings({ userId, companyId }: { userId: string; companyId: string | null }) {
  const client = useQueryClient();
  const key = ["push", userId];
  const query = useQuery({ queryKey: key, queryFn: async () => {
    const settings = await pushApi.get();
    if (settings.userId !== userId) throw new Error("帳號已變更，請重新整理通知設定。");
    return settings;
  }, retry: false });
  const [name, setName] = useState("我的裝置");
  const [message, setMessage] = useState<string | null>(null);
  const action = useMutation({ mutationFn: (work: () => Promise<unknown>) => work(), retry: false,
    onSuccess: async () => { await client.invalidateQueries({ queryKey: key }); },
  });
  const data = query.data;
  let binding: ReturnType<typeof currentPushBinding> = null;
  let localError: string | null = null;
  try { binding = currentPushBinding(); } catch (error) { localError = String(error); }
  const local = binding?.userId === userId ? binding.subscriptionId : null;
  const active = data?.devices.some(d => d.id === local && d.active);
  const unsupported = pushSupportMessage();
  const save = (preferences: PushPreferences) => action.mutate(() => pushApi.preferences(companyId!, userId, preferences));
  return <Card className="space-y-4 p-4">
    <h2 className="text-base font-semibold">推播通知</h2>
    <p className="text-sm text-muted-foreground">分類設定會同步到此帳號的所有已訂閱裝置。通知顯示標題與內容摘要。</p>
    {(query.error || action.error || localError) && <p role="alert" className="text-sm text-destructive">{localError ?? (query.error ?? action.error)?.message}</p>}
    {message && <p role="status" className="text-sm">{message}</p>}
    {!companyId && <p className="text-sm text-muted-foreground">請先選擇公司。</p>}
    {data && <>
      {!data.configured && <p role="status" className="text-sm text-muted-foreground">伺服器尚未設定推播服務。</p>}
      <label className="flex items-center gap-2 text-sm"><input type="checkbox" checked={data.preferences.enabled}
        disabled={!companyId || action.isPending} onChange={e => save({ ...data.preferences, enabled: e.target.checked })} />啟用此帳號推播通知</label>
      <div className="grid gap-2 sm:grid-cols-2">{PUSH_CATEGORIES.map(category => <label key={category} className="flex items-center gap-2 text-sm">
        <input type="checkbox" checked={data.preferences.categories[category]} disabled={!companyId || action.isPending}
          onChange={e => save({ ...data.preferences, categories: { ...data.preferences.categories, [category]: e.target.checked } })} />{labels[category]}
      </label>)}</div>
      <p className="text-sm text-muted-foreground">只通知與你相關且有權查看的工作。一般進度與子任務更新會合併 30 秒；重要事件與聊天即時排送。</p>
      {unsupported && <p role="status" className="text-sm text-muted-foreground">{unsupported}</p>}
      <Input aria-label="通知裝置名稱" value={name} onChange={e => setName(e.target.value)} maxLength={80} />
      <div className="flex flex-wrap gap-2">
        <Button disabled={!companyId || !data.configured || !!unsupported || action.isPending || !name.trim()} onClick={() => action.mutate(async () => {
          await enableWebPush(userId, companyId!, data.publicKey!, name.trim()); setMessage("此裝置已啟用通知，可發送測試通知確認。");
        })}>{active ? "重新確認此裝置" : "啟用此裝置"}</Button>
        <Button variant="outline" disabled={!binding || action.isPending} onClick={() => action.mutate(async () => {
          if (binding?.userId === userId) await disableWebPush(); else await clearLocalPush(); setMessage("此裝置已停用通知。");
        })}>停用此裝置</Button>
        <Button variant="outline" disabled={!companyId || !active || !data.configured || !data.preferences.enabled || action.isPending} onClick={() => action.mutate(async () => {
          await pushApi.test(companyId!, userId, local!); setMessage("測試通知已排入佇列。請確認手機通知，再按重新整理查看投遞狀態。");
        })}>發送測試通知</Button>
      </div>
      <ul className="space-y-2">{data.devices.map(device => <li key={device.id} className="flex items-center justify-between gap-2 text-sm">
        <span>{device.name}{device.id === local ? "（此裝置）" : ""} · {device.active ? "已啟用" : "已停用"}</span>
        {device.active && <Button size="sm" variant="ghost" disabled={!companyId || action.isPending} onClick={() => action.mutate(async () => {
          await pushApi.remove(companyId!, userId, device.id); if (device.id === local) await clearLocalPush();
        })}>停用</Button>}
      </li>)}</ul>
      <div className="flex items-center justify-between"><h3 className="text-sm font-medium">最近投遞</h3><Button variant="ghost" size="sm" disabled={query.isFetching} onClick={() => void query.refetch()}>重新整理</Button></div>
      <ul className="space-y-2">{data.recent.map(row => <li key={row.id} className="text-sm">
        {row.category === "test" ? "測試通知" : labels[row.category]} · {statuses[row.status] ?? row.status} · 嘗試 {row.attempts} 次
        {row.error && <span className="text-muted-foreground"> · {row.error}{row.status === "queued" ? ` · 下次 ${new Date(row.nextAttemptAt).toLocaleTimeString()}` : ""}</span>}
      </li>)}</ul>
    </>}
  </Card>;
}
