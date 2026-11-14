import { randomUUID } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import path from "node:path";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import {
  activityLog, agents, chatDeliveries, chatEndpoints, chatVoiceConfirmations, chatVoiceSessions, companies, companyMemberships, createDb,
  EMBEDDED_POSTGRES_TEST_TIMEOUT_MS, issueComments, issues,
} from "@paperclipai/db";
import { LOCAL_VOICE_RELAY_PROTOCOL, LOCAL_VOICE_RELAY_TOKEN_PREFIX } from "@paperclipai/shared";
import { setupLocalVoiceRelayWebSocketServer } from "../realtime/local-voice-relay-ws.js";
import { instanceSettingsService } from "../services/instance-settings.js";
import { ensureLocalVoiceEndpoint } from "../services/voice/local-voice-endpoints.js";
import { voiceSessionService } from "../services/voice/voice-session-service.js";
import { getEmbeddedPostgresTestSupport, startEmbeddedPostgresTestDatabase } from "./helpers/embedded-postgres.js";

const require = createRequire(import.meta.url);
const { WebSocket, WebSocketServer } = require("ws");
const support = await getEmbeddedPostgresTestSupport();
const GATEWAY_KEY = "test-gateway-key-not-a-secret";

/**
 * HOM-311 local voice relay, end to end on loopback: provisioning, start, the
 * authenticated upgrade, a fake Gemini Live gateway, the spoken confirmation
 * path into the existing voice.control.v1 ledger, and agent replies.
 */
(support.supported ? describe : describe.skip)("local voice relay (HOM-311)", () => {
  let db: ReturnType<typeof createDb>;
  let database: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>>;
  let server: Server;
  let gateway: any;
  let relay: ReturnType<typeof setupLocalVoiceRelayWebSocketServer>;
  let keyDir: string;
  let port: number;
  const gatewayConnections: { socket: any; received: any[]; auth: string | undefined; url: string }[] = [];
  const cookieUsers = new Map<string, string>();
  let service: ReturnType<typeof voiceSessionService>;

  beforeAll(async () => {
    database = await startEmbeddedPostgresTestDatabase("paperclip-local-voice-relay-");
    db = createDb(database.connectionString);
    service = voiceSessionService(db, { allowLocalBoard: false, credentials: async () => { throw new Error("no provider credentials"); }, onQuestionAnswered: vi.fn() });
    keyDir = await mkdtemp(path.join(tmpdir(), "pc-voice-key-"));
    await writeFile(path.join(keyDir, "key"), `${GATEWAY_KEY}\n`, { mode: 0o600 });
    gateway = new WebSocketServer({ port: 0, host: "127.0.0.1" });
    gateway.on("connection", (socket: any, req: any) => {
      const connection = { socket, received: [] as any[], auth: req.headers.authorization as string | undefined, url: req.url as string };
      gatewayConnections.push(connection);
      socket.on("message", (data: Buffer) => {
        const message = JSON.parse(data.toString());
        connection.received.push(message);
        if (message.setup) socket.send(JSON.stringify({ setupComplete: {} }));
      });
    });
    await new Promise((resolve) => gateway.once("listening", resolve));
    server = createServer((_req, res) => { res.statusCode = 404; res.end(); });
    relay = setupLocalVoiceRelayWebSocketServer(server, db, {
      deploymentMode: "authenticated",
      resolveSessionFromHeaders: async (headers) => {
        const userId = cookieUsers.get(headers.get("cookie") ?? "");
        return userId ? ({ user: { id: userId }, session: { id: "s" } } as any) : null;
      },
      voice: () => service,
      config: { url: `ws://127.0.0.1:${(gateway.address() as AddressInfo).port}`, keyFile: path.join(keyDir, "key"), model: "gemini-3.8-live", voiceName: "Kore" },
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    port = (server.address() as AddressInfo).port;
  }, EMBEDDED_POSTGRES_TEST_TIMEOUT_MS);
  afterAll(async () => {
    await relay?.close();
    await new Promise((resolve) => server?.close(resolve));
    await new Promise((resolve) => gateway?.close(resolve));
    service?.unregisterAgentTools();
    await database?.cleanup();
    if (keyDir) await rm(keyDir, { recursive: true, force: true });
  });
  beforeEach(async () => { await instanceSettingsService(db).updateExperimental({ enableChatConnectors: true, enableLocalVoice: true }); });

  async function fixture() {
    const companyId = randomUUID(), agentId = randomUUID(), callerId = `user-${randomUUID()}`, cookie = `session=${randomUUID()}`;
    cookieUsers.set(cookie, callerId);
    await db.insert(companies).values({ id: companyId, name: "Relay test", issuePrefix: `R${companyId.slice(0, 6).toUpperCase()}` });
    await db.insert(companyMemberships).values({ companyId, principalType: "user", principalId: callerId, status: "active", membershipRole: "member" });
    await db.insert(agents).values({ id: agentId, companyId, name: "michael", role: "operator", status: "idle", adapterType: "paperclip_runner" });
    const caller = { id: callerId, authority: "member" as const };
    const endpoint = await ensureLocalVoiceEndpoint(db, { companyId, agentId, caller, allowLocalBoard: false });
    const started = await service.local.start({ companyId, endpointId: endpoint.endpointId, caller, idempotencyKey: randomUUID(), maxDurationSeconds: 930, bindingMode: "voice_task" });
    if (!started.media) throw new Error("expected media");
    return { companyId, agentId, callerId, cookie, caller, endpoint, sessionId: started.session.id, issueId: started.session.issueId, token: started.media.transportToken };
  }

  function connect(f: { companyId: string; sessionId: string; token: string; cookie: string }, overrides: { origin?: string; protocols?: string[]; cookie?: string } = {}) {
    const url = `ws://127.0.0.1:${port}/api/companies/${f.companyId}/voice-sessions/${f.sessionId}/ws`;
    const socket = new WebSocket(url, overrides.protocols ?? [LOCAL_VOICE_RELAY_PROTOCOL, `${LOCAL_VOICE_RELAY_TOKEN_PREFIX}${f.token}`], {
      headers: { origin: overrides.origin ?? `http://127.0.0.1:${port}`, cookie: overrides.cookie ?? f.cookie },
    });
    const events: any[] = [];
    const audio: Buffer[] = [];
    socket.on("message", (data: Buffer, isBinary: boolean) => { if (isBinary) audio.push(data); else events.push(JSON.parse(data.toString())); });
    const opened = new Promise<void>((resolve, reject) => { socket.once("open", resolve); socket.once("unexpected-response", (_req: any, res: any) => reject(new Error(`status ${res.statusCode}`))); socket.once("error", reject); });
    return { socket, events, audio, opened };
  }

  it("provisions one local endpoint per agent idempotently", async () => {
    const f = await fixture();
    const again = await ensureLocalVoiceEndpoint(db, { companyId: f.companyId, agentId: f.agentId, caller: f.caller, allowLocalBoard: false });
    expect(again).toMatchObject({ endpointId: f.endpoint.endpointId, created: false });
    const rows = await db.select().from(chatEndpoints).where(eq(chatEndpoints.companyId, f.companyId));
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ provider: "local_voice", assignedAgentId: f.agentId, status: "active" });
    const [task] = await db.select().from(issues).where(eq(issues.id, f.issueId));
    expect(task).toMatchObject({ title: "語音對話", assigneeAgentId: f.agentId });
    expect(task.description).toContain("語音摘要：");
    await expect(ensureLocalVoiceEndpoint(db, { companyId: f.companyId, agentId: f.agentId, caller: { id: "stranger", authority: "member" }, allowLocalBoard: false }))
      .rejects.toMatchObject({ status: 403 });
  });

  it("rejects untrusted origins, missing or wrong tokens, other users and bearer headers before upgrading", async () => {
    const f = await fixture();
    await expect(connect(f, { origin: "https://evil.example" }).opened).rejects.toThrow("status 403");
    await expect(connect(f, { protocols: [LOCAL_VOICE_RELAY_PROTOCOL] }).opened).rejects.toThrow("status 403");
    await expect(connect(f, { protocols: [LOCAL_VOICE_RELAY_PROTOCOL, `${LOCAL_VOICE_RELAY_TOKEN_PREFIX}${"A".repeat(43)}`] }).opened).rejects.toThrow("status 403");
    await expect(connect(f, { cookie: "session=unknown" }).opened).rejects.toThrow("status 403");
    const other = await fixture();
    await expect(connect({ ...f, cookie: other.cookie }).opened).rejects.toThrow(/status 40[34]/);
    await instanceSettingsService(db).updateExperimental({ enableLocalVoice: false });
    await expect(connect(f).opened).rejects.toThrow("status 403");
    expect(gatewayConnections.filter((c) => c.url.includes("gemini"))).toHaveLength(0);
  });

  it("relays audio, confirms a spoken draft into one delivery and announces the agent's reply", async () => {
    const f = await fixture();
    const before = gatewayConnections.length;
    const browser = connect(f);
    await browser.opened;
    expect(browser.socket.protocol).toBe(LOCAL_VOICE_RELAY_PROTOCOL);
    await vi.waitFor(() => expect(browser.events.find((e) => e.type === "ready")).toBeTruthy());
    const upstream = gatewayConnections[before]!;
    expect(upstream.auth).toBe(`Bearer ${GATEWAY_KEY}`);
    expect(upstream.url).toBe("/v1/realtime?model=gemini-3.8-live");
    expect(browser.events.some((e) => JSON.stringify(e).includes(GATEWAY_KEY))).toBe(false);

    browser.socket.send(Buffer.from([1, 0, 2, 0]));
    await vi.waitFor(() => expect(upstream.received.some((m) => m.realtimeInput?.audio)).toBe(true));
    upstream.socket.send(JSON.stringify({ serverContent: { modelTurn: { parts: [{ inlineData: { mimeType: "audio/pcm;rate=24000", data: Buffer.from([7, 0]).toString("base64") } }] } } }));
    await vi.waitFor(() => expect(browser.audio[0]).toEqual(Buffer.from([7, 0])));

    const responseFor = async (id: string) => {
      let response: any;
      await vi.waitFor(() => { response = upstream.received.find((m) => m.toolResponse?.functionResponses?.[0]?.id === id)?.toolResponse.functionResponses[0].response; expect(response).toBeTruthy(); });
      return response;
    };
    upstream.socket.send(JSON.stringify({ toolCall: { functionCalls: [{ id: "q", name: "query_task_status", args: {} }] } }));
    expect(await responseFor("q")).toMatchObject({ status: "ok", voiceTask: { title: "語音對話" } });

    const text = "請 michael 查昨天部署失敗的原因";
    upstream.socket.send(JSON.stringify({ toolCall: { functionCalls: [{ id: "p", name: "prepare_request", args: { text } }] } }));
    const draft = await responseFor("p");
    upstream.socket.send(JSON.stringify({ serverContent: { turnComplete: true } }));
    upstream.socket.send(JSON.stringify({ serverContent: { inputTranscription: { text: "确认送出" } } }));
    upstream.socket.send(JSON.stringify({ toolCall: { functionCalls: [{ id: "s", name: "submit_request", args: { draftId: draft.draftId } }] } }));
    expect(await responseFor("s")).toMatchObject({ status: "accepted" });
    const deliveries = await db.select().from(chatDeliveries).where(eq(chatDeliveries.companyId, f.companyId));
    expect(deliveries).toHaveLength(1);
    expect((deliveries[0]!.normalizedEvent as { message: { text: string } }).message.text).toBe(text);
    const [confirmation] = await db.select().from(chatVoiceConfirmations).where(eq(chatVoiceConfirmations.sessionId, f.sessionId));
    expect(confirmation).toMatchObject({ state: "consumed", confirmedByUserId: f.callerId });
    const audits = await db.select().from(activityLog).where(eq(activityLog.entityId, f.sessionId));
    expect(audits.find((row) => row.action === "voice.confirmation.created")?.details).toMatchObject({ via: "spoken_relay" });
    expect(browser.events.find((e) => e.type === "submitted")).toMatchObject({ via: "spoken" });

    await db.insert(issueComments).values({ companyId: f.companyId, issueId: f.issueId, authorAgentId: f.agentId, authorType: "agent",
      body: "原因是磁碟滿了。\n\n語音摘要：昨天部署失敗是因為磁碟滿了，已經清理完成。" });
    upstream.socket.send(JSON.stringify({ toolCall: { functionCalls: [{ id: "u", name: "get_updates", args: {} }] } }));
    expect(await responseFor("u")).toMatchObject({ status: "ok", replies: [{ summary: "昨天部署失敗是因為磁碟滿了，已經清理完成。" }] });
    expect(browser.events.find((e) => e.type === "agent_reply")).toMatchObject({ voiceSummary: "昨天部署失敗是因為磁碟滿了，已經清理完成。" });

    browser.socket.send(JSON.stringify({ type: "end" }));
    await vi.waitFor(async () => {
      const [session] = await db.select().from(chatVoiceSessions).where(eq(chatVoiceSessions.id, f.sessionId));
      expect(session.state).toBe("ended");
    });
    expect(browser.events.at(-1)).toEqual({ type: "ended", reason: "caller_ended" });
  });

  it("ends the persisted session when the browser disconnects", async () => {
    const f = await fixture();
    const browser = connect(f);
    await browser.opened;
    await vi.waitFor(() => expect(browser.events.find((e) => e.type === "ready")).toBeTruthy());
    browser.socket.close();
    await vi.waitFor(async () => {
      const [session] = await db.select().from(chatVoiceSessions).where(eq(chatVoiceSessions.id, f.sessionId));
      expect(session.state).toBe("ended");
    });
    expect(relay.activeCount()).toBe(0);
  });
});
