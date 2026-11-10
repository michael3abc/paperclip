import { randomUUID } from "node:crypto";
import express from "express";
import request from "supertest";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Db } from "@paperclipai/db";
import { sessionBridgeRoutes } from "../routes/session-bridge.js";
import { errorHandler } from "../middleware/error-handler.js";
import { registerAssignedMcpGateway } from "../services/native-runtime/assigned-mcp-tools.js";
import { ToolGatewayHttpError, type ToolGatewayService } from "../services/tool-gateway.js";

const listToolsForSession = vi.fn();
const executeTool = vi.fn();
const tool = { name: "assigned:list", connectionId: randomUUID(), displayName: "List",
  description: "Read available items", parametersSchema: { type: "object" }, risk: "read" };
const actor = { type: "agent" as const, source: "agent_key" as const, agentId: randomUUID(),
  companyId: randomUUID(), keyId: randomUUID(), onBehalfOfUserId: randomUUID(),
  keyScope: { kind: "session_bridge" as const, projectIds: [randomUUID()], allowAssignedTools: true } };
const call = { name: tool.name, arguments: { limit: 1 }, idempotencyKey: "same-operation" };
const prefix = "/api/agents/me/session-bridge";

function app(allowAssignedTools = true) {
  const db = {} as Db;
  registerAssignedMcpGateway(db, { listToolsForSession, executeTool } as unknown as ToolGatewayService);
  const result = express();
  result.use(express.json());
  result.use((req, _res, next) => {
    req.actor = { ...actor, keyScope: { ...actor.keyScope, allowAssignedTools } }; next();
  });
  result.use("/api", sessionBridgeRoutes(db));
  result.use(errorHandler);
  return result;
}

beforeEach(() => {
  vi.resetAllMocks();
  listToolsForSession.mockResolvedValue([tool]);
  executeTool.mockResolvedValue({ items: [] });
});

describe("session bridge assigned connector HTTP contract", () => {
  it("retains upstream tool failure status and explanation without retry", async () => {
    const message = "SeaTalk Web session expired. Sign in again.";
    executeTool.mockRejectedValue(new ToolGatewayHttpError(502, message, "tool_error",
      { execution: { request: { dispatched: true } } }));
    const response = await request(app()).post(`${prefix}/tools-call`).send(call);
    expect(response.status).toBe(502);
    expect(response.body).toEqual({ error: message, reasonCode: "tool_error",
      execution: { request: { dispatched: true } } });
    expect(executeTool).toHaveBeenCalledTimes(1);
  });

  it("retains approval references without approving or executing twice", async () => {
    const actionRequestId = randomUUID();
    executeTool.mockRejectedValue(new ToolGatewayHttpError(409, "Approval required",
      "approval_required", { actionRequestId }));
    const response = await request(app()).post(`${prefix}/tools-call`).send(call);
    expect(response.status).toBe(409);
    expect(response.body).toEqual({ error: "Approval required", reasonCode: "approval_required", actionRequestId });
    expect(executeTool).toHaveBeenCalledTimes(1);
  });

  it.each(["tools-search", "tools-call"])("preserves discovery denial for %s", async (operation) => {
    listToolsForSession.mockRejectedValue(new ToolGatewayHttpError(403, "Grant revoked", "grant_revoked"));
    const response = await request(app()).post(`${prefix}/${operation}`).send(operation === "tools-call" ? call : { query: "list" });
    expect(response.status).toBe(403);
    expect(response.body).toEqual({ error: "Grant revoked", reasonCode: "grant_revoked" });
    expect(executeTool).not.toHaveBeenCalled();
  });

  it("keeps unknown internal errors redacted", async () => {
    executeTool.mockRejectedValue(new Error("private internal failure"));
    const response = await request(app()).post(`${prefix}/tools-call`).send(call);
    expect(response.status).toBe(500);
    expect(response.body).toEqual({ error: "Internal server error" });
    expect(executeTool).toHaveBeenCalledTimes(1);
  });

  it("denies disabled keys before connector discovery", async () => {
    const response = await request(app(false)).post(`${prefix}/tools-call`).send(call);
    expect(response.status).toBe(403);
    expect(listToolsForSession).not.toHaveBeenCalled();
    expect(executeTool).not.toHaveBeenCalled();
  });

  it("denies tools outside the current assigned catalog", async () => {
    const response = await request(app()).post(`${prefix}/tools-call`).send({ ...call, name: "foreign:list" });
    expect(response.status).toBe(403);
    expect(executeTool).not.toHaveBeenCalled();
  });

  it("preserves successful execution and its stable scoped operation key", async () => {
    const application = app();
    for (let i = 0; i < 2; i++) {
      const response = await request(application).post(`${prefix}/tools-call`).set("Authorization", "Bearer test-only").send(call);
      expect(response.status).toBe(200);
      expect(response.body).toEqual({ items: [] });
    }
    const first = executeTool.mock.calls[0][0];
    expect(first).toMatchObject({ sessionToken: "test-only", sessionBridge: true, tool: tool.name, parameters: call.arguments });
    expect(first.idempotencyKey).toMatch(/^session-bridge:[a-f0-9]{64}$/);
    expect(executeTool.mock.calls[1][0].idempotencyKey).toBe(first.idempotencyKey);
  });
});
