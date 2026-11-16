/** Human-only browser sign-in, separate from an MCP transport credential. */
export interface McpBrowserLoginResult {
  status: "logged_in" | "waiting" | "unknown";
  mode: "browser" | "qr";
  url?: string;
  qrImage?: string;
}

export function hasMcpBrowserLogin(connection: { transport?: string; config?: Record<string, unknown> }): boolean {
  const value = connection.config?.browserLogin;
  return connection.transport === "mcp_remote" && !!value && typeof value === "object"
    && (value as Record<string, unknown>).enabled === true;
}
