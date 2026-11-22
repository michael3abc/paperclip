import { useEffect, useState, type ReactNode } from "react";
import { useQueries, useQuery, useQueryClient } from "@tanstack/react-query";
import { dashboardApi, type HostCodexSession } from "@/api/dashboard";
import { Button } from "@/components/ui/button";

function HostLogin({ companyId, host, onAuthenticated }: {
  companyId: string;
  host: { id: string; label: string };
  onAuthenticated: () => void;
}) {
  const [session, setSession] = useState<HostCodexSession>();
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [copied, setCopied] = useState(false);
  const [pollFailed, setPollFailed] = useState(false);
  const active = !!session && ["starting", "waiting", "verifying"].includes(session.status);
  useEffect(() => {
    if (session?.status === "authenticated") onAuthenticated();
  }, [session, onAuthenticated]);
  useEffect(() => {
    if (!session || !active) return;
    const timer = window.setTimeout(() => {
      setSession({ ...session, status: "failed", verificationUrl: undefined, userCode: undefined });
    }, Math.max(0, Date.parse(session.expiresAt) - Date.now()));
    return () => window.clearTimeout(timer);
  }, [session, active]);
  useEffect(() => {
    if (!session || !active || pollFailed) return;
    // Only this explicit ten-minute login is polled, while visible. Native
    // device authorization has no server event; stop on error/terminal/unmount.
    let timer: number | undefined;
    let disposed = false;
    const schedule = () => {
      window.clearTimeout(timer);
      if (document.hidden) return;
      timer = window.setTimeout(() => {
        void dashboardApi.hostCodexSession(companyId, session.id).then(next => {
          if (!disposed) setSession(next);
        }).catch(() => {
          if (!disposed) {
            setPollFailed(true);
            setError("無法取得登入狀態；請取消登入後重新檢查主機。");
          }
        });
      }, 1500);
    };
    schedule();
    document.addEventListener("visibilitychange", schedule);
    return () => { disposed = true; window.clearTimeout(timer); document.removeEventListener("visibilitychange", schedule); };
  }, [companyId, session, active, pollFailed]);
  async function run(action: () => Promise<void>) {
    setBusy(true); setError("");
    try { await action(); } catch { setError("操作失敗，請確認主機連線或稍後再試。"); } finally { setBusy(false); }
  }
  return <div className="space-y-3" aria-label={`${host.label} Codex 登入`}>
    <div className="space-y-1">
      <p className="text-sm font-medium">{host.label} 尚未登入</p>
      <p className="text-xs text-muted-foreground">登入 Codex 訂閱後即可查看配額。</p>
    </div>
    {!active && <div className="flex flex-wrap gap-2">
      <Button size="sm" disabled={busy} onClick={() => void run(async () => {
        setCopied(false); setPollFailed(false); setSession(await dashboardApi.startHostCodex(companyId, host.id));
      })}>登入 Codex</Button>
      <Button size="sm" variant="ghost" disabled={busy} onClick={() => void run(async () => {
        const result = await dashboardApi.checkHostCodex(companyId, host.id);
        if (result.loggedIn === true) onAuthenticated();
        if (result.loggedIn === null) setError("無法檢查主機登入狀態");
      })}>檢查狀態</Button>
    </div>}
    {active && <div className="space-y-2">
      <p className="text-xs text-muted-foreground">{session.status === "starting" ? "正在建立登入連結…" : session.status === "verifying" ? "正在驗證登入…" : "在頁面輸入這組代碼，完成後這裡會自動更新；10 分鐘內有效"}</p>
      {session.status === "waiting" && <>
        {session.verificationUrl && <a className="inline-block text-sm underline" href={session.verificationUrl} target="_blank" rel="noopener noreferrer" referrerPolicy="no-referrer">開啟 OpenAI 裝置登入頁 ↗</a>}
        {session.userCode && <div className="flex flex-wrap items-center gap-2">
          <code className="font-mono text-2xl font-semibold">{session.userCode}</code>
          <Button size="sm" variant="ghost" disabled={busy} onClick={() => void run(async () => {
            await navigator.clipboard.writeText(session.userCode!); setCopied(true);
          })}>{copied ? "已複製" : "複製代碼"}</Button>
        </div>}
      </>}
      <Button size="sm" variant="ghost" disabled={busy} onClick={() => void run(async () => {
        setSession(await dashboardApi.cancelHostCodex(companyId, session.id));
      })}>取消登入</Button>
    </div>}
    {session?.status === "failed" && <p role="alert" className="text-xs text-destructive">登入失敗或已逾時，請重新登入。</p>}
    {error && <p role="alert" className="text-xs text-destructive">{error}</p>}
  </div>;
}

export function HostCodexLogin({ companyId, children }: { companyId: string; children: ReactNode }) {
  const client = useQueryClient();
  const hosts = useQuery({ queryKey: ["host-codex-logins", companyId], queryFn: () => dashboardApi.codexHosts(companyId), retry: false, staleTime: 60_000 });
  const enabledHosts = hosts.data?.filter(host => host.available) ?? [];
  const statuses = useQueries({ queries: enabledHosts.map(host => ({
    queryKey: ["host-codex-status", companyId, host.id],
    queryFn: () => dashboardApi.checkHostCodex(companyId, host.id),
    retry: false, staleTime: 60_000, refetchInterval: 60_000, refetchIntervalInBackground: false,
  })) });
  const loggedOut = enabledHosts.filter((_, index) => statuses[index].data?.loggedIn === false && !statuses[index].isError);
  const unknown = hosts.isError || statuses.some(status => status.isError || status.data?.loggedIn === null);
  return <>
    {loggedOut.length ? <div className="space-y-6">{loggedOut.map(host => <HostLogin key={host.id} companyId={companyId} host={host} onAuthenticated={() => {
      client.setQueryData(["host-codex-status", companyId, host.id], { loggedIn: true });
      void client.invalidateQueries({ queryKey: ["dashboard-subscription-quotas", companyId] });
    }} />)}</div> : children}
    {unknown && <p role="alert" className="text-xs text-destructive">無法確認 Codex 主機登入狀態，請重新整理。</p>}
  </>;
}
