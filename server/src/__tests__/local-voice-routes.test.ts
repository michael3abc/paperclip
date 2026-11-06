import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import express from "express";
import request from "supertest";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { boardMutationGuard } from "../middleware/board-mutation-guard.js";
import { errorHandler } from "../middleware/index.js";
import { LocalVoiceProtocolError } from "../services/voice/local-voice-protocol.js";

const settings = vi.hoisted(() => ({ getExperimental: vi.fn() }));
vi.mock("../services/instance-settings.js", () => ({ instanceSettingsService: () => settings }));
const { voiceSessionRoutes } = await import("../routes/voice-sessions.js");

const companyId = "6f1f3b5e-8d0a-4c7c-9b8e-1f2a3b4c5d6e";
const sessionId = "0a1b2c3d-4e5f-4a6b-8c7d-9e0f1a2b3c4d";
const token = "A".repeat(43);
const toolPath = `/api/companies/${companyId}/voice-sessions/${sessionId}/local-tools`;
const message = { v: 1, type: "tool", toolCallId: "call_1", tool: "get_updates", args: { cursor: 0 } };

/**
 * Route-level checks for the local voice control channel. The server listens
 * on loopback with an ephemeral port only; the voice service is a mock, so no
 * database, provider or media is involved.
 */
describe("local voice same-origin routes", () => {
  const service = {
    start: vi.fn(),
    local: { start: vi.fn(), tool: vi.fn(), confirm: vi.fn(), operation: vi.fn() },
  };
  let server: Server, origin: string;
  beforeAll(async () => {
    const app = express();
    app.use(express.json({ limit: "1mb", verify: (req, _res, buf) => { (req as unknown as { rawBody: Buffer }).rawBody = buf; } }));
    app.use((req, _res, next) => {
      (req as any).actor = req.header("x-test-actor") === "agent"
        ? { type: "agent", agentId: "agent-1", companyId, source: "agent_key" }
        : { type: "board", source: "session", userId: "user-1", isInstanceAdmin: false, companyIds: [companyId] };
      next();
    });
    const api = express.Router();
    api.use(boardMutationGuard());
    api.use(voiceSessionRoutes({} as never, service as never));
    app.use("/api", api);
    app.use(errorHandler);
    server = createServer(app);
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });
  afterAll(async () => { await new Promise<void>((resolve) => server.close(() => resolve())); });
  beforeEach(() => {
    vi.clearAllMocks();
    settings.getExperimental.mockResolvedValue({ enableChatConnectors: true, enableLocalVoice: true });
    service.local.tool.mockResolvedValue({ toolCallId: "call_1", result: { status: "pending", updates: [], cursor: 0 } });
  });
  const post = (path = toolPath) => request(server).post(path).set("Origin", origin).set("X-Paperclip-Voice-Session-Token", token);

  it("forwards the ORIGINAL bytes and the session token, and wraps the result as a voice.control.v1 tool result", async () => {
    const body = JSON.stringify(message);
    const res = await post().set("Content-Type", "application/json").send(body);
    expect(res.status).toBe(200);
    expect(res.headers["cache-control"]).toBe("no-store");
    expect(res.body).toEqual({ v: 1, type: "tool_result", toolCallId: "call_1", status: 200, result: { status: "pending", updates: [], cursor: 0 } });
    const [cid, sid, caller, raw, sentToken] = service.local.tool.mock.calls[0];
    expect([cid, sid, caller, sentToken]).toEqual([companyId, sessionId, { id: "user-1", authority: "member" }, token]);
    expect(Buffer.isBuffer(raw) && raw.toString("utf8")).toBe(body);
  });
  it("keeps the board mutation guard: no trusted origin means 403 and no service call", async () => {
    const res = await request(server).post(toolPath).set("X-Paperclip-Voice-Session-Token", token).send(message);
    expect(res.status).toBe(403);
    const cross = await request(server).post(toolPath).set("Origin", "https://evil.example").set("X-Paperclip-Voice-Session-Token", token).send(message);
    expect(cross.status).toBe(403);
    expect(service.local.tool).not.toHaveBeenCalled();
  });
  it("rejects agent callers, missing or malformed tokens and non-JSON media types before the service", async () => {
    expect((await post().set("x-test-actor", "agent").send(message)).status).toBe(403);
    expect((await request(server).post(toolPath).set("Origin", origin).send(message)).status).toBe(403);
    expect((await request(server).post(toolPath).set("Origin", origin).set("X-Paperclip-Voice-Session-Token", "short").send(message)).status).toBe(403);
    expect((await post().set("Content-Type", "text/plain").send(JSON.stringify(message))).status).toBe(415);
    expect((await post(`/api/companies/not-a-uuid/voice-sessions/${sessionId}/local-tools`).send(message)).status).toBe(400);
    expect(service.local.tool).not.toHaveBeenCalled();
  });
  it("maps protocol errors to 413, 400 and 422 with voice_control_* codes", async () => {
    for (const [code, status] of [["body_too_large", 413], ["invalid_json", 400], ["invalid_message", 422]] as const) {
      service.local.tool.mockRejectedValueOnce(new LocalVoiceProtocolError(code));
      const res = await post().send(message);
      expect(res.status).toBe(status);
      expect(res.body).toMatchObject({ details: { code: `voice_control_${code}` } });
    }
  });
  it("fails closed when chat connectors are off", async () => {
    settings.getExperimental.mockResolvedValue({ enableChatConnectors: false, enableLocalVoice: true });
    expect((await post().send(message)).status).toBe(403);
    expect(service.local.tool).not.toHaveBeenCalled();
  });
  it("validates confirmations strictly and returns 201 with the trusted receipt", async () => {
    const path = `/api/companies/${companyId}/voice-sessions/${sessionId}/confirmations`;
    service.local.confirm.mockResolvedValue({ draftId: "d", revision: 1, state: "confirmed" });
    const draftId = "1b2c3d4e-5f6a-4b7c-8d9e-0f1a2b3c4d5e";
    expect((await request(server).post(path).set("Origin", origin).send({ draftId, revision: 1, text: "Hello" })).status).toBe(201);
    for (const body of [
      { draftId, revision: 1, text: "" },
      { draftId, revision: 1, text: " padded " },
      { draftId, revision: 0, text: "Hello" },
      { draftId, revision: 1, text: "Hello", companyId },
      { draftId, revision: 1, text: "Hello", textSha256: "0".repeat(64) },
    ]) expect((await request(server).post(path).set("Origin", origin).send(body)).status, JSON.stringify(body)).toBe(400);
    expect(service.local.confirm).toHaveBeenCalledTimes(1);
  });
  it("dispatches voice_task starts to the local provider and keeps every other start on the Speko path", async () => {
    const path = `/api/companies/${companyId}/voice-sessions`;
    const endpointId = "2c3d4e5f-6a7b-4c8d-9e0f-1a2b3c4d5e6f", issueId = "3d4e5f6a-7b8c-4d9e-8f1a-2b3c4d5e6f7a";
    service.local.start.mockResolvedValue({ session: { id: sessionId }, media: { provider: "local_voice" } });
    service.start.mockResolvedValue({ session: { id: sessionId } });
    const local = await request(server).post(path).set("Origin", origin).send({ endpointId, issueId, idempotencyKey: "5e6f7a8b-9c0d-4e1f-8a2b-3c4d5e6f7a8b", bindingMode: "voice_task" });
    expect(local.status).toBe(201);
    const speko = await request(server).post(path).set("Origin", origin).send({ endpointId, issueId, idempotencyKey: "6f7a8b9c-0d1e-4f2a-9b3c-4d5e6f7a8b9c" });
    expect(speko.status).toBe(200);
    expect(service.local.start).toHaveBeenCalledTimes(1);
    expect(service.start).toHaveBeenCalledTimes(1);
    expect(service.start.mock.calls[0][0]).not.toHaveProperty("bindingMode");
    expect((await request(server).post(path).set("Origin", origin).send({ endpointId, issueId, idempotencyKey: "7a8b9c0d-1e2f-4a3b-8c4d-5e6f7a8b9c0d", bindingMode: "owner_chat" })).status).toBe(400);
  });
  it("looks up an unknown operation by its original id only", async () => {
    service.local.operation.mockResolvedValue({ operationId: "x", state: "not_found" });
    const base = `/api/companies/${companyId}/voice-sessions/${sessionId}/operations`;
    expect((await request(server).get(`${base}/4e5f6a7b-8c9d-4e0f-9a1b-2c3d4e5f6a7b`)).status).toBe(200);
    expect((await request(server).get(`${base}/not-a-uuid`)).status).toBe(400);
    expect(service.local.operation).toHaveBeenCalledTimes(1);
  });
});
