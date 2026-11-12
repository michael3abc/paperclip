import { randomUUID } from "node:crypto";
import express from "express";
import request from "supertest";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Db } from "@paperclipai/db";
import { sessionBridgeRoutes } from "../routes/session-bridge.js";
import { errorHandler } from "../middleware/error-handler.js";

const mocks = vi.hoisted(() => ({ decide: vi.fn(), proof: vi.fn(), poll: vi.fn() }));
vi.mock("../services/access.js", () => ({ accessService: () => ({ decide: mocks.decide }) }));
vi.mock("../services/session-bridge-worker-cards.js", () => ({ sessionBridgeWorkerCardProof: mocks.proof }));
vi.mock("../services/session-bridge-chat.js", () => ({ sessionBridgeChatBinding: async () => null, sessionBridgeChatService: () => ({ pending: async () => [] }) }));
vi.mock("../services/session-bridge-events.js", async importOriginal => {
  const actual = await importOriginal<typeof import("../services/session-bridge-events.js")>();
  return { ...actual, sessionBridgeEventsService: (_db: unknown, options: unknown) => ({ poll: () => mocks.poll(options) }) };
});
const companyId = randomUUID(), projectId = randomUUID(), issueId = randomUUID(), agentId = randomUUID(), runId = randomUUID();
const issue = { id: issueId, companyId, projectId, parentId: null, assigneeAgentId: randomUUID(), assigneeUserId: null, status: "in_progress" };
function app(projectIds = [projectId], conversationAgentId = agentId, workerCardOnly = false) {
  const db = { select: () => ({ from: () => ({ where: async () => [issue] }) }) } as unknown as Db;
  const result = express(); result.use(express.json());
  result.use((req, _res, next) => {
    req.actor = { type: "agent", source: "agent_key", agentId, companyId, keyId: randomUUID(),
      keyScope: { kind: "session_bridge", projectIds, conversationAgentId, workerCardOnly } }; next();
  });
  result.use("/api", sessionBridgeRoutes(db)); result.use(errorHandler); return result;
}
const prefix = "/api/agents/me/session-bridge";
beforeEach(() => {
  vi.clearAllMocks(); mocks.decide.mockResolvedValue({ allowed: true });
  mocks.proof.mockResolvedValue({ issueId, eligible: true });
  mocks.poll.mockImplementation(async ({ canReadWorkerIssue }) => ({
    cursor: "opaque", hasMore: false, events: await canReadWorkerIssue(issueId, projectId) ? [{ type: "worker_card_changed", runId }] : [],
  }));
});
describe("worker card HTTP read authorization", () => {
  it("observer-only events omit chat inbox, holds, native control and agent details", async () => {
    mocks.poll.mockResolvedValue({ cursor: "opaque", hasMore: false, agent: { status: "idle" },
      events: [{ type: "agent_paused" }, { type: "worker_card_changed", runId }],
      snapshot: { agent: { status: "idle" }, activeHolds: [{ reason: "private" }], workerCardRunIds: [runId] } });
    const result = await request(app([projectId], agentId, true)).get(`${prefix}/events`).query({ wait: 0 });
    expect(result.status).toBe(200);
    expect(result.body).toEqual({ cursor: "opaque", hasMore: false, events: [{ type: "worker_card_changed", runId }], snapshot: { workerCardRunIds: [runId] } });
  });
  it("proof requires current issue read and disables caching", async () => {
    const result = await request(app()).get(`${prefix}/worker-card-proof`).query({ runId });
    expect(result.status).toBe(200); expect(result.headers["cache-control"]).toBe("no-store");
    expect(mocks.decide).toHaveBeenCalledWith(expect.objectContaining({ action: "issue:read", resource: expect.objectContaining({ issueId, projectId, companyId }) }));
  });
  it("redacts proof when issue read has been denied", async () => {
    mocks.decide.mockResolvedValue({ allowed: false });
    const result = await request(app()).get(`${prefix}/worker-card-proof`).query({ runId });
    expect(result.status).toBe(404); expect(result.body).not.toHaveProperty("eligible");
  });
  it("key project scope applies to events before the issue authorization service", async () => {
    const result = await request(app([])).get(`${prefix}/events`).query({ wait: 0 });
    expect(result.status).toBe(200); expect(result.body.events).toEqual([]); expect(mocks.decide).not.toHaveBeenCalled();
  });
  it("event projection uses issue read from this request", async () => {
    const first = await request(app()).get(`${prefix}/events`).query({ wait: 0 });
    expect(first.body.events).toEqual([{ type: "worker_card_changed", runId }]);
    mocks.decide.mockResolvedValue({ allowed: false });
    const second = await request(app()).get(`${prefix}/events`).query({ wait: 0 });
    expect(second.body.events).toEqual([]);
  });
  it("non-conversation keys cannot receive worker-card events or proof", async () => {
    const application = app([projectId], randomUUID());
    const event = await request(application).get(`${prefix}/events`).query({ wait: 0 });
    expect(event.body.events).toEqual([]);
    const proof = await request(application).get(`${prefix}/worker-card-proof`).query({ runId });
    expect(proof.status).toBe(403); expect(mocks.proof).not.toHaveBeenCalled(); expect(mocks.decide).not.toHaveBeenCalled();
  });
});
