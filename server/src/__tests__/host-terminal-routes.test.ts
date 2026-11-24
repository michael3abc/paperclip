import express from "express";
import request from "supertest";
import { beforeEach, expect, it, vi } from "vitest";
const mocks = vi.hoisted(() => ({ list: vi.fn(), create: vi.fn() }));
vi.mock("../services/host-terminal-registry.js", () => ({ listTerminalHosts: mocks.list }));
vi.mock("../services/companies.js", () => ({ companyService: () => ({ getById: async () => ({ id: "company" }) }) }));
import { hostTerminalRoutes } from "../routes/host-terminals.js";
const base = "/api/companies/company/host-terminals";
const owner = { type: "board", source: "session", isInstanceAdmin: true, userId: "owner", companyIds: ["company"] };
function app(actor: Record<string, unknown>) {
  const app = express(); app.use(express.json());
  app.use((req, _res, next) => { req.actor = actor as typeof req.actor; next(); });
  app.use("/api", hostTerminalRoutes({} as never, { create: mocks.create } as never));
  app.use((error: { status?: number; message: string }, _req: express.Request, res: express.Response, _next: express.NextFunction) => res.status(error.status ?? 500).json({ error: error.message }));
  return app;
}
beforeEach(() => { vi.clearAllMocks(); mocks.list.mockResolvedValue([{ id: "local", label: "Local", sshAlias: "private", terminal: { cwd: "/private" } }]); mocks.create.mockResolvedValue({ id: "id", token: "token", expiresAt: "expiry" }); });
it.each([
  { type: "agent", source: "agent_key" }, { type: "agent", source: "agent_jwt" },
  { ...owner, type: "agent", runId: "run" }, { ...owner, source: "board_key" },
  { ...owner, source: "local_implicit" }, { ...owner, isInstanceAdmin: false },
  { ...owner, companyIds: ["foreign"] }, { ...owner, userId: undefined }, { type: "none" },
])("rejects non-human/admin/company authority before host work: %j", async actor => {
  expect((await request(app(actor)).get(base)).status).toBe(403);
  expect((await request(app(actor)).post(base + "/local/sessions").send({})).status).toBe(403);
  expect(mocks.list).not.toHaveBeenCalled(); expect(mocks.create).not.toHaveBeenCalled();
});
it("returns only host labels and creates a no-store human-scoped token", async () => {
  const response = await request(app(owner)).get(base);
  expect(response.body).toEqual([{ id: "local", label: "Local" }]);
  expect(response.headers["cache-control"]).toBe("no-store");
  const minted = await request(app(owner)).post(base + "/local/sessions").send({});
  expect(minted.status).toBe(201); expect(minted.headers["referrer-policy"]).toBe("no-referrer");
  expect(mocks.create).toHaveBeenCalledWith({ companyId: "company", userId: "owner", hostId: "local" });
});
it.each(["command", "shell", "cwd", "sshAlias", "env"])("rejects client-supplied %s", async key => {
  expect((await request(app(owner)).post(base + "/local/sessions").send({ [key]: "value" })).status).toBe(400);
  expect(mocks.create).not.toHaveBeenCalled();
});

it("documents host terminals as human-only instance-admin protocol operations", async () => {
  const { buildOpenApiDocument } = await import("../routes/openapi.js");
  const document = buildOpenApiDocument();
  for (const [path, method] of [["/api/companies/{companyId}/host-terminals", "get"],
    ["/api/companies/{companyId}/host-terminals/{hostId}/sessions", "post"]] as const) {
    const operation = document.paths[path]![method]! as Record<string, unknown>;
    expect(operation["x-paperclip-authorization"]).toEqual({ actor: "board", instanceAdmin: true });
    expect(operation["x-paperclip-transport"]).toBe("protocol");
  }
}, 60_000);
