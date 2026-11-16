import { hasMcpBrowserLogin, type McpBrowserLoginResult } from "@paperclipai/shared";
import type { toolConnections } from "@paperclipai/db";
import { badRequest, forbidden, HttpError } from "../../errors.js";
import type { ActorInfo } from "./types.js";
import type { ToolRemoteHttp } from "./remote-http.js";
import type { createConnectionCredentialAccess } from "./credential-access.js";

type Connection = typeof toolConnections.$inferSelect;
type Credentials = ReturnType<typeof createConnectionCredentialAccess>;
const unavailable = () => new HttpError(502, "Browser sign-in is unavailable. Try again from this connection.");

export function createBrowserLogin(deps: {
  getConnectionRow: (id: string) => Promise<Connection>;
  resolveCredentialHeaders: Credentials["resolveCredentialHeaders"];
  resolvedRemoteEndpoint: Credentials["resolvedRemoteEndpoint"];
  requestRemoteHttpEndpoint: ToolRemoteHttp["requestRemoteHttpEndpoint"];
}) {
  return async (id: string, method: "GET" | "POST", actor: ActorInfo): Promise<McpBrowserLoginResult> => {
    if (actor.actorType !== "user") throw forbidden("Browser sign-in requires a human session");
    const connection = await deps.getConnectionRow(id);
    if (!hasMcpBrowserLogin(connection) || !connection.enabled || connection.status !== "active") {
      throw badRequest("Browser sign-in is not enabled for this connection");
    }
    const headers = await deps.resolveCredentialHeaders(connection, actor);
    const endpoint = new URL("./browser-login", await deps.resolvedRemoteEndpoint(connection, actor));
    let response: Response;
    try {
      response = await deps.requestRemoteHttpEndpoint(endpoint, {
        method, headers: { ...headers, Accept: "application/json" },
        signal: AbortSignal.timeout(40_000), redirect: "manual",
      });
    } catch { throw unavailable(); }
    if (!response.ok) {
      await response.body?.cancel().catch(() => undefined);
      throw unavailable();
    }
    const reader = response.body?.getReader();
    if (!reader) throw unavailable();
    const chunks: Uint8Array[] = [];
    let length = 0;
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        length += value.byteLength;
        if (length > 1_000_000) { await reader.cancel(); throw unavailable(); }
        chunks.push(value);
      }
      const value = JSON.parse(Buffer.concat(chunks).toString("utf8")) as Record<string, unknown>;
      if (!["logged_in", "waiting", "unknown"].includes(String(value.status)) || !["browser", "qr"].includes(String(value.mode))) throw unavailable();
      const result: McpBrowserLoginResult = { status: value.status as McpBrowserLoginResult["status"], mode: value.mode as McpBrowserLoginResult["mode"] };
      if (method === "POST" && typeof value.url === "string") {
        const url = new URL(value.url);
        const settings = connection.config.browserLogin as Record<string, unknown>;
        const origins = Array.isArray(settings.allowedOrigins) ? settings.allowedOrigins : [];
        if (!["http:", "https:"].includes(url.protocol) || url.username || url.password || !origins.includes(url.origin)) throw unavailable();
        result.url = url.toString();
      }
      if (method === "POST" && typeof value.qrImage === "string") {
        if (!/^data:image\/png;base64,[A-Za-z0-9+/]+={0,2}$/.test(value.qrImage)) throw unavailable();
        result.qrImage = value.qrImage;
      }
      return result;
    } catch { throw unavailable(); }
    finally { reader.releaseLock(); }
  };
}
