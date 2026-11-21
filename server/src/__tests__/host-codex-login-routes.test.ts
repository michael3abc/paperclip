import express from "express";
import request from "supertest";
import { beforeEach, expect, it, vi } from "vitest";
const mocks = vi.hoisted(() => ({ list: vi.fn(), start: vi.fn(), check: vi.fn(), session: vi.fn() }));
vi.mock("../services/host-codex-login.js", () => ({ listHostCodexLogins: mocks.list, startHostCodexLogin: mocks.start, checkHostCodexLogin: mocks.check, hostCodexSession: mocks.session }));
vi.mock("../services/dashboard.js", () => ({ dashboardService: () => ({}) }));
vi.mock("../services/recovery-observability.js", () => ({ recoveryObservabilityService: () => ({}), MAX_WINDOW_WEEKS: 12, DEFAULT_RECOVERY_RATE_THRESHOLD_PERCENT: 50 }));
vi.mock("../services/companies.js", () => ({ companyService: () => ({ getById: async () => ({ id: "company" }) }) }));
import { dashboardRoutes } from "../routes/dashboard.js";
const base = "/api/companies/company/dashboard/host-codex";
function app(actor: Record<string, unknown>) {
  const app = express(); app.use(express.json());
  app.use((req, _res, next) => { req.actor = actor as typeof req.actor; next(); });
  app.use("/api", dashboardRoutes({} as never));
  app.use((error: { status?: number; message: string }, _req: express.Request, res: express.Response, _next: express.NextFunction) => res.status(error.status ?? 500).json({ error: error.message }));
  return app;
}
const owner = { type: "board", source: "session", isInstanceAdmin: true, userId: "owner", companyIds: ["company"] };
beforeEach(() => { vi.clearAllMocks(); mocks.list.mockResolvedValue([]); mocks.start.mockResolvedValue({ id: "s1" }); mocks.session.mockReturnValue({ status: "waiting" }); mocks.check.mockResolvedValue({ loggedIn: false }); });
it("denies agents, ordinary members and foreign-company admins on every endpoint before CLI work", async () => {
  for (const actor of [{ type: "agent", companyId: "company" }, { ...owner, isInstanceAdmin: false }, { ...owner, companyIds: ["other"] }]) {
    const client = request(app(actor));
    for (const response of [
      await client.get(base), await client.post(base + "/host/check").send({}),
      await client.post(base + "/host/login").send({}), await client.get(base + "/sessions/s1"),
      await client.post(base + "/sessions/s1/cancel").send({}),
    ]) expect(response.status).toBe(403);
  }
  for (const mock of Object.values(mocks)) expect(mock).not.toHaveBeenCalled();
});
it("binds operations to company/user, ignores client commands and disables response caching", async () => {
  const client = request(app(owner));
  const responses = [
    await client.get(base),
    await client.post(base + "/host/check").send({ command: "/untrusted/check", codexHome: "/untrusted" }),
    await client.post(base + "/host/login").send({ command: "/untrusted/login", codexHome: "/untrusted", sshAlias: "untrusted" }),
    await client.get(base + "/sessions/s1"),
    await client.post(base + "/sessions/s1/cancel").send({}),
  ];
  for (const response of responses) {
    expect(response.status).toBe(200);
    expect(response.headers["cache-control"]).toBe("no-store");
    expect(response.headers["referrer-policy"]).toBe("no-referrer");
  }
  expect(mocks.list).toHaveBeenCalledWith("company");
  expect(mocks.check).toHaveBeenCalledWith("company", "host");
  expect(mocks.start).toHaveBeenCalledExactlyOnceWith("company", "owner", "host");
  expect(mocks.session.mock.calls).toEqual([["company", "owner", "s1"], ["company", "owner", "s1", "cancel"]]);
});
it("documents the human-only administrator boundary for all five operations", async () => {
  const { buildOpenApiDocument } = await import("../routes/openapi.js");
  const document = buildOpenApiDocument();
  for (const [suffix, method] of [["", "get"], ["/{hostId}/check", "post"], ["/{hostId}/login", "post"], ["/sessions/{id}", "get"], ["/sessions/{id}/cancel", "post"]] as const) {
    const operation = document.paths["/api/companies/{companyId}/dashboard/host-codex" + suffix]![method]!;
    expect((operation as Record<string, unknown>)["x-paperclip-authorization"]).toEqual({ actor: "board", instanceAdmin: true });
    expect((operation as Record<string, unknown>)["x-paperclip-transport"]).toBe("protocol");
  }
}, 60_000);
