import { useEffect, useRef, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import type { HostTerminalSession } from "@paperclipai/shared";
import { hostTerminalsApi } from "@/api/host-terminals";
import { useCompany } from "@/context/CompanyContext";
import { useBreadcrumbs } from "@/context/BreadcrumbContext";
import { useHostTerminalAccess } from "@/hooks/useHostTerminalAccess";
import { Button } from "@/components/ui/button";
import { HostTerminalKeys } from "@/components/host-terminal/HostTerminalKeys";
import { HostTerminalConnection, type HostTerminalStatus } from "@/lib/host-terminal-connection";

type Tab = { session: HostTerminalSession; hostId: string; label: string };

function TerminalPane({ tab, active, reconnect }: { tab: Tab; active: boolean; reconnect: () => void }) {
  const element = useRef<HTMLDivElement>(null);
  const connection = useRef<HostTerminalConnection | null>(null);
  const [status, setStatus] = useState<HostTerminalStatus>({ phase: "connecting", message: "連線中…" });
  useEffect(() => {
    const current = new HostTerminalConnection(tab.session, setStatus);
    connection.current = current;
    current.attach(element.current!);
    return () => { current.dispose(); connection.current = null; };
  }, [tab.session]);
  useEffect(() => { if (active) connection.current?.focus(); }, [active]);
  const closed = status.phase === "closed";
  return <section hidden={!active} aria-label={tab.label} className="space-y-3">
    <div className="flex items-center gap-3"><p role="status" className="text-sm text-muted-foreground">{status.message}</p>
      {closed && <Button variant="outline" size="sm" onClick={reconnect}>重新連線</Button>}</div>
    <div ref={element} className="h-(--host-terminal-height) w-full overflow-hidden rounded-md bg-(--host-terminal-background) p-2 font-mono text-base" />
    <HostTerminalKeys disabled={closed} onKey={data => { connection.current?.input(data); connection.current?.focus(); }} />
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
