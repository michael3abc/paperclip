import { useEffect, useState, type ReactNode } from "react";
import { useQueries, useQuery, useQueryClient } from "@tanstack/react-query";
import { dashboardApi, type HostClaudeSession } from "@/api/dashboard";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";

function HostLogin({ companyId, host, onAuthenticated }: {
  companyId: string;
  host: { id: string; label: string };
  onAuthenticated: () => void;
}) {
  const [session, setSession] = useState<HostClaudeSession>();
  const [code, setCode] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const active = !!session && ["starting", "waiting", "verifying"].includes(session.status);
  useEffect(() => {
    if (session?.status === "authenticated") onAuthenticated();
  }, [session, onAuthenticated]);
  useEffect(() => {
    if (!session || !active) return;
    // Poll only this explicit five-minute sign-in; stop on terminal state/error.
    const timer = window.setTimeout(() => {
      void dashboardApi.hostClaudeSession(companyId, session.id).then(next => {
        setSession(next);
      }).catch(() => { setSession(undefined); setError("無法取得登入狀態；請重新檢查主機。"); });
    }, 1500);
    return () => window.clearTimeout(timer);
  }, [companyId, session, active]);
  async function run(action: () => Promise<void>) {
    setBusy(true); setError("");
    try { await action(); } catch { setError("操作失敗，請確認主機連線或稍後再試。"); } finally { setBusy(false); }
  }
  return <div className="space-y-3" aria-label={`${host.label} Claude 登入`}>
    <div className="space-y-1">
      <p className="text-sm font-medium">{host.label} 尚未登入</p>
      <p className="text-xs text-muted-foreground">登入 Claude 訂閱後即可查看配額。</p>
    </div>
    {!active && <div className="flex flex-wrap gap-2">
        <Button size="sm" disabled={busy} onClick={() => void run(async () => {
          setCode(""); setSession(await dashboardApi.startHostClaude(companyId, host.id));
        })}>登入 Claude</Button>
        <Button size="sm" variant="ghost" disabled={busy} onClick={() => void run(async () => {
          const result = await dashboardApi.checkHostClaude(companyId, host.id);
          if (result.loggedIn === true) onAuthenticated();
          if (result.loggedIn === null) setError("無法檢查主機登入狀態");
        })}>檢查狀態</Button>
    </div>}
    {active && <div className="space-y-2">
      <p className="text-xs text-muted-foreground">{session.status === "starting" ? "正在建立登入連結…" : session.status === "verifying" ? "正在驗證登入…" : "開啟授權頁完成登入，再貼回頁面顯示的驗證碼。連結五分鐘內有效。"}</p>
      {session.authorizationUrl && <a className="inline-block text-sm underline" href={session.authorizationUrl} target="_blank" rel="noopener noreferrer" referrerPolicy="no-referrer">開啟 Claude 授權頁 ↗</a>}
      {session.status === "waiting" && <form className="flex flex-wrap gap-2" onSubmit={event => {
        event.preventDefault(); const submittedCode = code.trim(); setCode("");
        void run(async () => { setSession(await dashboardApi.hostClaudeAction(companyId, session.id, "code", submittedCode)); });
      }}>
        <Input className="min-w-0 flex-1" type="password" aria-label={`${host.label} Claude 驗證碼`} placeholder="貼上驗證碼" autoComplete="off" value={code} onChange={event => setCode(event.target.value)} />
        <Button size="sm" disabled={busy || !code.trim()}>送出驗證碼</Button>
      </form>}
      <Button size="sm" variant="ghost" disabled={busy} onClick={() => void run(async () => {
        setCode(""); setSession(await dashboardApi.hostClaudeAction(companyId, session.id, "cancel"));
      })}>取消登入</Button>
    </div>}
    {session?.status === "failed" && <p role="alert" className="text-xs text-destructive">登入失敗或已逾時，請重新登入。</p>}
    {error && <p role="alert" className="text-xs text-destructive">{error}</p>}
  </div>;
}

export function HostClaudeLogin({ companyId, children }: { companyId: string; children: ReactNode }) {
  const client = useQueryClient();
  const hosts = useQuery({ queryKey: ["host-claude-logins", companyId], queryFn: () => dashboardApi.claudeHosts(companyId), retry: false, staleTime: 60_000 });
  const enabledHosts = hosts.data?.filter(host => host.available) ?? [];
  const statuses = useQueries({ queries: enabledHosts.map(host => ({
    queryKey: ["host-claude-status", companyId, host.id],
    queryFn: () => dashboardApi.checkHostClaude(companyId, host.id),
    retry: false, staleTime: 60_000, refetchInterval: 60_000, refetchIntervalInBackground: false,
  })) });
  const loggedOut = enabledHosts.filter((_, index) => statuses[index].data?.loggedIn === false && !statuses[index].isError);
  const unknown = hosts.isError || statuses.some(status => status.isError || status.data?.loggedIn === null);
  return <>
    {loggedOut.length ? <div className="space-y-6">{loggedOut.map(host => <HostLogin key={host.id} companyId={companyId} host={host} onAuthenticated={() => {
      client.setQueryData(["host-claude-status", companyId, host.id], { loggedIn: true });
      void client.invalidateQueries({ queryKey: ["dashboard-subscription-quotas", companyId] });
    }} />)}</div> : children}
    {unknown && <p role="alert" className="text-xs text-destructive">無法確認 Claude 主機登入狀態，請重新整理。</p>}
  </>;
}
