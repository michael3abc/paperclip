import { useEffect, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { dashboardApi, type HostClaudeSession } from "@/api/dashboard";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";

function HostLogin({ companyId, host }: { companyId: string; host: { id: string; label: string; available: boolean } }) {
  const [session, setSession] = useState<HostClaudeSession>();
  const [code, setCode] = useState("");
  const [message, setMessage] = useState("尚未檢查");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const active = !!session && ["starting", "waiting", "verifying"].includes(session.status);
  useEffect(() => {
    if (!session || !active) return;
    // Poll only this explicit five-minute sign-in; stop on terminal state/error.
    const timer = window.setTimeout(() => {
      void dashboardApi.hostClaudeSession(companyId, session.id).then(next => {
        setSession(next);
        if (next.status === "authenticated") setMessage("已登入 Claude 訂閱");
      }).catch(() => { setSession(undefined); setError("無法取得登入狀態；請重新檢查主機。"); });
    }, 1500);
    return () => window.clearTimeout(timer);
  }, [companyId, session, active]);
  async function run(action: () => Promise<void>) {
    setBusy(true); setError("");
    try { await action(); } catch { setError("操作失敗，請確認主機連線或稍後再試。"); } finally { setBusy(false); }
  }
  return <div className="space-y-2 rounded-md border p-3">
    <div className="flex flex-wrap items-center justify-between gap-2">
      <div><p className="text-sm font-medium">{host.label}</p><p className="text-xs text-muted-foreground">{message}</p></div>
      <div className="flex gap-2">
        <Button size="sm" variant="ghost" disabled={busy || active || !host.available} onClick={() => void run(async () => {
          const result = await dashboardApi.checkHostClaude(companyId, host.id);
          setMessage(result.loggedIn === true ? "已登入 Claude 訂閱" : result.loggedIn === false ? "尚未登入 Claude 訂閱" : "無法檢查主機登入狀態");
        })}>檢查狀態</Button>
        <Button size="sm" variant="outline" disabled={busy || active || !host.available} onClick={() => void run(async () => {
          setCode(""); setSession(await dashboardApi.startHostClaude(companyId, host.id));
        })}>登入 Claude</Button>
      </div>
    </div>
    {!host.available && <p className="text-xs text-muted-foreground">此主機尚未設定登入功能</p>}
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

export function HostClaudeLogin({ companyId }: { companyId: string }) {
  const hosts = useQuery({ queryKey: ["host-claude-logins", companyId], queryFn: () => dashboardApi.claudeHosts(companyId), retry: false, staleTime: 60_000 });
  if (hosts.isError) return <p role="alert" className="text-sm text-destructive">無法載入 Claude 主機。</p>;
  if (!hosts.data?.length) return null;
  return <section className="space-y-3" aria-label="主機 Claude 登入">
    <div><h2 className="text-sm font-semibold">主機 Claude 登入</h2><p className="text-xs text-muted-foreground">登入儲存在所選主機，供該主機的 Claude 訂閱使用。</p></div>
    <div className="grid gap-3 md:grid-cols-3">{hosts.data.map(host => <HostLogin key={companyId + host.id} companyId={companyId} host={host} />)}</div>
  </section>;
}
