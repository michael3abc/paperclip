import { randomUUID } from "node:crypto";
import { mkdir, mkdtemp, realpath, rm, stat, symlink } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import express from "express";
import request from "supertest";
import { eq } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import {
  activityLog,
  agentConfigRevisions,
  agents,
  companies,
  createDb,
  issues,
  projects,
  projectWorkspaces,
} from "@paperclipai/db";
import { agentRuntimeConfigSchema } from "@paperclipai/shared";
import { getEmbeddedPostgresTestSupport, startEmbeddedPostgresTestDatabase } from "./helpers/embedded-postgres.js";
import { errorHandler } from "../middleware/index.js";
import { agentRoutes } from "../routes/agents.js";
import {
  buildPaperclipPmWorkspaceContext,
  controllerLocalCwd,
  readProjectPmRunIssueId,
  readWorkspaceBinding,
  resolveProjectPmBinding,
  resolveProjectPmRole,
  resolveProjectPmRunWorkspace,
} from "../services/agent-workspace-binding.js";

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;
type Db = ReturnType<typeof createDb>;

const PROJECT_ID = "11111111-1111-4111-8111-111111111111";

describe("project_pm binding schema and role table", () => {
  const base = { mode: "project_pm" as const, projectId: PROJECT_ID, workerRoot: "/projects/app" };

  it("parses project_pm with defaults and keeps fixed unchanged", () => {
    expect(agentRuntimeConfigSchema.parse({ workspaceBinding: base }).workspaceBinding).toEqual({
      ...base, workerIsolation: "shared", workerSlots: 2,
    });
    expect(agentRuntimeConfigSchema.parse({ workspaceBinding: { mode: "fixed", cwd: "/projects/app" } }).workspaceBinding)
      .toEqual({ mode: "fixed", cwd: "/projects/app" });
    for (const value of [
      { ...base, workerSlots: 0 }, { ...base, workerSlots: 5 }, { ...base, workerSlots: 1.5 },
      { ...base, workerRoot: "relative" }, { ...base, projectId: "not-a-uuid" }, { ...base, agentHome: "relative" },
      { ...base, workerIsolation: "clone" }, { ...base, extra: true }, { ...base, inboxIssueId: "x" },
    ]) {
      expect(() => agentRuntimeConfigSchema.parse({ workspaceBinding: value })).toThrow();
    }
  });

  it("resolves each row of the role table", () => {
    const agentId = randomUUID();
    const binding = { projectId: PROJECT_ID };
    const issue = (patch: Partial<{ projectId: string | null; parentId: string | null; assigneeAgentId: string | null }>) =>
      ({ id: randomUUID(), projectId: PROJECT_ID, parentId: null, assigneeAgentId: agentId, ...patch });
    expect(resolveProjectPmRole({ binding, agentId, issue: null })).toEqual({ outcome: "role", role: "pm" });
    expect(resolveProjectPmRole({ binding, agentId, issue: issue({}) })).toEqual({ outcome: "role", role: "pm" });
    expect(resolveProjectPmRole({ binding, agentId, issue: issue({ parentId: randomUUID() }) })).toEqual({ outcome: "role", role: "worker" });
    expect(resolveProjectPmRole({ binding, agentId, issue: issue({ parentId: randomUUID(), assigneeAgentId: randomUUID() }) }))
      .toEqual({ outcome: "role", role: "pm" });
    expect(resolveProjectPmRole({ binding, agentId, issue: issue({ parentId: randomUUID(), assigneeAgentId: null }) }))
      .toEqual({ outcome: "role", role: "pm" });
    expect(resolveProjectPmRole({ binding, agentId, issue: issue({ projectId: randomUUID() }) }).outcome).toBe("out_of_bounds");
    expect(resolveProjectPmRole({ binding, agentId, issue: issue({ projectId: null, parentId: randomUUID() }) }).outcome).toBe("out_of_bounds");
  });

  it("reads the run issue from the context issue, wake issue or a UUID task id", () => {
    const id = randomUUID();
    expect(readProjectPmRunIssueId({ issueId: id, taskId: randomUUID() })).toBe(id);
    expect(readProjectPmRunIssueId({ paperclipWake: { issue: { id } } })).toBe(id);
    expect(readProjectPmRunIssueId({ taskId: id })).toBe(id);
    expect(readProjectPmRunIssueId({ taskId: "pm:company:agent" })).toBeNull();
    expect(readProjectPmRunIssueId({})).toBeNull();
  });

  it('binds a remote worker host into the claim context and refuses host substitution', () => {
    const binding = { ...base, agentHome: '/home/pm', workerHostId: 'shopee-e', workerIsolation: 'shared' as const, workerSlots: 2, inboxIssueId: null };
    const worker = buildPaperclipPmWorkspaceContext(binding, 'worker', randomUUID());
    expect(readWorkspaceBinding({ workspaceBinding: binding }, { paperclipPmWorkspace: worker })?.projectPm?.workerHostId).toBe('shopee-e');
    expect(() => readWorkspaceBinding({ workspaceBinding: binding }, { paperclipPmWorkspace: { ...worker, workerHostId: 'shopee-d' } })).toThrow(/does not match/);
    expect(() => agentRuntimeConfigSchema.parse({ workspaceBinding: { ...binding, workerHostId: '../host' } })).toThrow();
  });

  it('runs controller-local setup from the agent home when the worker root exists only on a remote host', () => {
    const remote = { ...base, agentHome: '/home/pm', workerHostId: 'shopee-e', workerIsolation: 'shared' as const, workerSlots: 2, inboxIssueId: null };
    const remoteWorker = readWorkspaceBinding({ workspaceBinding: remote }, { paperclipPmWorkspace: buildPaperclipPmWorkspaceContext(remote, 'worker', randomUUID()) });
    expect(remoteWorker?.cwd).toBe('/projects/app');
    expect(controllerLocalCwd(remoteWorker, remoteWorker!.cwd)).toBe('/home/pm');
    const local = { ...remote, workerHostId: undefined };
    const localWorker = readWorkspaceBinding({ workspaceBinding: local }, { paperclipPmWorkspace: buildPaperclipPmWorkspaceContext(local, 'worker', randomUUID()) });
    expect(controllerLocalCwd(localWorker, localWorker!.cwd)).toBe('/projects/app');
    expect(controllerLocalCwd(null, '/workspace')).toBe('/workspace');
  });

  it("projects the binding to the claim-time role cwd and rejects a missing or forged context", () => {
    const binding = { ...base, agentHome: "/home/pm", workerIsolation: "worktree" as const, workerSlots: 3, inboxIssueId: null };
    const runtimeConfig = { workspaceBinding: binding };
    const pm = buildPaperclipPmWorkspaceContext(binding, "pm", null);
    const worker = buildPaperclipPmWorkspaceContext(binding, "worker", randomUUID());
    expect(pm).toMatchObject({ version: 1, role: "pm", cwd: "/home/pm", workerSlots: 3, workerIsolation: "worktree", issueId: null, inboxIssueId: null });
    expect(readWorkspaceBinding(runtimeConfig, { paperclipPmWorkspace: pm })).toEqual({ mode: "fixed", cwd: "/home/pm", projectPm: pm });
    expect(readWorkspaceBinding(runtimeConfig, { paperclipPmWorkspace: worker })?.cwd).toBe("/projects/app");
    expect(() => readWorkspaceBinding(runtimeConfig, {})).toThrow(expect.objectContaining({
      code: "workspace_validation_failed", resultJson: { workspaceValidation: { reason: "project_pm_context_missing" } },
    }));
    expect(() => readWorkspaceBinding(runtimeConfig, { paperclipPmWorkspace: { ...pm, cwd: "/projects/app" } }))
      .toThrow(expect.objectContaining({ resultJson: { workspaceValidation: { reason: "project_pm_context_mismatch" } } }));
    expect(() => readWorkspaceBinding({ workspaceBinding: { ...binding, workerSlots: 9 } }, { paperclipPmWorkspace: pm }))
      .toThrow(expect.objectContaining({ resultJson: { workspaceValidation: { reason: "project_pm_invalid" } } }));
  });
});

describeEmbeddedPostgres("project_pm binding validation against server state", () => {
  let db!: Db;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;
  let tmpRoot = "";
  const previousHome = process.env.PAPERCLIP_HOME;
  const previousInstance = process.env.PAPERCLIP_INSTANCE_ID;

  beforeAll(async () => {
    tmpRoot = await realpath(await mkdtemp(path.join(os.tmpdir(), "paperclip-project-pm-")));
    process.env.PAPERCLIP_HOME = path.join(tmpRoot, "home");
    process.env.PAPERCLIP_INSTANCE_ID = "vitest";
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-project-pm-binding-");
    db = createDb(tempDb.connectionString);
  }, 60_000);

  afterEach(async () => {
    await db.delete(activityLog);
    await db.delete(agentConfigRevisions);
    await db.delete(issues);
    await db.delete(agents);
    await db.delete(projectWorkspaces);
    await db.delete(projects);
    await db.delete(companies);
  });

  afterAll(async () => {
    await tempDb?.cleanup();
    if (previousHome === undefined) delete process.env.PAPERCLIP_HOME; else process.env.PAPERCLIP_HOME = previousHome;
    if (previousInstance === undefined) delete process.env.PAPERCLIP_INSTANCE_ID; else process.env.PAPERCLIP_INSTANCE_ID = previousInstance;
    await rm(tmpRoot, { recursive: true, force: true });
  });

  async function seed() {
    const companyId = randomUUID();
    await db.insert(companies).values({
      id: companyId,
      name: `PM Co ${companyId.slice(0, 6)}`,
      issuePrefix: `P${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
      requireBoardApprovalForNewAgents: false,
    });
    const [project] = await db.insert(projects).values({ companyId, name: "App" }).returning();
    const root = path.join(tmpRoot, `repo-${companyId.slice(0, 8)}`);
    await mkdir(root, { recursive: true });
    await db.insert(projectWorkspaces).values({ companyId, projectId: project!.id, name: "primary", cwd: root, isPrimary: true });
    const [agent] = await db.insert(agents).values({
      companyId, name: "PM", role: "pm", adapterType: "process", adapterConfig: {}, runtimeConfig: {}, permissions: {},
    }).returning();
    const issue = async (patch: Partial<typeof issues.$inferInsert> = {}) => {
      const [row] = await db.insert(issues).values({
        companyId, projectId: project!.id, title: "Issue", status: "backlog", assigneeAgentId: agent!.id, ...patch,
      }).returning();
      return row!;
    };
    return { companyId, project: project!, root, agent: agent!, issue };
  }

  function reasonOf(promise: Promise<unknown>) {
    return promise.then(() => null, (error: { resultJson?: { workspaceValidation?: { reason?: string } } }) =>
      error.resultJson?.workspaceValidation?.reason ?? String(error));
  }

  it("creates the canonical agent home and validates worker root, project and inbox", async () => {
    const s = await seed();
    const binding = { mode: "project_pm" as const, projectId: s.project.id, workerRoot: s.root, workerIsolation: "shared" as const, workerSlots: 2 };
    const resolved = await resolveProjectPmBinding(db, { companyId: s.companyId, agentId: s.agent.id, binding, validateInbox: true });
    const expectedHome = path.join(tmpRoot, "home", "instances", "vitest", "workspaces", s.agent.id);
    expect(resolved).toEqual({ ...binding, agentHome: expectedHome, inboxIssueId: null });
    expect((await stat(expectedHome)).isDirectory()).toBe(true);

    const reason = (patch: Record<string, unknown>, companyId = s.companyId) =>
      reasonOf(resolveProjectPmBinding(db, { companyId, agentId: s.agent.id, binding: { ...binding, ...patch }, validateInbox: true }));
    expect(await reason({ agentHome: "/somewhere/else" })).toBe("project_pm_agent_home_mismatch");
    expect(await reason({ workerRoot: path.join(s.root, "sub") })).toBe("project_pm_worker_root_mismatch");
    await symlink(s.root, path.join(tmpRoot, "alias"));
    expect(await reason({ workerRoot: path.join(tmpRoot, "alias") })).toBe("project_pm_worker_root_mismatch");
    const other = await seed();
    expect(await reason({ projectId: other.project.id })).toBe("project_pm_project_invalid");

    const inbox = await s.issue();
    expect((await resolveProjectPmBinding(db, { companyId: s.companyId, agentId: s.agent.id, binding: { ...binding, inboxIssueId: inbox.id }, validateInbox: true })).inboxIssueId)
      .toBe(inbox.id);
    const child = await s.issue({ parentId: inbox.id });
    const unassigned = await s.issue({ assigneeAgentId: null });
    const otherProject = await other.issue();
    const outsideProject = await s.issue({ projectId: null });
    for (const issue of [child, unassigned, otherProject, outsideProject]) {
      expect(await reason({ inboxIssueId: issue.id })).toBe("project_pm_inbox_invalid");
    }
    expect(await reason({ inboxIssueId: randomUUID() })).toBe("project_pm_inbox_invalid");
  });

  it('requires remote workspace metadata to match the explicitly bound worker host', async () => {
    const s = await seed(), remoteRoot = '/remote-only/project';
    const binding = { mode: 'project_pm' as const, projectId: s.project.id, workerRoot: remoteRoot, workerHostId: 'shopee-e', workerIsolation: 'shared' as const, workerSlots: 2 };
    const resolve = () => resolveProjectPmBinding(db, { companyId: s.companyId, agentId: s.agent.id, binding, validateInbox: true });
    expect(await reasonOf(resolve())).toBe('project_pm_worker_root_mismatch');
    await db.update(projectWorkspaces).set({ sourceType: 'remote_managed', cwd: remoteRoot, metadata: { hostId: 'shopee-e' }, remoteWorkspaceRef: 'shopee-e:' + remoteRoot }).where(eq(projectWorkspaces.projectId, s.project.id));
    expect(await resolve()).toMatchObject(binding);
    expect(await reasonOf(resolveProjectPmBinding(db, { companyId: s.companyId, agentId: s.agent.id,
      binding: { ...binding, workerIsolation: 'worktree' }, validateInbox: true }))).toBe('project_pm_invalid');
    await db.update(projectWorkspaces).set({ metadata: { hostId: 'shopee-d' } }).where(eq(projectWorkspaces.projectId, s.project.id));
    expect(await reasonOf(resolve())).toBe('project_pm_worker_root_mismatch');
  });

  it("resolves the role and cwd of each run from current issue state", async () => {
    const s = await seed();
    const agentHome = (await resolveProjectPmBinding(db, {
      companyId: s.companyId, agentId: s.agent.id, validateInbox: false,
      binding: { mode: "project_pm", projectId: s.project.id, workerRoot: s.root, workerIsolation: "worktree", workerSlots: 3 },
    })).agentHome;
    const inbox = await s.issue();
    const runtimeConfig = { workspaceBinding: { mode: "project_pm", agentHome, projectId: s.project.id, workerRoot: s.root, workerIsolation: "worktree", workerSlots: 3, inboxIssueId: inbox.id } };
    const agent = { ...s.agent, runtimeConfig };
    const run = (context: Record<string, unknown>) => resolveProjectPmRunWorkspace(db, { agent, context });

    expect(await run({})).toEqual({ outcome: "workspace", workspace: {
      version: 1, role: "pm", agentHome, projectId: s.project.id, workerRoot: s.root, workerIsolation: "worktree",
      workerSlots: 3, cwd: agentHome, issueId: null, inboxIssueId: inbox.id,
    } });
    expect(await run({ issueId: inbox.id })).toMatchObject({ workspace: { role: "pm", cwd: agentHome, issueId: inbox.id } });
    const child = await s.issue({ parentId: inbox.id, status: "todo" });
    expect(await run({ issueId: child.id })).toMatchObject({ workspace: { role: "worker", cwd: s.root, issueId: child.id } });
    expect(await run({ taskId: child.id })).toMatchObject({ workspace: { role: "worker" } });
    await db.update(issues).set({ assigneeAgentId: null }).where(eq(issues.id, child.id));
    expect(await run({ issueId: child.id })).toMatchObject({ workspace: { role: "pm", cwd: agentHome } });
    const outside = await s.issue({ projectId: null });
    expect(await run({ issueId: outside.id })).toMatchObject({ outcome: "out_of_bounds", issueId: outside.id });
    const other = await seed();
    expect((await run({ issueId: (await other.issue()).id })).outcome).toBe("out_of_bounds");
    expect((await resolveProjectPmRunWorkspace(db, { agent: { ...s.agent, runtimeConfig: {} }, context: {} })).outcome).toBe("none");
  });

  it("validates and canonicalizes project_pm on agent PATCH and create", async () => {
    const s = await seed();
    const app = express();
    app.use(express.json());
    app.use((req, _res, next) => {
      req.actor = { type: "board", userId: "local-board", source: "local_implicit" };
      next();
    });
    app.use("/api", agentRoutes(db));
    app.use(errorHandler);
    const binding = { mode: "project_pm", projectId: s.project.id, workerRoot: s.root };

    const mismatch = await request(app).patch(`/api/agents/${s.agent.id}`)
      .send({ runtimeConfig: { workspaceBinding: { ...binding, workerRoot: tmpRoot } } });
    expect(mismatch.status).toBe(422);
    expect(mismatch.body).toMatchObject({ code: "workspace_validation_failed", details: { reason: "project_pm_worker_root_mismatch" } });

    const ok = await request(app).patch(`/api/agents/${s.agent.id}`).send({ runtimeConfig: { workspaceBinding: binding } });
    expect(ok.status).toBe(200);
    const [stored] = await db.select().from(agents).where(eq(agents.id, s.agent.id));
    expect(stored!.runtimeConfig.workspaceBinding).toEqual({
      ...binding, agentHome: path.join(tmpRoot, "home", "instances", "vitest", "workspaces", s.agent.id),
      workerIsolation: "shared", workerSlots: 2, inboxIssueId: null,
    });

    const inbox = await s.issue({ assigneeAgentId: null });
    const badInbox = await request(app).patch(`/api/agents/${s.agent.id}`)
      .send({ runtimeConfig: { workspaceBinding: { ...binding, inboxIssueId: inbox.id } } });
    expect(badInbox.status).toBe(422);
    expect(badInbox.body.details).toMatchObject({ reason: "project_pm_inbox_invalid" });

    const created = await request(app).post(`/api/companies/${s.companyId}/agents`).send({
      name: "PM 2", role: "pm", adapterType: "process", adapterConfig: { command: "true" },
      runtimeConfig: { workspaceBinding: { ...binding, agentHome: "/not/the/home" } },
    });
    expect(created.status).toBe(422);
    expect(created.body.details).toMatchObject({ reason: "project_pm_agent_home_mismatch" });
  });

  it("rejects changing the adapter while a remote worker binding is retained", async () => {
    const s = await seed(), app = express();
    app.use(express.json());
    app.use((req, _res, next) => { req.actor = { type: "board", userId: "local-board", source: "local_implicit" }; next(); });
    app.use("/api", agentRoutes(db)); app.use(errorHandler);
    await db.update(agents).set({ adapterType: "ccpocket_bridge", runtimeConfig: { workspaceBinding: { mode: "project_pm",
      projectId: s.project.id, workerRoot: "/remote/project", workerHostId: "shopee-e", workerIsolation: "shared", workerSlots: 2 } } }).where(eq(agents.id, s.agent.id));
    const response = await request(app).patch(`/api/agents/${s.agent.id}`).send({ adapterType: "process", adapterConfig: { command: "true" } });
    expect(response.status).toBe(400);
    expect(response.body.error).toMatch(/CC Pocket/);
    expect((await db.select().from(agents).where(eq(agents.id, s.agent.id)))[0]!.adapterType).toBe("ccpocket_bridge");
  });
});
