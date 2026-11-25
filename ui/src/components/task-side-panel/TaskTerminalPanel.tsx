import { useLayoutEffect, useRef } from "react";
import { Button } from "@/components/ui/button";
import { HostTerminalKeys } from "@/components/host-terminal/HostTerminalKeys";
import { openHostTerminal, useHostTerminals } from "@/lib/host-terminal-store";

export function TaskTerminalPanel({ terminalId, companyId, userId, canOpen, hostId, label }: {
  terminalId: string; companyId: string; userId: string | null; canOpen: boolean; hostId: string; label: string;
}) {
  const terminal = useHostTerminals().find(item => item.id === terminalId && item.companyId === companyId && item.userId === userId);
  const connection = terminal?.connection ?? null;
  const element = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    const node = element.current;
    if (!node || !connection) return;
    connection.attach(node);
    return () => connection.detach(node);
  }, [connection]);
  // A reload ends the shell. Opening another one is always the person's action.
  const closed = !terminal || terminal.phase === "closed";
  return <section aria-label={label} className="flex h-full min-h-0 flex-col gap-2 p-2">
    {terminal?.phase === "ready" ? null : <div className="flex shrink-0 items-center gap-3">
      <p role="status" className="text-sm text-muted-foreground">{terminal?.message ?? "這個終端已結束。"}</p>
      {closed && canOpen && userId ? <Button variant="outline" size="sm"
        onClick={() => { openHostTerminal({ companyId, userId, hostId, label }, terminalId); }}>開啟新 shell</Button> : null}
    </div>}
    <div ref={element} className="min-h-0 w-full flex-1 overflow-hidden rounded-md bg-(--host-terminal-background) p-2 font-mono text-sm" />
    <HostTerminalKeys disabled={closed} onKey={data => { connection?.input(data); connection?.focus(); }} />
  </section>;
}
