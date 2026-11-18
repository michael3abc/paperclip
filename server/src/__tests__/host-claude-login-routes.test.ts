import express from "express";
import request from "supertest";
import { beforeEach, expect, it, vi } from "vitest";
const mocks = vi.hoisted(() => ({ list: vi.fn(), start: vi.fn(), check: vi.fn(), session: vi.fn() }));
vi.mock("../services/host-claude-login.js", () => ({ listHostClaudeLogins: mocks.list, startHostClaudeLogin: mocks.start, checkHostClaudeLogin: mocks.check, hostClaudeSession: mocks.session }));
vi.mock("../services/dashboard.js", () => ({ dashboardService: () => ({}) }));
vi.mock("../services/recovery-observability.js", () => ({ recoveryObservabilityService: () => ({}), MAX_WINDOW_WEEKS: 12, DEFAULT_RECOVERY_RATE_THRESHOLD_PERCENT: 50 }));
vi.mock("../services/companies.js", () => ({ companyService: () => ({ getById: async () => ({ id: "company" }) }) }));
import { dashboardRoutes } from "../routes/dashboard.js";
const base = "/api/companies/company/dashboard/host-claude";
function app(actor: Record<string, unknown>) {
  const app = express(); app.use(express.json());
  app.use((req, _res, next) => { req.actor = actor as typeof req.actor; next(); });
  app.use("/api", dashboardRoutes({} as never));
  app.use((error: { status?: number; message: string }, _req: express.Request, res: express.Response, _next: express.NextFunction) => res.status(error.status ?? 500).json({ error: error.message }));
  return app;
}
const owner = { type: "board", source: "session", isInstanceAdmin: true, userId: "owner", companyIds: ["company"] };
beforeEach(() => { vi.clearAllMocks(); mocks.list.mockResolvedValue([]); mocks.start.mockResolvedValue({ id: "s1" }); mocks.session.mockReturnValue({ status: "waiting" }); });
it("denies agents, ordinary members and foreign-company admins before CLI work", async () => {
  for (const actor of [{ type: "agent", companyId: "company" }, { ...owner, isInstanceAdmin: false }, { ...owner, companyIds: ["other"] }]) {
    expect((await request(app(actor)).post(base + "/host/login").send({})).status).toBe(403);
  }
  expect(mocks.start).not.toHaveBeenCalled();
});
it("binds own session to company/user and disables response caching", async () => {
  const res = await request(app(owner)).get(base);
  expect(res.status).toBe(200); expect(res.headers["cache-control"]).toBe("no-store");
  await request(app(owner)).post(base + "/host/login").send({ command: "ignored" });
  expect(mocks.start).toHaveBeenCalledWith("company", "owner", "host");
  await request(app(owner)).post(base + "/sessions/s1/code").send({ browserCode: "fixture" });
  expect(mocks.session).toHaveBeenCalledWith("company", "owner", "s1", "code", "fixture");
});
it("documents the human-only administrator boundary", async () => {
  const { buildOpenApiDocument } = await import("../routes/openapi.js");
  const document = buildOpenApiDocument();
  const operation = document.paths["/api/companies/{companyId}/dashboard/host-claude/{hostId}/login"]!.post!;
  expect((operation as Record<string, unknown>)["x-paperclip-authorization"]).toEqual({ actor: "board", instanceAdmin: true });
  expect((operation as Record<string, unknown>)["x-paperclip-transport"]).toBe("protocol");
});
