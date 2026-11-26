import { useEffect, useRef, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { hasMcpBrowserLogin, type McpBrowserLoginResult, type ToolConnection } from "@paperclipai/shared";
import { toolsApi } from "@/api/tools";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";

export function McpBrowserLogin({ connection, canConfigure }: { connection: ToolConnection; canConfigure: boolean }) {
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [startedAt, setStartedAt] = useState(0);
  const [ticket, setTicket] = useState<McpBrowserLoginResult | null>(null);
  const [error, setError] = useState<string | null>(null);
  const attempt = useRef(0);
  useEffect(() => () => { attempt.current++; }, []);
  const enabled = hasMcpBrowserLogin(connection) && canConfigure;
  const status = useQuery({
    queryKey: ["tools", "browser-login", connection.id],
    queryFn: () => toolsApi.browserLoginStatus(connection.id),
    enabled,
    retry: false,
    // Poll only an active, visible login attempt, for at most five minutes.
    refetchInterval: (query) => open && !busy && !error && Date.now() - startedAt < 300_000
      && query.state.data?.status !== "logged_in" && !query.state.error ? 2_000 : false,
    refetchIntervalInBackground: false,
    refetchOnWindowFocus: false,
  });
  if (!hasMcpBrowserLogin(connection)) return null;
  const loggedIn = status.data?.status === "logged_in";
  const close = (value: boolean) => {
    setOpen(value);
    if (!value) { attempt.current++; setBusy(false); setTicket(null); setError(null); }
  };
  const start = async () => {
    const generation = ++attempt.current;
    const popup = status.data?.mode === "browser" ? window.open("about:blank", "_blank") : null;
    if (popup) popup.opener = null;
    setBusy(true); setError(null); setTicket(null); setStartedAt(Date.now()); setOpen(true);
    try {
      const result = await toolsApi.startBrowserLogin(connection.id);
      if (generation !== attempt.current) { popup?.close(); return; }
      if (result.url) {
        const url = new URL(result.url);
        const settings = connection.config?.browserLogin as Record<string, unknown>;
        const origins = Array.isArray(settings.allowedOrigins) ? settings.allowedOrigins : [];
        if (!["http:", "https:"].includes(url.protocol) || url.username || url.password || !origins.includes(url.origin)) {
          throw new Error("登入服務回傳了無效的登入網址。");
        }
        if (popup) popup.location.replace(url.toString());
      } else popup?.close();
      setTicket(result);
      await status.refetch();
    } catch (cause) {
      popup?.close();
      if (generation === attempt.current) setError(cause instanceof Error ? cause.message : "無法開啟登入，請重試。");
    } finally { if (generation === attempt.current) setBusy(false); }
  };
  return <section className="space-y-3" aria-label="帳號登入">
    <div className="flex flex-wrap items-center justify-between gap-3">
      <div className="space-y-1">
        <h3 className="text-sm font-medium">帳號登入</h3>
        <p className="text-sm text-muted-foreground">在此登入你的 {connection.name} 帳號。</p>
      </div>
      <Badge variant="outline">{!canConfigure ? "需要連線管理權限" : status.isPending ? "檢查中" : status.isError ? "無法確認" : loggedIn ? "已登入" : status.data?.status === "waiting" ? "等待登入" : "未確認"}</Badge>
    </div>
    <div className="flex flex-wrap gap-2">
      <Button disabled={!canConfigure || busy || status.isPending} onClick={() => void start()}>{busy ? "開啟中…" : "登入帳號"}</Button>
      <Button variant="outline" disabled={!canConfigure || busy || status.isFetching} onClick={() => void status.refetch()}>檢查登入狀態</Button>
    </div>
    {status.error && <p role="alert" className="text-sm text-destructive">{status.error.message}</p>}
    <Dialog open={open} onOpenChange={close}>
      <DialogContent className="max-w-lg">
        <DialogHeader>
          <DialogTitle>{connection.name} 帳號登入</DialogTitle>
          <DialogDescription>{loggedIn ? "已確認登入成功，可以關閉此視窗。" : ticket?.mode === "qr" ? "使用連線服務的手機 App 掃描 QR Code，並在手機上確認登入。" : "請在開啟的瀏覽器視窗完成官方網站登入。"}</DialogDescription>
        </DialogHeader>
        {busy && <p role="status">正在準備登入…</p>}
        {error && <p role="alert" className="text-sm text-destructive">{error}</p>}
        {!loggedIn && ticket?.qrImage && <img className="mx-auto max-h-[55vh] max-w-full object-contain" src={ticket.qrImage} alt="連線服務登入 QR Code" />}
        {!loggedIn && ticket?.url && <Button asChild variant="outline"><a href={ticket.url} target="_blank" rel="noopener noreferrer">開啟登入視窗</a></Button>}
        {status.error && <p role="alert" className="text-sm text-destructive">{status.error.message}</p>}
        <div className="flex justify-end gap-2">
          {!busy && !loggedIn && <Button variant="outline" onClick={() => void start()}>重新取得登入</Button>}
          <Button variant={loggedIn ? "default" : "outline"} onClick={() => close(false)}>{loggedIn ? "完成" : "關閉"}</Button>
        </div>
      </DialogContent>
    </Dialog>
  </section>;
}
