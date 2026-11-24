import { useEffect, useRef, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Terminal } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import "@xterm/xterm/css/xterm.css";
import type { HostTerminalClientFrame, HostTerminalServerFrame, HostTerminalSession } from "@paperclipai/shared";
import { hostTerminalsApi } from "@/api/host-terminals";
import { useCompany } from "@/context/CompanyContext";
import { useBreadcrumbs } from "@/context/BreadcrumbContext";
import { useHostTerminalAccess } from "@/hooks/useHostTerminalAccess";
import { Button } from "@/components/ui/button";

const reasons: Record<string, string> = {
  idle_timeout: "閒置 30 分鐘，已關閉。", max_duration: "已達 12 小時上限。",
  shell_exit: "Shell 已結束。", client_closed: "連線已關閉。", client_error: "連線中斷。",
  server_shutdown: "伺服器已關閉連線。", invalid_frame: "連線授權或訊框無效。",
  auth_timeout: "連線授權逾時。", startup_failed: "終端啟動失敗。請檢查主機設定。",
  process_error: "終端程序失敗。", input_overflow: "輸入超過連線容量。", output_overflow: "輸出超過連線容量。",
};
const keys = [["Esc", "\x1b"], ["Tab", "\t"], ["Ctrl+C", "\x03"], ["Ctrl+D", "\x04"],
  ["↑", "\x1b[A"], ["↓", "\x1b[B"], ["←", "\x1b[D"], ["→", "\x1b[C"]];
type Tab = { session: HostTerminalSession; hostId: string; label: string };

function TerminalPane({ tab, active, reconnect }: { tab: Tab; active: boolean; reconnect: () => void }) {
  const element = useRef<HTMLDivElement>(null);
  const terminal = useRef<Terminal | null>(null);
  const socket = useRef<WebSocket | null>(null);
  const fit = useRef<() => void>(() => {});
  const [state, setState] = useState("連線中…");
  const [closed, setClosed] = useState(false);
  const send = (frame: HostTerminalClientFrame) => {
    if (socket.current?.readyState === WebSocket.OPEN) socket.current.send(JSON.stringify(frame));
  };
  useEffect(() => {
    const node = element.current!;
    const style = getComputedStyle(node);
    const term = new Terminal({ cursorBlink: true, scrollback: 1000,
      fontFamily: style.fontFamily, theme: {
        background: style.getPropertyValue("--host-terminal-background").trim(),
        foreground: style.getPropertyValue("--host-terminal-foreground").trim(),
        cursor: style.getPropertyValue("--host-terminal-foreground").trim(),
      } });
    term.options.fontSize = Number.parseFloat(style.fontSize);
    const addon = new FitAddon(); term.loadAddon(addon); term.open(node);
    terminal.current = term;
    const url = new URL(tab.session.wsPath, window.location.href);
    url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
    const ws = new WebSocket(url); socket.current = ws;
    let mounted = true, ready = false, reasonReceived = false;
    fit.current = () => {
      if (!node.clientWidth || !node.clientHeight) return;
      addon.fit();
      if (ready) send({ type: "resize", cols: Math.min(500, Math.max(2, term.cols)), rows: Math.min(300, Math.max(1, term.rows)) });
    };
    const observer = new ResizeObserver(() => fit.current()); observer.observe(node);
    const input = term.onData(data => { if (ready) send({ type: "input", data }); });
    ws.onopen = () => send({ type: "auth", sessionId: tab.session.id, token: tab.session.token });
    ws.onmessage = event => {
      if (!mounted) return;
      try {
        const frame: HostTerminalServerFrame = JSON.parse(event.data);
        if (frame.type === "ready") { ready = true; setState("已連線"); fit.current(); if (node.clientWidth && node.clientHeight) term.focus(); }
        else if (frame.type === "output") term.write(frame.data);
        else if (frame.type === "closed") {
          ready = false; reasonReceived = true; setClosed(true);
          setState(`${reasons[frame.reason] ?? "終端已關閉。"}${frame.exitCode !== null ? ` (exit ${frame.exitCode})` : ""}`);
        }
      } catch { ready = false; reasonReceived = true; setClosed(true); setState("終端傳回無效訊框。"); ws.close(); }
    };
    ws.onerror = () => { if (mounted && !reasonReceived) { setClosed(true); setState("連線失敗，請重新連線。"); } };
    ws.onclose = () => { ready = false; if (mounted && !reasonReceived) { setClosed(true); setState("連線已中斷；重新連線會開啟新 shell。"); } };
    return () => {
      mounted = false; observer.disconnect(); input.dispose(); ws.close(1000, "operator_closed");
      term.dispose(); terminal.current = null; socket.current = null;
    };
  }, [tab.session]);
  useEffect(() => { if (active) { fit.current(); terminal.current?.focus(); } }, [active]);
  return <section hidden={!active} aria-label={tab.label} className="space-y-3">
    <div className="flex items-center gap-3"><p role="status" className="text-sm text-muted-foreground">{state}</p>
      {closed && <Button variant="outline" size="sm" onClick={reconnect}>重新連線</Button>}</div>
    <div ref={element} className="h-(--host-terminal-height) w-full overflow-hidden rounded-md bg-(--host-terminal-background) p-2 font-mono text-base" />
    <div className="flex gap-1 overflow-x-auto sm:hidden" aria-label="終端快捷鍵">
      {keys.map(([label, data]) => <Button key={label} variant="outline" size="sm" disabled={closed}
        onPointerDown={event => event.preventDefault()} onClick={() => { send({ type: "input", data }); terminal.current?.focus(); }}>{label}</Button>)}
    </div>
  </section>;
}

function CompanyTerminals({ companyId }: { companyId: string }) {
  const hosts = useQuery({ queryKey: ["host-terminals", companyId], queryFn: () => hostTerminalsApi.list(companyId), retry: false });
  const [tabs, setTabs] = useState<Tab[]>([]), [active, setActive] = useState<string | null>(null);
  const [opening, setOpening] = useState(false), [error, setError] = useState<string | null>(null);
  const mounted = useRef(true);
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);
  async function open(hostId: string, label: string, replace?: string) {
    setOpening(true); setError(null);
    try {
      const session = await hostTerminalsApi.create(companyId, hostId);
      if (!mounted.current) return;
      setTabs(tabs => [...tabs.filter(tab => tab.session.id !== replace), { session, hostId, label }]);
      setActive(session.id);
    } catch (error) { if (mounted.current) setError(error instanceof Error ? error.message : "無法開啟終端。"); }
    finally { if (mounted.current) setOpening(false); }
  }
  function close(id: string) {
    const remaining = tabs.filter(tab => tab.session.id !== id); setTabs(remaining);
    if (active === id) setActive(remaining.at(-1)?.session.id ?? null);
  }
  return <div className="space-y-4">
    <h1 className="text-xl font-semibold">主機終端</h1>
    <p className="text-sm text-muted-foreground">關閉分頁會結束 shell；長駐工作請使用 tmux。閒置 30 分鐘或連線滿 12 小時會關閉，每人最多 4 個。</p>
    {hosts.isPending && <p role="status">載入主機…</p>}
    {hosts.error && <div role="alert" className="text-destructive">{hosts.error.message} <Button variant="outline" onClick={() => void hosts.refetch()}>重試</Button></div>}
    {hosts.data?.length === 0 && <p>沒有啟用終端的主機。請管理員在主機 registry 啟用 terminal。</p>}
    <div className="flex flex-wrap gap-2">{hosts.data?.map(host => <Button key={host.id} variant="outline" disabled={opening || tabs.length >= 4}
      onClick={() => void open(host.id, host.label)}>{host.label}：開啟終端</Button>)}</div>
    {error && <p role="alert" className="text-destructive">{error}</p>}
    <div role="tablist" aria-label="主機終端分頁" className="flex gap-2 overflow-x-auto">
      {tabs.map((tab, index) => <div key={tab.session.id} className="flex shrink-0 items-center gap-1">
        <Button role="tab" id={`terminal-tab-${tab.session.id}`} aria-controls={`terminal-panel-${tab.session.id}`}
          aria-selected={active === tab.session.id} variant={active === tab.session.id ? "secondary" : "ghost"}
          onClick={() => setActive(tab.session.id)}>{tab.label} {index + 1}</Button>
        <Button variant="ghost" size="sm" aria-label={`關閉 ${tab.label} ${index + 1}`} onClick={() => close(tab.session.id)}>×</Button>
      </div>)}
    </div>
    {tabs.map(tab => <div key={tab.session.id} role="tabpanel" id={`terminal-panel-${tab.session.id}`} aria-labelledby={`terminal-tab-${tab.session.id}`} hidden={active !== tab.session.id}>
      <TerminalPane tab={tab} active={active === tab.session.id} reconnect={() => { if (!opening) void open(tab.hostId, tab.label, tab.session.id); }} />
    </div>)}
  </div>;
}

export function HostTerminals() {
  const { selectedCompanyId } = useCompany();
  const access = useHostTerminalAccess(selectedCompanyId);
  const { setBreadcrumbs } = useBreadcrumbs();
  useEffect(() => { setBreadcrumbs([{ label: "Settings", href: "/company/settings" }, { label: "主機終端" }]); }, [setBreadcrumbs]);
  if (!selectedCompanyId) return <p>請選擇公司。</p>;
  if (access.pending) return <p role="status">檢查權限…</p>;
  if (access.error) return <p role="alert" className="text-destructive">{access.error.message}</p>;
  if (!access.allowed) return <p>僅已登入的 instance admin 可使用主機終端。</p>;
  return <CompanyTerminals key={`${selectedCompanyId}:${access.userId}`} companyId={selectedCompanyId} />;
}
