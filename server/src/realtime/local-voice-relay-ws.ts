import type { IncomingMessage, Server as HttpServer } from "node:http";
import { createRequire } from "node:module";
import type { Duplex } from "node:stream";
import { and, eq } from "drizzle-orm";
import { z } from "zod";
import { companyMemberships, instanceUserRoles, type Db } from "@paperclipai/db";
import {
  LOCAL_VOICE_RELAY_PROTOCOL,
  LOCAL_VOICE_RELAY_TOKEN_PREFIX,
  isUuidLike,
  type DeploymentMode,
  type LocalVoiceRelayClientMessage,
  type LocalVoiceRelayServerEvent,
} from "@paperclipai/shared";
import type { BetterAuthSessionResult } from "../auth/better-auth.js";
import { HttpError } from "../errors.js";
import { logger } from "../middleware/logger.js";
import { GeminiLiveRelay, type VoiceUpstream, type VoiceUpstreamHandlers } from "../services/voice/gemini-live-relay.js";
import { localVoiceRealtimeUrl, readLocalVoiceGatewayKey, type LocalVoiceGatewayConfig } from "../services/voice/local-voice-gateway-config.js";
import { authorizeLocalVoiceRelay, createLocalVoiceTaskPort } from "../services/voice/local-voice-relay-port.js";
import type { VoiceSessionService } from "../services/voice/voice-session-service.js";
import type { VoiceCaller } from "../services/voice/voice-session-store.js";

/**
 * Same-origin media relay for local voice (HOM-311):
 * `/api/companies/:companyId/voice-sessions/:sessionId/ws`.
 *
 * Authentication happens before the upgrade completes: trusted browser
 * Origin, the caller's Better Auth session cookie (never a bearer or query
 * token), and the session's one-time control token carried as a WebSocket
 * subprotocol. This listener must be registered before the live-events
 * listener, which destroys every upgrade it does not own.
 */

interface RelaySocket {
  readyState: number;
  protocol?: string;
  send(data: string | Buffer, options?: { binary?: boolean }, callback?: (error?: Error) => void): void;
  close(code?: number, reason?: string): void;
  terminate(): void;
  ping(): void;
  on(event: "message", listener: (data: Buffer, isBinary: boolean) => void): void;
  on(event: "close" | "pong", listener: () => void): void;
  on(event: "error", listener: (error: Error) => void): void;
}
interface RelayServer {
  clients: Set<RelaySocket>;
  handleUpgrade(req: IncomingMessage, socket: Duplex, head: Buffer, callback: (ws: RelaySocket) => void): void;
  close(): void;
}
interface UpstreamSocket {
  readyState: number;
  send(data: string): void;
  close(): void;
  terminate(): void;
  once(event: "open", listener: () => void): void;
  once(event: "error", listener: (error: Error) => void): void;
  on(event: "message", listener: (data: Buffer) => void): void;
  on(event: "close", listener: (code: number, reason: Buffer) => void): void;
  on(event: "error", listener: (error: Error) => void): void;
}
const require = createRequire(import.meta.url);
const { WebSocket, WebSocketServer } = require("ws") as {
  WebSocket: { OPEN: number } & (new (url: string, options: { headers: Record<string, string>; maxPayload: number; handshakeTimeout: number }) => UpstreamSocket);
  WebSocketServer: new (opts: { noServer: boolean; maxPayload: number; handleProtocols: (protocols: Set<string>) => string | false }) => RelayServer;
};

const PATH = /^\/api\/companies\/([^/]+)\/voice-sessions\/([^/]+)\/ws$/;
const TOKEN = /^[A-Za-z0-9_-]{43}$/;
const MAX_AUDIO_FRAME_BYTES = 64 * 1024;
const MAX_RELAYS_PER_CALLER = 2;
const MAX_RELAYS = 16;
const DEFAULT_DEV_ORIGINS = ["http://localhost:3100", "http://127.0.0.1:3100"];

const clientMessageSchema: z.ZodType<LocalVoiceRelayClientMessage> = z.discriminatedUnion("type", [
  z.object({ type: z.literal("text"), text: z.string().trim().min(1).max(4000) }).strict(),
  z.object({ type: z.literal("mic"), state: z.enum(["live", "paused"]) }).strict(),
  z.object({ type: z.literal("playback"), playing: z.boolean() }).strict(),
  z.object({ type: z.literal("confirm_draft"), draftId: z.string().uuid(), revision: z.number().int().min(1).max(1_000_000) }).strict(),
  z.object({ type: z.literal("cancel_draft"), draftId: z.string().uuid() }).strict(),
  z.object({ type: z.literal("end") }).strict(),
]);

function parseOrigin(value: string | undefined) {
  if (!value) return null;
  try { const url = new URL(value); return `${url.protocol}//${url.host}`.toLowerCase(); } catch { return null; }
}

/** Same trusted-origin set as the board mutation guard, without trusting X-Forwarded-Host. */
export function trustedVoiceRelayOrigin(req: IncomingMessage, publicUrl = process.env.PAPERCLIP_PUBLIC_URL) {
  const origin = parseOrigin(typeof req.headers.origin === "string" ? req.headers.origin : undefined);
  if (!origin) return false;
  const allowed = new Set(DEFAULT_DEV_ORIGINS);
  const host = req.headers.host?.trim();
  if (host) { allowed.add(`http://${host}`.toLowerCase()); allowed.add(`https://${host}`.toLowerCase()); }
  const configured = parseOrigin(publicUrl?.trim());
  if (configured) allowed.add(configured);
  return allowed.has(origin);
}

export function parseVoiceRelayProtocols(header: string | string[] | undefined) {
  const raw = Array.isArray(header) ? header.join(",") : header ?? "";
  const protocols = raw.split(",").map((value) => value.trim()).filter(Boolean);
  if (!protocols.includes(LOCAL_VOICE_RELAY_PROTOCOL)) return null;
  const tokens = protocols.filter((value) => value.startsWith(LOCAL_VOICE_RELAY_TOKEN_PREFIX)).map((value) => value.slice(LOCAL_VOICE_RELAY_TOKEN_PREFIX.length));
  if (tokens.length !== 1 || !TOKEN.test(tokens[0]!)) return null;
  return { token: tokens[0]! };
}

function headersFrom(req: IncomingMessage) {
  const headers = new Headers();
  for (const [key, value] of Object.entries(req.headers)) {
    if (!value) continue;
    if (Array.isArray(value)) for (const item of value) headers.append(key, item);
    else headers.set(key, value);
  }
  return headers;
}

function rejectUpgrade(socket: Duplex, status: string, message: string) {
  if (socket.destroyed) return;
  try {
    socket.once("finish", () => socket.destroy());
    socket.end(`HTTP/1.1 ${status}\r\nConnection: close\r\nContent-Type: text/plain\r\nCache-Control: no-store\r\n\r\n${message}`);
  } catch { socket.destroy(); }
}

export function setupLocalVoiceRelayWebSocketServer(server: HttpServer, db: Db, opts: {
  deploymentMode: DeploymentMode;
  resolveSessionFromHeaders?: (headers: Headers) => Promise<BetterAuthSessionResult | null>;
  voice: () => VoiceSessionService | null;
  config: LocalVoiceGatewayConfig | null;
}) {
  const wss = new WebSocketServer({
    noServer: true,
    maxPayload: MAX_AUDIO_FRAME_BYTES,
    handleProtocols: (protocols) => protocols.has(LOCAL_VOICE_RELAY_PROTOCOL) ? LOCAL_VOICE_RELAY_PROTOCOL : false,
  });
  const active = new Map<GeminiLiveRelay, string>();
  /** One relay per voice session, and limit slots reserved before the async authorization. */
  const sessions = new Set<string>();
  const reserved = new Map<string, number>();
  const reservedTotal = () => [...reserved.values()].reduce((sum, count) => sum + count, 0);
  const allowLocalBoard = opts.deploymentMode === "local_trusted";

  async function resolveCaller(req: IncomingMessage, companyId: string): Promise<VoiceCaller | null> {
    if (opts.deploymentMode === "local_trusted") return { id: "local-board", authority: "local_board" };
    if (opts.deploymentMode !== "authenticated" || !opts.resolveSessionFromHeaders) return null;
    const session = await opts.resolveSessionFromHeaders(headersFrom(req));
    const userId = session?.user?.id;
    if (!userId) return null;
    const [admin] = await db.select({ id: instanceUserRoles.id }).from(instanceUserRoles)
      .where(and(eq(instanceUserRoles.userId, userId), eq(instanceUserRoles.role, "instance_admin")));
    if (!admin) {
      const [member] = await db.select({ id: companyMemberships.id }).from(companyMemberships)
        .where(and(eq(companyMemberships.companyId, companyId), eq(companyMemberships.principalType, "user"), eq(companyMemberships.principalId, userId), eq(companyMemberships.status, "active")));
      if (!member) return null;
    }
    return { id: userId, authority: admin ? "instance_admin" : "member" };
  }

  function connectUpstream(config: LocalVoiceGatewayConfig) {
    return async (handlers: VoiceUpstreamHandlers): Promise<VoiceUpstream> => {
      const key = await readLocalVoiceGatewayKey(config);
      const socket = new WebSocket(localVoiceRealtimeUrl(config), {
        headers: { Authorization: `Bearer ${key}` }, maxPayload: 16 * 1024 * 1024, handshakeTimeout: 15_000,
      });
      await new Promise<void>((resolve, reject) => {
        socket.once("open", () => resolve());
        socket.once("error", (error) => reject(new Error(`gateway connect failed: ${error.message.slice(0, 120)}`)));
      });
      socket.on("message", (data) => handlers.onMessage(data.toString("utf8")));
      socket.on("close", (code, reason) => handlers.onClose(code, reason.toString("utf8")));
      socket.on("error", (error) => logger.warn({ errorName: error.name }, "local voice upstream socket error"));
      return {
        send: (json) => { if (socket.readyState === WebSocket.OPEN) socket.send(json); },
        close: () => { try { socket.close(); } catch { socket.terminate(); } },
      };
    };
  }

  function attach(ws: RelaySocket, input: { companyId: string; caller: VoiceCaller; token: string; binding: Awaited<ReturnType<typeof authorizeLocalVoiceRelay>>; service: VoiceSessionService; config: LocalVoiceGatewayConfig }) {
    const sessionId = input.binding.session.id;
    const send = (data: string | Buffer, binary: boolean) => {
      if (ws.readyState !== WebSocket.OPEN) return;
      ws.send(data, { binary }, (error) => { if (error) logger.warn({ errorName: error.name, sessionId }, "local voice relay send failed"); });
    };
    const relay = new GeminiLiveRelay({
      browser: {
        sendEvent: (event: LocalVoiceRelayServerEvent) => send(JSON.stringify(event), false),
        sendAudio: (pcm) => send(pcm, true),
        close: (code, reason) => { if (ws.readyState === WebSocket.OPEN) ws.close(code, reason.slice(0, 120)); },
      },
      port: createLocalVoiceTaskPort(db, input.service, { binding: input.binding, caller: input.caller, token: input.token, allowLocalBoard }),
      connectUpstream: connectUpstream(input.config),
      binding: { issueId: input.binding.issue.id, issueIdentifier: input.binding.issue.identifier, issueTitle: input.binding.issue.title, agentName: input.binding.agentName },
      voiceName: input.config.voiceName,
      log: (event, fields) => logger.info({ ...fields, sessionId, companyId: input.companyId }, event),
    });
    active.set(relay, input.caller.id);
    sessions.add(sessionId);
    let alive = true;
    const ping = setInterval(() => {
      if (!alive) { ws.terminate(); return; }
      alive = false;
      try { ws.ping(); } catch { /* closing */ }
    }, 25_000);
    ws.on("pong", () => { alive = true; });
    ws.on("message", (data, isBinary) => {
      if (isBinary) { relay.handleBrowserAudio(data); return; }
      let parsed: LocalVoiceRelayClientMessage;
      try {
        const result = clientMessageSchema.safeParse(JSON.parse(data.toString("utf8")));
        if (!result.success) throw new Error("invalid");
        parsed = result.data;
      } catch {
        send(JSON.stringify({ type: "error", code: "voice_relay_invalid_message", message: "Invalid voice relay message" } satisfies LocalVoiceRelayServerEvent), false);
        return;
      }
      void relay.handleBrowserMessage(parsed).catch((error) => logger.warn({ err: error, sessionId }, "local voice relay message failed"));
    });
    ws.on("close", () => {
      clearInterval(ping);
      active.delete(relay);
      sessions.delete(sessionId);
      relay.handleBrowserClosed();
    });
    ws.on("error", (error) => logger.warn({ errorName: error.name, sessionId }, "local voice relay socket error"));
    void relay.start();
  }

  server.on("upgrade", (req, socket, head) => {
    if (!req.url) return;
    const url = new URL(req.url, "http://localhost");
    const match = PATH.exec(url.pathname);
    if (!match) return;
    (req as IncomingMessage & { paperclipWebSocketHandled?: boolean }).paperclipWebSocketHandled = true;
    socket.on("error", () => undefined);
    let companyId: string, sessionId: string;
    try { companyId = decodeURIComponent(match[1]!); sessionId = decodeURIComponent(match[2]!); } catch { rejectUpgrade(socket, "400 Bad Request", "bad path"); return; }
    if (!isUuidLike(companyId) || !isUuidLike(sessionId) || url.search) { rejectUpgrade(socket, "400 Bad Request", "bad path"); return; }
    if (!trustedVoiceRelayOrigin(req)) { rejectUpgrade(socket, "403 Forbidden", "untrusted origin"); return; }
    if (req.headers.authorization) { rejectUpgrade(socket, "403 Forbidden", "bearer credentials are not accepted"); return; }
    const protocols = parseVoiceRelayProtocols(req.headers["sec-websocket-protocol"]);
    if (!protocols) { rejectUpgrade(socket, "403 Forbidden", "missing voice session credential"); return; }
    const service = opts.voice();
    const config = opts.config;
    if (!service || !config) { rejectUpgrade(socket, "503 Service Unavailable", "local voice relay is not configured"); return; }
    if (sessions.has(sessionId)) { rejectUpgrade(socket, "409 Conflict", "this voice session already has a connection"); return; }
    // Reserve the session and a global slot synchronously so parallel upgrades cannot race past the limits.
    sessions.add(sessionId);
    const slotKey = `pending:${sessionId}`;
    reserved.set(slotKey, 1);
    let attached = false;
    const release = () => { reserved.delete(slotKey); if (!attached) sessions.delete(sessionId); };
    void (async () => {
      if (active.size + reservedTotal() > MAX_RELAYS) { rejectUpgrade(socket, "429 Too Many Requests", "too many voice calls"); return; }
      const caller = await resolveCaller(req, companyId);
      if (!caller) { rejectUpgrade(socket, "403 Forbidden", "forbidden"); return; }
      if ([...active.values()].filter((id) => id === caller.id).length >= MAX_RELAYS_PER_CALLER) {
        rejectUpgrade(socket, "429 Too Many Requests", "too many voice calls"); return;
      }
      let binding: Awaited<ReturnType<typeof authorizeLocalVoiceRelay>>;
      try {
        binding = await authorizeLocalVoiceRelay(db, service, { companyId, sessionId, caller, token: protocols.token, allowLocalBoard });
      } catch (error) {
        if (error instanceof HttpError) { rejectUpgrade(socket, error.status === 404 ? "404 Not Found" : "403 Forbidden", "voice session unavailable"); return; }
        throw error;
      }
      if (socket.destroyed) return;
      attached = true;
      wss.handleUpgrade(req, socket, head, (ws) => attach(ws, { companyId, caller, token: protocols.token, binding, service, config }));
    })().catch((error) => {
      logger.error({ err: error }, "local voice relay upgrade failed");
      rejectUpgrade(socket, "500 Internal Server Error", "upgrade failed");
    }).finally(release);
  });

  return {
    activeCount: () => active.size,
    async close() {
      await Promise.all([...active.keys()].map((relay) => relay.end("server_shutdown")));
      wss.close();
    },
  };
}
