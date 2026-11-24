import type { IncomingMessage, Server } from "node:http";
import type { Duplex } from "node:stream";
import { createRequire } from "node:module";
import { and, eq } from "drizzle-orm";
import { companyMemberships, instanceUserRoles, type Db } from "@paperclipai/db";
import { logger } from "../middleware/logger.js";
import type { BetterAuthSessionResult } from "../auth/better-auth.js";
import type { HostTerminalSessions } from "../services/host-terminal-sessions.js";

interface TerminalSocket {
  readyState: number; bufferedAmount: number;
  send(data: string): void;
  close(code?: number, reason?: string): void;
  terminate(): void;
  on(event: "message", handler: (data: Buffer, binary: boolean) => void): void;
  on(event: "close" | "error", handler: () => void): void;
}
interface TerminalServer {
  clients: Set<TerminalSocket>;
  handleUpgrade(req: IncomingMessage, socket: Duplex, head: Buffer, callback: (ws: TerminalSocket) => void): void;
  close(): void;
}
const { WebSocketServer } = createRequire(import.meta.url)("ws") as {
  WebSocketServer: new (options: { noServer: boolean; maxPayload: number; perMessageDeflate: boolean }) => TerminalServer;
};
const PATH = /^\/api\/companies\/([^/]+)\/host-terminals\/([^/]+)\/ws$/;

export function hostTerminalOriginAllowed(req: IncomingMessage, publicUrl?: string) {
  try {
    const origin = req.headers.origin;
    if (!origin || new URL(origin).origin !== origin) return false;
    const expected = publicUrl ? new URL(publicUrl).origin
      : `${(req.socket as { encrypted?: boolean }).encrypted ? "https" : "http"}://${req.headers.host}`;
    return origin === expected;
  } catch { return false; }
}

export function setupHostTerminalWebSocketServer(server: Server, db: Db, sessions: HostTerminalSessions, options: {
  publicUrl?: string;
  resolveSessionFromHeaders?: (headers: Headers) => Promise<BetterAuthSessionResult | null>;
}) {
  const wss = new WebSocketServer({ noServer: true, maxPayload: 64 * 1024, perMessageDeflate: false });
  let stopped = false;
  async function caller(req: IncomingMessage, companyId: string) {
    if (req.headers.authorization || !options.resolveSessionFromHeaders) return null;
    const headers = new Headers();
    // Only the actual human cookie participates, never trusted proxy or agent headers.
    if (req.headers.cookie) headers.set("cookie", req.headers.cookie);
    const auth = await options.resolveSessionFromHeaders(headers);
    const userId = auth?.user?.id;
    if (!userId) return null;
    const [admin] = await db.select({ id: instanceUserRoles.id }).from(instanceUserRoles)
      .where(and(eq(instanceUserRoles.userId, userId), eq(instanceUserRoles.role, "instance_admin")));
    const [member] = await db.select({ id: companyMemberships.id }).from(companyMemberships)
      .where(and(eq(companyMemberships.companyId, companyId), eq(companyMemberships.principalId, userId),
        eq(companyMemberships.principalType, "user"), eq(companyMemberships.status, "active")));
    return admin && member ? userId : null;
  }
  function reject(socket: Duplex, status = "403 Forbidden") {
    if (socket.destroyed) return;
    socket.once("error", () => {});
    socket.end(`HTTP/1.1 ${status}\r\nConnection: close\r\nCache-Control: no-store\r\nContent-Length: 0\r\n\r\n`, () => socket.destroy());
  }
  server.on("upgrade", (req, socket, head) => {
    const match = PATH.exec((req.url ?? "").split("?")[0]!);
    if (!match) return;
    (req as IncomingMessage & { paperclipWebSocketHandled: boolean }).paperclipWebSocketHandled = true;
    socket.on("error", () => {}); // Raw transport errors carry no terminal diagnostics.
    if (stopped || !hostTerminalOriginAllowed(req, options.publicUrl)) { reject(socket); return; }
    const companyId = match[1]!, hostId = match[2]!;
    const deadline = setTimeout(() => reject(socket), 10_000);
    void caller(req, companyId).then(userId => {
      clearTimeout(deadline);
      if (!userId || stopped || socket.destroyed || socket.writableEnded) { reject(socket); return; }
      wss.handleUpgrade(req, socket, head, ws => attach(ws, { companyId, hostId, userId }));
    }).catch(() => { clearTimeout(deadline); reject(socket); });
  });

  function attach(ws: TerminalSocket, scope: { companyId: string; hostId: string; userId: string }) {
    let id: string | null = null, ready = false, ended = false;
    const send = (frame: unknown) => {
      if (ws.readyState !== 1) return;
      if (ws.bufferedAmount > 1024 * 1024) { close("output_overflow"); return; }
      ws.send(JSON.stringify(frame));
    };
    const timer = setTimeout(() => close("auth_timeout"), 5_000);
    function close(reason: string, code: number | null = null) {
      if (ended) return;
      ended = true; clearTimeout(timer);
      send({ type: "closed", reason, exitCode: code });
      if (id) sessions.end(id, reason, code);
      // No unbounded closing handshake retaining an authenticated shell.
      ws.close(1000, reason);
      const terminate = setTimeout(() => ws.terminate(), 1000);
      terminate.unref();
      ws.on("close", () => clearTimeout(terminate));
    }
    ws.on("message", (data, binary) => {
      if (ended) return;
      try {
        if (binary) throw new Error("binary");
        const frame = JSON.parse(data.toString("utf8"));
        if (!id) {
          if (frame.type !== "auth" || typeof frame.token !== "string" || !/^[A-Za-z0-9_-]{43}$/.test(frame.token)
            || typeof frame.sessionId !== "string") throw new Error("auth");
          sessions.consume(frame.sessionId, frame.token, scope);
          id = frame.sessionId;
          clearTimeout(timer);
          void sessions.open(id!, { output: data => send({ type: "output", data }), closed: close }).then(() => {
            if (!ended) { ready = true; send({ type: "ready" }); }
          }).catch(() => close("startup_failed"));
          return;
        }
        if (!ready) throw new Error("not ready");
        if (frame.type === "input" && typeof frame.data === "string" && Buffer.byteLength(frame.data) <= 32_768) {
          sessions.write(id, { type: "input", data: frame.data });
        } else if (frame.type === "resize" && Number.isInteger(frame.cols) && Number.isInteger(frame.rows)
          && frame.cols >= 2 && frame.cols <= 500 && frame.rows >= 1 && frame.rows <= 300) {
          sessions.write(id, { type: "resize", cols: frame.cols, rows: frame.rows });
        } else throw new Error("frame");
      } catch { close("invalid_frame"); }
    });
    ws.on("close", () => close("client_closed"));
    ws.on("error", () => close("client_error"));
  }
  let closePromise: Promise<void> | undefined;
  const close = () => closePromise ??= (async () => {
    stopped = true;
    try { await sessions.shutdown(); }
    finally {
      for (const client of wss.clients) client.terminate();
      wss.close();
    }
  })();
  server.once("close", () => { void close().catch(() => logger.error("Host terminal shutdown failed")); });
  return { close };
}
