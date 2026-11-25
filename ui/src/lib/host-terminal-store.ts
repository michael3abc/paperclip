import { useSyncExternalStore } from "react";
import { hostTerminalsApi } from "@/api/host-terminals";
import type { HostTerminalConnection, HostTerminalStatus } from "./host-terminal-connection";

/**
 * Terminals opened from a chat or task side panel. They live above routes, so
 * switching conversations or hiding the panel keeps the shell running. Closing
 * the tab, reloading, or changing the signed-in account ends it.
 */
export interface OpenHostTerminal extends HostTerminalStatus {
  id: string;
  companyId: string;
  userId: string;
  hostId: string;
  label: string;
  connection: HostTerminalConnection | null;
}
type OpenInput = Pick<OpenHostTerminal, "companyId" | "userId" | "hostId" | "label">;

let terminals: readonly OpenHostTerminal[] = [];
const listeners = new Set<() => void>();
/** The current opening per tab; a superseded or closed one must not connect. */
const attempts = new Map<string, symbol>();

function publish(next: readonly OpenHostTerminal[]) {
  terminals = next;
  for (const listener of listeners) listener();
}
function patch(id: string, changes: Partial<OpenHostTerminal>) {
  publish(terminals.map(item => item.id === id ? { ...item, ...changes } : item));
}

export function subscribeHostTerminals(listener: () => void) {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
}
export const getHostTerminals = () => terminals;
export function useHostTerminals() {
  return useSyncExternalStore(subscribeHostTerminals, getHostTerminals);
}
export const hasLiveHostTerminal = () => terminals.some(terminal => terminal.phase !== "closed");

/** Open a shell. Reusing an id replaces that tab's ended shell with a new one. */
export function openHostTerminal(input: OpenInput, id = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`) {
  closeHostTerminal(id);
  const entry: OpenHostTerminal = { ...input, id, phase: "connecting", message: "連線中…", connection: null };
  const attempt = Symbol(id);
  attempts.set(id, attempt);
  publish([...terminals, entry]);
  const current = () => attempts.get(id) === attempt;
  void (async () => {
    try {
      const { HostTerminalConnection } = await import("./host-terminal-connection");
      if (!current()) return;
      const session = await hostTerminalsApi.create(input.companyId, input.hostId);
      if (!current()) return;
      const connection = new HostTerminalConnection(session, status => { if (current()) patch(id, status); });
      patch(id, { connection });
    } catch (error) {
      if (current()) patch(id, { phase: "closed", message: error instanceof Error ? error.message : "無法開啟終端。" });
    }
  })();
  return id;
}

export function closeHostTerminal(id: string) {
  attempts.delete(id);
  const entry = terminals.find(terminal => terminal.id === id);
  if (!entry) return;
  publish(terminals.filter(terminal => terminal.id !== id));
  entry.connection?.dispose();
}

/** The signed-in account changed: nobody else may see or use these shells. */
export function retainHostTerminalsOf(userId: string | null) {
  for (const terminal of terminals) if (terminal.userId !== userId) closeHostTerminal(terminal.id);
}
