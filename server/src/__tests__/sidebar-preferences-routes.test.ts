import express from "express";
import request from "supertest";
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

const mockSidebarPreferenceService = vi.hoisted(() => ({
  getCompanyOrder: vi.fn(),
  upsertCompanyOrder: vi.fn(),
  getProjectOrder: vi.fn(),
  upsertCompanyPreference: vi.fn(),
}));
const mockLogActivity = vi.hoisted(() => vi.fn());

function registerModuleMocks() {
  vi.doMock("../services/index.js", () => ({
    sidebarPreferenceService: () => mockSidebarPreferenceService,
    logActivity: mockLogActivity,
  }));
}

async function createApp(actor: Record<string, unknown>) {
  const { errorHandler } = await import("../middleware/index.js");
  const { sidebarPreferenceRoutes } = await import("../routes/sidebar-preferences.js");
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    req.actor = actor as never;
    next();
  });
  app.use("/api", sidebarPreferenceRoutes({} as never));
  app.use(errorHandler);
  return app;
}

const ORDERED_IDS = [
  "11111111-1111-4111-8111-111111111111",
  "22222222-2222-4222-8222-222222222222",
];
const EXCLUDED_AGENT_IDS = [
  "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
  "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
];

describe("sidebar preference routes", () => {
  // The first import of the middleware and route graph transforms and loads the
  // whole server dependency tree once (15-35s cold). Do that one-time work here,
  // under the hook timeout, so the per-test timeout measures only the route
  // behavior. Every test still builds its own app from freshly reset modules
  // (beforeEach), and no assertion below depends on this warm-up.
  beforeAll(async () => {
    registerModuleMocks();
    await import("../middleware/index.js");
    await import("../routes/sidebar-preferences.js");
  }, 120_000);

  beforeEach(() => {
    vi.resetModules();
    vi.doUnmock("../services/index.js");
    vi.doUnmock("../routes/sidebar-preferences.js");
    vi.doUnmock("../routes/authz.js");
    vi.doUnmock("../middleware/index.js");
    registerModuleMocks();
    vi.clearAllMocks();
    mockSidebarPreferenceService.getCompanyOrder.mockResolvedValue({
      orderedIds: ORDERED_IDS,
      updatedAt: null,
    });
    mockSidebarPreferenceService.upsertCompanyOrder.mockResolvedValue({
      orderedIds: ORDERED_IDS,
      updatedAt: null,
    });
    mockSidebarPreferenceService.getProjectOrder.mockResolvedValue({
      orderedIds: ORDERED_IDS,
      excludedPmStatusAgentIds: [],
      updatedAt: null,
    });
    mockSidebarPreferenceService.upsertCompanyPreference.mockImplementation(
      async (_companyId: string, _userId: string, patch: { orderedIds?: string[]; excludedPmStatusAgentIds?: string[] }) => ({
        orderedIds: patch.orderedIds ?? ORDERED_IDS,
        excludedPmStatusAgentIds: patch.excludedPmStatusAgentIds ?? [],
        updatedAt: null,
      }),
    );
  });

  it("returns company rail order for board users", async () => {
    const app = await createApp({
      type: "board",
      userId: "user-1",
      source: "session",
      isInstanceAdmin: false,
      companyIds: ["company-1"],
    });

    const res = await request(app).get("/api/sidebar-preferences/me");

    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      orderedIds: ORDERED_IDS,
      updatedAt: null,
    });
    expect(mockSidebarPreferenceService.getCompanyOrder).toHaveBeenCalledWith("user-1");
  });

  it("updates company rail order for board users", async () => {
    const app = await createApp({
      type: "board",
      userId: "user-1",
      source: "local_implicit",
      isInstanceAdmin: true,
      companyIds: ["company-1"],
    });

    const res = await request(app)
      .put("/api/sidebar-preferences/me")
      .send({ orderedIds: ORDERED_IDS });

    expect(res.status).toBe(200);
    expect(mockSidebarPreferenceService.upsertCompanyOrder).toHaveBeenCalledWith("user-1", ORDERED_IDS);
  });

  it("returns project order for companies the board user can access", async () => {
    const app = await createApp({
      type: "board",
      userId: "user-1",
      source: "session",
      isInstanceAdmin: false,
      companyIds: ["company-1"],
    });

    const res = await request(app).get("/api/companies/company-1/sidebar-preferences/me");

    expect(res.status).toBe(200);
    expect(mockSidebarPreferenceService.getProjectOrder).toHaveBeenCalledWith("company-1", "user-1");
    // Default: nobody is excluded, so every project PM keeps its sidebar status.
    expect(res.body).toEqual({ orderedIds: ORDERED_IDS, excludedPmStatusAgentIds: [], updatedAt: null });
  });

  it("keeps a legacy orderedIds-only company write from touching the exclusion list", async () => {
    const app = await createApp({
      type: "board",
      userId: "user-1",
      source: "session",
      isInstanceAdmin: false,
      companyIds: ["company-1"],
    });

    const res = await request(app)
      .put("/api/companies/company-1/sidebar-preferences/me")
      .send({ orderedIds: ORDERED_IDS });

    expect(res.status).toBe(200);
    // The patch asks for no exclusion change (undefined = leave the stored column alone).
    const patch = mockSidebarPreferenceService.upsertCompanyPreference.mock.calls[0]?.[2];
    expect(patch.orderedIds).toEqual(ORDERED_IDS);
    expect(patch.excludedPmStatusAgentIds).toBeUndefined();
    expect(mockLogActivity).toHaveBeenCalledWith(
      {} as never,
      expect.objectContaining({ action: "sidebar_preferences.project_order_updated" }),
    );
    expect(mockLogActivity).toHaveBeenCalledTimes(1);
  });

  it("saves the PM status exclusion list for the board user's own company preference only", async () => {
    const app = await createApp({
      type: "board",
      userId: "user-1",
      source: "session",
      isInstanceAdmin: false,
      companyIds: ["company-1"],
    });

    const res = await request(app)
      .put("/api/companies/company-1/sidebar-preferences/me")
      .send({ excludedPmStatusAgentIds: EXCLUDED_AGENT_IDS });

    expect(res.status).toBe(200);
    expect(res.body.excludedPmStatusAgentIds).toEqual(EXCLUDED_AGENT_IDS);
    expect(mockSidebarPreferenceService.upsertCompanyPreference).toHaveBeenCalledWith("company-1", "user-1", {
      orderedIds: undefined,
      excludedPmStatusAgentIds: EXCLUDED_AGENT_IDS,
    });
    expect(mockLogActivity).toHaveBeenCalledTimes(1);
    expect(mockLogActivity).toHaveBeenCalledWith(
      {} as never,
      expect.objectContaining({
        companyId: "company-1",
        action: "sidebar_preferences.pm_status_exclusions_updated",
        details: { userId: "user-1", excludedPmStatusAgentIds: EXCLUDED_AGENT_IDS },
      }),
    );
  });

  it("accepts an empty exclusion list so the Owner can clear it", async () => {
    const app = await createApp({
      type: "board",
      userId: "user-1",
      source: "session",
      isInstanceAdmin: false,
      companyIds: ["company-1"],
    });

    const res = await request(app)
      .put("/api/companies/company-1/sidebar-preferences/me")
      .send({ excludedPmStatusAgentIds: [] });

    expect(res.status).toBe(200);
    expect(mockSidebarPreferenceService.upsertCompanyPreference).toHaveBeenCalledWith("company-1", "user-1", {
      orderedIds: undefined,
      excludedPmStatusAgentIds: [],
    });
  });

  it("rejects an empty body and malformed agent ids before touching the service", async () => {
    const app = await createApp({
      type: "board",
      userId: "user-1",
      source: "session",
      isInstanceAdmin: false,
      companyIds: ["company-1"],
    });

    const empty = await request(app).put("/api/companies/company-1/sidebar-preferences/me").send({});
    const bad = await request(app)
      .put("/api/companies/company-1/sidebar-preferences/me")
      .send({ excludedPmStatusAgentIds: ["momo"] });

    expect(empty.status).toBe(400);
    expect(bad.status).toBe(400);
    expect(mockSidebarPreferenceService.upsertCompanyPreference).not.toHaveBeenCalled();
    expect(mockLogActivity).not.toHaveBeenCalled();
  });

  it("rejects company-scoped exclusion writes without company access and from agent callers", async () => {
    const otherCompanyUser = await createApp({
      type: "board",
      userId: "user-1",
      source: "session",
      isInstanceAdmin: false,
      companyIds: ["company-2"],
    });
    const agent = await createApp({
      type: "agent",
      agentId: "agent-1",
      companyId: "company-1",
      source: "agent_key",
    });

    const denied = await request(otherCompanyUser)
      .put("/api/companies/company-1/sidebar-preferences/me")
      .send({ excludedPmStatusAgentIds: EXCLUDED_AGENT_IDS });
    const agentDenied = await request(agent)
      .put("/api/companies/company-1/sidebar-preferences/me")
      .send({ excludedPmStatusAgentIds: EXCLUDED_AGENT_IDS });

    expect(denied.status).toBe(403);
    expect(agentDenied.status).toBe(403);
    expect(mockSidebarPreferenceService.upsertCompanyPreference).not.toHaveBeenCalled();
  });

  it("logs project order updates for company-scoped writes", async () => {
    const app = await createApp({
      type: "board",
      userId: "user-1",
      source: "session",
      isInstanceAdmin: false,
      companyIds: ["company-1"],
      runId: "run-1",
    });

    const res = await request(app)
      .put("/api/companies/company-1/sidebar-preferences/me")
      .send({ orderedIds: ORDERED_IDS });

    expect(res.status).toBe(200);
    expect(mockSidebarPreferenceService.upsertCompanyPreference).toHaveBeenCalledWith("company-1", "user-1", {
      orderedIds: ORDERED_IDS,
      excludedPmStatusAgentIds: undefined,
    });
    expect(mockLogActivity).toHaveBeenCalledWith(
      {} as never,
      expect.objectContaining({
        companyId: "company-1",
        action: "sidebar_preferences.project_order_updated",
        details: expect.objectContaining({
          userId: "user-1",
          orderedIds: ORDERED_IDS,
        }),
      }),
    );
  });

  it("rejects company-scoped reads when the board user lacks company access", async () => {
    const app = await createApp({
      type: "board",
      userId: "user-1",
      source: "session",
      isInstanceAdmin: false,
      companyIds: ["company-2"],
    });

    const res = await request(app).get("/api/companies/company-1/sidebar-preferences/me");

    expect(res.status).toBe(403);
    expect(mockSidebarPreferenceService.getProjectOrder).not.toHaveBeenCalled();
  });

  it("rejects agent callers", async () => {
    const app = await createApp({
      type: "agent",
      agentId: "agent-1",
      companyId: "company-1",
      source: "agent_key",
    });

    const res = await request(app).get("/api/sidebar-preferences/me");

    expect(res.status).toBe(403);
    expect(mockSidebarPreferenceService.getCompanyOrder).not.toHaveBeenCalled();
  });
});
