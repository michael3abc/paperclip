import express from "express";
import request from "supertest";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { HttpError } from "../errors.js";
import { errorHandler } from "../middleware/error-handler.js";

const login = vi.hoisted(() => ({ submitRedirect: vi.fn(), submitCode: vi.fn() }));
vi.mock("../services/local-ai-login.js", () => ({ localAiLoginService: () => login }));
import { aiConnectionRoutes } from "../routes/ai-connections.js";

const companyId = "11111111-1111-4111-8111-111111111111";
const sessionId = "22222222-2222-4222-8222-222222222222";
const canary = "http://127.0.0.1:18973/?state=route-state-canary&code=route-code-canary";

function app(actor: Record<string, unknown>, options: Parameters<typeof aiConnectionRoutes>[1] = {}) {
  const server = express();
  server.use(express.json());
  server.use((req, _res, next) => { (req as any).actor = actor; next(); });
  server.use("/api", aiConnectionRoutes({} as never, options));
  server.use(errorHandler);
  return server;
}
const board = { type: "board", source: "session", userId: "alice", companyIds: [companyId], memberships: [{ companyId, status: "active", membershipRole: "member" }] };
const url = `/api/companies/${companyId}/ai-connections/local/attempts/${sessionId}/redirect`;

describe("POST local attempt redirect address", () => {
  beforeEach(() => { login.submitRedirect.mockReset(); });

  it("hands the pasted address to the owning user's attempt without caching or echoing it", async () => {
    login.submitRedirect.mockResolvedValue(undefined);
    const response = await request(app(board)).post(url).send({ redirectUrl: `  ${canary}  ` });
    expect(response.status).toBe(200);
    expect(response.body).toEqual({ ok: true });
    expect(response.headers["cache-control"]).toBe("no-store");
    expect(login.submitRedirect).toHaveBeenCalledWith(companyId, "alice", sessionId, canary);
    expect(JSON.stringify(response.body)).not.toContain("canary");
  });

  it("returns the service's fixed rejection copy and never the address", async () => {
    login.submitRedirect.mockRejectedValue(new HttpError(422, "That address belongs to a different sign-in attempt."));
    const response = await request(app(board)).post(url).send({ redirectUrl: canary });
    expect(response.status).toBe(422);
    expect(JSON.stringify(response.body)).not.toContain("canary");
  });

  it.each([
    ["an empty address", { redirectUrl: "   " }],
    ["an oversized address", { redirectUrl: "http://127.0.0.1/?" + "a".repeat(4100) }],
    ["a missing address", {}],
    ["an unknown property", { redirectUrl: canary, extra: true }],
    ["the code route's field", { browserCode: "fixture-code" }],
  ])("validates %s before reaching the service", async (_label, body) => {
    const response = await request(app(board)).post(url).send(body);
    expect(response.status).toBe(400);
    expect(login.submitRedirect).not.toHaveBeenCalled();
    expect(JSON.stringify(response.body)).not.toContain("canary");
  });

  it("rejects a non-uuid attempt, another company's board user and non-board actors", async () => {
    expect((await request(app(board)).post(url.replace(sessionId, "not-a-uuid")).send({ redirectUrl: canary })).status).toBeGreaterThanOrEqual(400);
    expect((await request(app({ ...board, companyIds: ["33333333-3333-4333-8333-333333333333"], memberships: [] })).post(url).send({ redirectUrl: canary })).status).toBe(403);
    expect((await request(app({ type: "agent", agentId: "agent", companyId })).post(url).send({ redirectUrl: canary })).status).toBeGreaterThanOrEqual(401);
    expect(login.submitRedirect).not.toHaveBeenCalled();
  });

  it("is unavailable on a hosted instance", async () => {
    const hosted = await request(app(board, { deploymentMode: "authenticated", deploymentExposure: "public", trustedLocalStdioRuntimeHost: "" })).post(url).send({ redirectUrl: canary });
    expect(hosted.status).toBe(422);
    expect(login.submitRedirect).not.toHaveBeenCalled();
  });
});
