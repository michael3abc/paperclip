import express, { type ErrorRequestHandler } from "express";
import request from "supertest";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Db } from "@paperclipai/db";
const mocks = vi.hoisted(() => ({ company: vi.fn(), quotas: vi.fn() }));
vi.mock("../services/companies.js", () => ({ companyService: () => ({ getById: mocks.company }) }));
vi.mock("../services/dashboard.js", () => ({ dashboardService: () => ({}) }));
vi.mock("../services/recovery-observability.js", () => ({ recoveryObservabilityService: () => ({}), DEFAULT_RECOVERY_RATE_THRESHOLD_PERCENT: 10, MAX_WINDOW_WEEKS: 52 }));
vi.mock("../services/company-subscription-quotas.js", () => ({ fetchCompanySubscriptionQuotas: mocks.quotas }));
import { dashboardRoutes } from "../routes/dashboard.js";

function app(actor: Record<string, unknown>) {
  const result = express();
  result.use((req, _res, next) => { req.actor = actor as typeof req.actor; next(); });
  result.use(dashboardRoutes({} as Db));
  result.use(((err, _req, res, _next) => { res.status(err.status ?? 500).json({ error: err.message }); }) as ErrorRequestHandler);
  return result;
}
const url = "/companies/00000000-0000-4000-8000-000000000001/dashboard/subscription-quotas";
beforeEach(() => { vi.clearAllMocks(); mocks.company.mockResolvedValue({ id: "company" }); mocks.quotas.mockResolvedValue([{ provider: "openai", ok: true, windows: [] }]); });

describe("dashboard host subscription quota authorization", () => {
  it.each([
    { type: "none" }, { type: "agent", companyId: "00000000-0000-4000-8000-000000000001" },
    { type: "board", source: "session", isInstanceAdmin: false, companyIds: ["00000000-0000-4000-8000-000000000001"] },
  ])("denies non-operators before reading any account ($type)", async (actor) => {
    const res = await request(app(actor)).get(url);
    expect([401, 403]).toContain(res.status);
    expect(mocks.quotas).not.toHaveBeenCalled();
    expect(mocks.company).not.toHaveBeenCalled();
  });
  it("rejects nonexistent companies before touching host credentials", async () => {
    mocks.company.mockResolvedValue(null);
    const res = await request(app({ type: "board", isInstanceAdmin: true, companyIds: ["00000000-0000-4000-8000-000000000001"] })).get(url);
    expect(res.status).toBe(404);
    expect(mocks.quotas).not.toHaveBeenCalled();
  });
  it("returns operator-only snapshots with no browser caching", async () => {
    const res = await request(app({ type: "board", isInstanceAdmin: true, companyIds: ["00000000-0000-4000-8000-000000000001"] })).get(url);
    expect(res.status).toBe(200);
    expect(res.headers["cache-control"]).toBe("no-store");
    expect(res.body[0].provider).toBe("openai");
    expect(mocks.quotas).toHaveBeenCalledWith(expect.anything(), "00000000-0000-4000-8000-000000000001");
  });
  it("does not grant an instance administrator access to an unrelated company", async () => {
    const res = await request(app({ type: "board", isInstanceAdmin: true, companyIds: ["another-company"] })).get(url);
    expect(res.status).toBe(403);
    expect(mocks.quotas).not.toHaveBeenCalled();
  });
});
