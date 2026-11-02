import { randomUUID } from "node:crypto";
import { execFileSync } from "node:child_process";
import { eq } from "drizzle-orm";
import { mkdtemp, mkdir, realpath, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { agents, companies, createDb, heartbeatRuns, issues, projects, projectWorkspaces } from "@paperclipai/db";
import { getEmbeddedPostgresTestSupport, startEmbeddedPostgresTestDatabase } from "./helpers/embedded-postgres.js";
import { heartbeatService } from "../services/heartbeat.ts";
import { resolveProjectPmBinding } from "../services/agent-workspace-binding.js";
import { drainHeartbeatRunsToQuiescence } from "./helpers/drain-heartbeat-runs.js";

const execute = vi.hoisted(() => vi.fn(async (_input: any) => ({ exitCode: 0, signal: null, timedOut: false })));
vi.mock("../adapters/index.js", () => ({
  getServerAdapter: () => ({ type: "codex_local", execute, supportsLocalAgentJwt: false }),
  findActiveServerAdapter: () => ({ type: "codex_local", execute, supportsLocalAgentJwt: false }),
  runningProcesses: new Map(),
}));

const support = await getEmbeddedPostgresTestSupport();
const suite = support.supported ? describe : describe.skip;

suite("project PM role and workspace at claim", () => {
  let database: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>>;
  let db: ReturnType<typeof createDb>;
  let root: string;
  let heartbeat: ReturnType<typeof heartbeatService>;

  beforeAll(async () => {
    root = await realpath(await mkdtemp(path.join(os.tmpdir(), "paperclip-project-pm-heartbeat-")));
    vi.stubEnv("PAPERCLIP_HOME", path.join(root, "home"));
    vi.stubEnv("PAPERCLIP_INSTANCE_ID", "vitest");
    database = await startEmbeddedPostgresTestDatabase("project-pm-heartbeat");
    db = createDb(database.connectionString);
    heartbeat = heartbeatService(db);
  }, 30_000);

  afterAll(async () => {
    if (db && heartbeat) await drainHeartbeatRunsToQuiescence(db, heartbeat);
    await db?.$client.end({ timeout: 5 });
    await database?.cleanup();
    vi.unstubAllEnvs();
    await rm(root, { recursive: true, force: true });
  }, 60_000);

  afterEach(async () => {
    await drainHeartbeatRunsToQuiescence(db, heartbeat);
    execute.mockClear();
  });

  async function seedPm() {
    const companyId = randomUUID(), projectId = randomUUID(), agentId = randomUUID();
    const workerRoot = path.join(root, companyId, "repo");
    await mkdir(workerRoot, { recursive: true });
    execFileSync("git", ["init", "-q", "-b", "main"], { cwd: workerRoot });
    await db.insert(companies).values({ id: companyId, name: "PM company", issuePrefix: `M${companyId.slice(0, 6)}`, defaultResponsibleUserId: "responsible-user" });
    await db.insert(projects).values({ id: projectId, companyId, name: "App", status: "in_progress" });
    await db.insert(projectWorkspaces).values({ id: randomUUID(), companyId, projectId, name: "Repo", sourceType: "local_path", cwd: workerRoot, isPrimary: true });
    await db.insert(agents).values({ id: agentId, companyId, name: "PM", role: "pm", status: "idle", adapterType: "codex_local", adapterConfig: {}, runtimeConfig: {}, permissions: {} });
    const inboxIssueId = randomUUID();
    await db.insert(issues).values({ id: inboxIssueId, companyId, projectId, title: "PM inbox", status: "backlog", assigneeAgentId: agentId });
    const binding = await resolveProjectPmBinding(db, {
      companyId, agentId, validateInbox: true,
      binding: { mode: "project_pm", projectId, workerRoot, workerIsolation: "shared", workerSlots: 2, inboxIssueId },
    });
    await db.update(agents).set({ runtimeConfig: { workspaceBinding: binding } }).where(eq(agents.id, agentId));
    return { companyId, projectId, agentId, workerRoot, inboxIssueId, agentHome: binding.agentHome };
  }

  async function runToEnd(agentId: string, contextSnapshot: Record<string, unknown>) {
    const run = await heartbeat.wakeup(agentId, { source: "on_demand", triggerDetail: "manual", contextSnapshot });
    expect(run).not.toBeNull();
    let latest: Awaited<ReturnType<typeof heartbeat.getRun>> = null;
    await vi.waitFor(async () => {
      latest = await heartbeat.getRun(run!.id);
      expect(["succeeded", "failed", "cancelled", "timed_out"]).toContain(latest?.status);
    }, { timeout: 15_000 });
    await drainHeartbeatRunsToQuiescence(db, heartbeat);
    return { run: (await heartbeat.getRun(run!.id))!, calls: execute.mock.calls.filter(([input]) => input.runId === run!.id) };
  }

  it("delivers the PM role in the agent home and the worker role in the project root", async () => {
    const pm = await seedPm();
    const inboxRun = await runToEnd(pm.agentId, { issueId: pm.inboxIssueId });
    expect({ status: inboxRun.run.status, error: inboxRun.run.error }).toEqual({ status: "succeeded", error: null });
    expect(inboxRun.calls).toHaveLength(1);
    const pmContext = inboxRun.calls[0]![0].context;
    expect(pmContext.paperclipPmWorkspace).toEqual({
      version: 1, role: "pm", agentHome: pm.agentHome, projectId: pm.projectId, workerRoot: pm.workerRoot,
      workerIsolation: "shared", workerSlots: 2, cwd: pm.agentHome, issueId: pm.inboxIssueId, inboxIssueId: pm.inboxIssueId,
    });
    expect(pmContext.paperclipWorkspace.cwd).toBe(pm.agentHome);
    expect((inboxRun.run.contextSnapshot as Record<string, any>).paperclipPmWorkspace.role).toBe("pm");
    // The inbox stays in backlog: a PM wake on it is not an issue checkout.
    const [inbox] = await db.select().from(issues).where(eq(issues.id, pm.inboxIssueId));
    expect(inbox!.status).toBe("backlog");

    const childId = randomUUID();
    await db.insert(issues).values({ id: childId, companyId: pm.companyId, projectId: pm.projectId, parentId: pm.inboxIssueId, title: "Build it", status: "todo", assigneeAgentId: pm.agentId });
    const workerRun = await runToEnd(pm.agentId, { issueId: childId });
    expect({ status: workerRun.run.status, error: workerRun.run.error }).toEqual({ status: "succeeded", error: null });
    const workerContext = workerRun.calls[0]![0].context;
    expect(workerContext.paperclipPmWorkspace).toMatchObject({ role: "worker", cwd: pm.workerRoot, issueId: childId });
    expect(workerContext.paperclipWorkspace.cwd).toBe(pm.workerRoot);
    expect((workerRun.run.contextSnapshot as Record<string, any>).paperclipPmWorkspace).toMatchObject({ role: "worker", cwd: pm.workerRoot });

    const timerRun = await runToEnd(pm.agentId, {});
    expect(timerRun.calls[0]![0].context.paperclipPmWorkspace).toMatchObject({ role: "pm", cwd: pm.agentHome, issueId: null });
  }, 60_000);

  it("cancels an out-of-project run once with project_pm_out_of_bounds and never starts the adapter", async () => {
    const pm = await seedPm();
    const outsideId = randomUUID();
    await db.insert(issues).values({ id: outsideId, companyId: pm.companyId, projectId: null, title: "Elsewhere", status: "todo", assigneeAgentId: pm.agentId });
    const rejected = await runToEnd(pm.agentId, { issueId: outsideId });
    expect({ status: rejected.run.status, errorCode: rejected.run.errorCode }).toEqual({ status: "cancelled", errorCode: "project_pm_out_of_bounds" });
    expect(rejected.run.error).toMatch(/outside the PM agent's project/);
    expect(rejected.calls).toHaveLength(0);
    const runs = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.agentId, pm.agentId));
    expect(runs.filter((run) => run.status === "queued" || run.status === "running")).toHaveLength(0);
  }, 30_000);
});
