import { randomUUID } from "node:crypto";
import { mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import express from "express";
import request from "supertest";
import { eq } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { activityLog, agentConfigRevisions, agents, companies, companyMemberships, createDb, principalPermissionGrants } from "@paperclipai/db";
import { getEmbeddedPostgresTestSupport, startEmbeddedPostgresTestDatabase } from "./helpers/embedded-postgres.js";
import { errorHandler } from "../middleware/index.js";
import { agentRoutes } from "../routes/agents.js";
import { registerServerAdapter, unregisterServerAdapter } from "../adapters/index.js";
import { preserveFixedWorkspacePermission } from "../lib/agent-fixed-workspace-permission.js";

// HOM-611: a board-granted, default-off permission lets an agent set another
// CC Pocket agent's fixed working directory; every other guard stays.

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;
type Db = ReturnType<typeof createDb>;

describe("preserveFixedWorkspacePermission", () => {
  it("keeps the saved grant and refuses a change outside the board route", () => {
    expect(preserveFixedWorkspacePermission({ canConfigureFixedWorkspace: true }, { canCreateAgents: true }))
      .toEqual({ canCreateAgents: true, canConfigureFixedWorkspace: true });
    expect(preserveFixedWorkspacePermission({}, { canCreateAgents: true })).toEqual({ canCreateAgents: true });
    expect(() => preserveFixedWorkspacePermission({}, { canConfigureFixedWorkspace: true })).toThrow(/Only the board/);
    expect(() => preserveFixedWorkspacePermission({ canConfigureFixedWorkspace: true }, { canConfigureFixedWorkspace: false }))
      .toThrow(/Only the board/);
    // The board route writes an explicit false so merge-style writers cannot resurrect a revoked grant.
    expect(preserveFixedWorkspacePermission({ canConfigureFixedWorkspace: true }, { canConfigureFixedWorkspace: false }, { allowGrantChange: true }))
      .toEqual({ canConfigureFixedWorkspace: false });
  });
});

describeEmbeddedPostgres("agent fixed working directory permission", () => {
  let db!: Db;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;
  let tmpRoot = "";
  let allowedRoot = "";
  const previousHome = process.env.PAPERCLIP_HOME;
  const previousInstance = process.env.PAPERCLIP_INSTANCE_ID;
  const previousHosts = process.env.PAPERCLIP_CCPOCKET_HOSTS_FILE;
  const companyId = randomUUID();
  const otherCompanyId = randomUUID();
  const testEnvironment = vi.fn(async (ctx: { config: Record<string, unknown> }) => {
    const cwd = String(ctx.config.cwd ?? "");
    const inside = cwd === allowedRoot || cwd.startsWith(`${allowedRoot}/`);
    return { adapterType: "ccpocket_bridge", status: inside ? "pass" as const : "fail" as const, testedAt: new Date().toISOString(),
      checks: inside ? [] : [{ code: "ccpocket_environment", level: "error" as const, message: "Workspace is outside Bridge allowed directories" }] };
  });

  beforeAll(async () => {
    tmpRoot = await realpath(await mkdtemp(path.join(os.tmpdir(), "paperclip-fixed-workspace-")));
    allowedRoot = path.join(tmpRoot, "allowed");
    await mkdir(allowedRoot, { recursive: true });
    process.env.PAPERCLIP_HOME = path.join(tmpRoot, "home");
    process.env.PAPERCLIP_INSTANCE_ID = "vitest";
    process.env.PAPERCLIP_CCPOCKET_HOSTS_FILE = path.join(tmpRoot, "hosts.json");
    await writeFile(process.env.PAPERCLIP_CCPOCKET_HOSTS_FILE, JSON.stringify({ version: 1, hosts: [
      { id: "host-a", label: "A", companyIds: [companyId] },
      { id: "host-b", label: "B", companyIds: [otherCompanyId] },
    ] }));
    registerServerAdapter({
      type: "ccpocket_bridge", catalogScope: "company",
      execute: async () => ({ exitCode: 0, signal: null, timedOut: false }),
      listModels: async () => [
        { id: "host-a/claude/family:opus-5.5", label: "Opus" },
        { id: "host-b/claude/family:opus-5.5", label: "Opus B" },
      ],
      testEnvironment,
    } as unknown as Parameters<typeof registerServerAdapter>[0]);
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-fixed-workspace-");
    db = createDb(tempDb.connectionString);
  }, 60_000);

  afterEach(async () => {
    testEnvironment.mockClear();
    await db.delete(activityLog);
    await db.delete(agentConfigRevisions);
    await db.delete(principalPermissionGrants);
    await db.delete(companyMemberships);
    await db.delete(agents);
    await db.delete(companies);
  });

  afterAll(async () => {
    unregisterServerAdapter("ccpocket_bridge");
    await tempDb?.cleanup();
    for (const [key, value] of [["PAPERCLIP_HOME", previousHome], ["PAPERCLIP_INSTANCE_ID", previousInstance],
      ["PAPERCLIP_CCPOCKET_HOSTS_FILE", previousHosts]] as const) {
      if (value === undefined) delete process.env[key]; else process.env[key] = value;
    }
    await rm(tmpRoot, { recursive: true, force: true });
  });

  async function seed() {
    for (const id of [companyId, otherCompanyId]) {
      await db.insert(companies).values({ id, name: `Co ${id.slice(0, 6)}`,
        issuePrefix: `F${id.replace(/-/g, "").slice(0, 6).toUpperCase()}`, requireBoardApprovalForNewAgents: false });
    }
    const insertAgent = async (name: string, permissions: Record<string, unknown>, extra: Partial<typeof agents.$inferInsert> = {}) => {
      const [row] = await db.insert(agents).values({ companyId, name, role: "engineer", adapterType: "process",
        adapterConfig: {}, runtimeConfig: {}, permissions, ...extra }).returning();
      return row!;
    };
    const granted = await insertAgent("yoyo", { canCreateAgents: true, canConfigureFixedWorkspace: true });
    const plain = await insertAgent("plain", { canCreateAgents: true });
    const cwd = path.join(allowedRoot, "existing");
    const target = await insertAgent("target", { canCreateAgents: false }, { adapterType: "ccpocket_bridge",
      adapterConfig: { role: "main", binding: "fixed", provider: "claude", hostId: "host-a", model: "host-a/claude/family:opus-5.5", cwd },
      runtimeConfig: { workspaceBinding: { mode: "fixed", cwd } } });
    for (const agent of [granted, plain]) {
      await db.insert(companyMemberships).values({ companyId, principalType: "agent", principalId: agent.id, status: "active", membershipRole: "member" });
      await db.insert(principalPermissionGrants).values({ companyId, principalType: "agent", principalId: agent.id, permissionKey: "agents:configure" });
    }
    return { granted, plain, target };
  }

  function appFor(actor: Express.Request["actor"]) {
    const app = express();
    app.use(express.json());
    app.use((req, _res, next) => { req.actor = actor; next(); });
    app.use("/api", agentRoutes(db));
    app.use(errorHandler);
    return app;
  }
  const asAgent = (agentId: string, company = companyId) =>
    appFor({ type: "agent", agentId, companyId: company, source: "agent_key" } as Express.Request["actor"]);
  const board = () => appFor({ type: "board", userId: "local-board", source: "local_implicit" } as Express.Request["actor"]);

  function mainBody(cwd: string, overrides: { hostId?: string; model?: string; bindingCwd?: string; bindingHostId?: string } = {}) {
    const hostId = overrides.hostId ?? "host-a";
    return {
      name: `Main ${randomUUID().slice(0, 6)}`, role: "engineer", adapterType: "ccpocket_bridge",
      adapterConfig: { role: "main", binding: "fixed", provider: "claude", hostId, model: overrides.model ?? `${hostId}/claude/family:opus-5.5`, cwd },
      runtimeConfig: { heartbeat: { enabled: false, wakeOnDemand: true, maxConcurrentRuns: 1 },
        workspaceBinding: { mode: "fixed", cwd: overrides.bindingCwd ?? cwd, ...(overrides.bindingHostId ? { hostId: overrides.bindingHostId } : {}) } },
    };
  }

  it("keeps the 403 for agents without the grant on create, PATCH and rollback", async () => {
    const s = await seed();
    const created = await request(asAgent(s.plain.id)).post(`/api/companies/${companyId}/agents`).send(mainBody(path.join(allowedRoot, "new")));
    expect(created.status).toBe(403);
    expect(created.body.error).toMatch(/Only an operator, or an agent the board allowed/);

    const moved = path.join(allowedRoot, "moved");
    const patched = await request(asAgent(s.plain.id)).patch(`/api/agents/${s.target.id}`)
      .send({ adapterConfig: { cwd: moved }, runtimeConfig: { workspaceBinding: { mode: "fixed", cwd: moved } } });
    expect(patched.status).toBe(403);

    // A board edit creates a revision; rolling the binding back stays operator-only, even with the grant.
    const before = (await db.select().from(agentConfigRevisions).where(eq(agentConfigRevisions.agentId, s.target.id))).length;
    expect((await request(board()).patch(`/api/agents/${s.target.id}`)
      .send({ adapterConfig: { cwd: moved }, runtimeConfig: { workspaceBinding: { mode: "fixed", cwd: moved } } })).status).toBe(200);
    const revisions = await db.select().from(agentConfigRevisions).where(eq(agentConfigRevisions.agentId, s.target.id));
    expect(revisions.length).toBeGreaterThan(before);
    const revision = revisions.find((row) => (row.beforeConfig as { runtimeConfig?: { workspaceBinding?: { cwd?: string } } })
      .runtimeConfig?.workspaceBinding?.cwd === path.join(allowedRoot, "existing"))!;
    const toOriginal = await db.insert(agentConfigRevisions).values({ companyId, agentId: s.target.id, source: "patch",
      changedKeys: ["runtimeConfig"], beforeConfig: revision.afterConfig, afterConfig: revision.beforeConfig }).returning();
    for (const actor of [s.plain.id, s.granted.id]) {
      const rollback = await request(asAgent(actor)).post(`/api/agents/${s.target.id}/config-revisions/${toOriginal[0]!.id}/rollback`).send({});
      expect(rollback.status).toBe(403);
      expect(rollback.body.error).toMatch(/Only an operator can change a fixed working directory/);
    }
    expect(testEnvironment).not.toHaveBeenCalled();
  });

  it("lets an agent with the grant create a fixed-directory main and change another agent's directory", async () => {
    const s = await seed();
    const cwd = path.join(allowedRoot, "cctv");
    const created = await request(asAgent(s.granted.id)).post(`/api/companies/${companyId}/agents`).send(mainBody(cwd));
    expect(created.status, JSON.stringify(created.body)).toBe(201);
    expect(created.body.runtimeConfig.workspaceBinding).toEqual({ mode: "fixed", cwd });
    // The new agent never inherits the grant.
    expect(created.body.permissions).not.toHaveProperty("canConfigureFixedWorkspace");
    expect(testEnvironment).toHaveBeenCalledTimes(1);

    const moved = path.join(allowedRoot, "moved");
    const patched = await request(asAgent(s.granted.id)).patch(`/api/agents/${s.target.id}`)
      .send({ adapterConfig: { cwd: moved }, runtimeConfig: { workspaceBinding: { mode: "fixed", cwd: moved } } });
    expect(patched.status, JSON.stringify(patched.body)).toBe(200);
    expect(patched.body.runtimeConfig.workspaceBinding).toEqual({ mode: "fixed", cwd: moved });
  });

  it("still refuses other hosts, disallowed directories, mismatches and the agent's own binding", async () => {
    const s = await seed();
    const app = asAgent(s.granted.id);
    const post = (body: unknown) => request(app).post(`/api/companies/${companyId}/agents`).send(body);
    const inside = path.join(allowedRoot, "inside");

    const otherHost = await post(mainBody(inside, { hostId: "host-b" }));
    expect(otherHost.status).not.toBe(201);
    expect(otherHost.status).toBeGreaterThanOrEqual(400);

    const outside = await post(mainBody(path.join(tmpRoot, "outside")));
    expect(outside.status).toBe(422);
    expect(outside.body.details).toMatchObject({ code: "agent_fixed_workspace_unverified" });

    const cwdMismatch = await post(mainBody(inside, { bindingCwd: path.join(allowedRoot, "elsewhere") }));
    expect(cwdMismatch.status).toBe(422);

    const hostMismatch = await post(mainBody(inside, { bindingHostId: "host-b" }));
    expect(hostMismatch.status).toBe(422);
    expect(hostMismatch.body.details).toMatchObject({ code: "agent_fixed_workspace_host_mismatch" });

    const modelMismatch = await post(mainBody(inside, { model: "host-b/claude/family:opus-5.5" }));
    expect(modelMismatch.status).toBe(422);

    const projectPm = await post({ ...mainBody(inside), runtimeConfig: { workspaceBinding: { mode: "project_pm", projectId: randomUUID(), workerRoot: inside } } });
    expect(projectPm.status).toBe(403);

    const crossCompany = await request(asAgent(s.granted.id, otherCompanyId)).post(`/api/companies/${otherCompanyId}/agents`)
      .send(mainBody(inside, { hostId: "host-b" }));
    expect(crossCompany.status).toBe(403);

    await db.update(agents).set({ adapterType: "ccpocket_bridge",
      adapterConfig: { role: "main", provider: "claude", hostId: "host-a", model: "host-a/claude/family:opus-5.5", cwd: inside },
      runtimeConfig: { workspaceBinding: { mode: "fixed", cwd: inside } } }).where(eq(agents.id, s.granted.id));
    const own = path.join(allowedRoot, "own");
    const self = await request(app).patch(`/api/agents/${s.granted.id}`)
      .send({ adapterConfig: { cwd: own }, runtimeConfig: { workspaceBinding: { mode: "fixed", cwd: own } } });
    expect(self.status).toBe(403);
    expect(self.body.error).toMatch(/cannot change its own fixed working directory/);

    const worktreePolicy = await request(app).patch(`/api/agents/${s.target.id}`)
      .send({ runtimeConfig: { ...s.target.runtimeConfig, requireTaskWorktree: true } });
    expect(worktreePolicy.status).toBe(403);
    expect(worktreePolicy.body.error).toMatch(/task worktree requirement/);
    expect(await db.select().from(agents).where(eq(agents.companyId, companyId))).toHaveLength(3);
  });

  it("lets only the board grant or revoke the permission", async () => {
    const s = await seed();
    await db.update(agents).set({ role: "ceo" }).where(eq(agents.id, s.plain.id));
    const ceo = asAgent(s.plain.id);
    const selfGrant = await request(ceo).patch(`/api/agents/${s.plain.id}/permissions`)
      .send({ canCreateAgents: true, canAssignTasks: true, canConfigureFixedWorkspace: true });
    expect(selfGrant.status).toBe(403);
    const peerGrant = await request(ceo).patch(`/api/agents/${s.target.id}/permissions`)
      .send({ canCreateAgents: false, canAssignTasks: false, canConfigureFixedWorkspace: true });
    expect(peerGrant.status).toBe(403);
    // An ordinary permissions save by the CEO keeps the board's grant.
    const ordinary = await request(ceo).patch(`/api/agents/${s.granted.id}/permissions`)
      .send({ canCreateAgents: true, canAssignTasks: true });
    expect(ordinary.status, JSON.stringify(ordinary.body)).toBe(200);
    const stored = async (id: string) => (await db.select().from(agents).where(eq(agents.id, id)))[0]!.permissions as Record<string, unknown>;
    expect((await stored(s.granted.id)).canConfigureFixedWorkspace).toBe(true);
    expect((await stored(s.target.id)).canConfigureFixedWorkspace).toBeUndefined();

    const grant = await request(board()).patch(`/api/agents/${s.target.id}/permissions`)
      .send({ canCreateAgents: false, canAssignTasks: false, canConfigureFixedWorkspace: true });
    expect(grant.status, JSON.stringify(grant.body)).toBe(200);
    expect((await stored(s.target.id)).canConfigureFixedWorkspace).toBe(true);
    const revoke = await request(board()).patch(`/api/agents/${s.target.id}/permissions`)
      .send({ canCreateAgents: false, canAssignTasks: false, canConfigureFixedWorkspace: false });
    expect(revoke.status).toBe(200);
    expect((await stored(s.target.id)).canConfigureFixedWorkspace).toBe(false);

    // A new agent never starts with it, even from the board.
    const created = await request(board()).post(`/api/companies/${companyId}/agents`)
      .send({ ...mainBody(path.join(allowedRoot, "board")), permissions: { canConfigureFixedWorkspace: true } });
    expect(created.status, JSON.stringify(created.body)).toBe(201);
    expect((await stored(created.body.id)).canConfigureFixedWorkspace).toBeUndefined();
  });
});
