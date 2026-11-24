/** Human-only host terminal API. Tokens and terminal contents are ephemeral. */
export interface HostTerminalHost { id: string; label: string }
export interface HostTerminalSession {
  id: string;
  token: string;
  expiresAt: string;
  wsPath: string;
}
export type HostTerminalClientFrame =
  | { type: "auth"; sessionId: string; token: string }
  | { type: "input"; data: string }
  | { type: "resize"; cols: number; rows: number };
export type HostTerminalServerFrame =
  | { type: "ready" }
  | { type: "output"; data: string }
  | { type: "closed"; reason: string; exitCode: number | null };
