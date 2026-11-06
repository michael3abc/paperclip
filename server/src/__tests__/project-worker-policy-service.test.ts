import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { mkdtemp, realpath, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { agents, companies, createDb, issues, projects } from "@paperclipai/db";
import { getEmbeddedPostgresTestSupport, startEmbeddedPostgresTestDatabase } from "./helpers/embedded-postgres.js";
import { heartbeatService } from "../services/heartbeat.ts";
import { issueService } from "../services/issues.ts";
import { drainHeartbeatRunsToQuiescence } from "./helpers/drain-heartbeat-runs.js";

const execute = vi.hoisted(() => vi.fn(async (_input: any) => ({ exitCode: 0, signal: null, timedOut: false })));
vi.mock("../adapters/index.js", () => ({
  getServerAdapter: () => ({ type: "codex_local", execute, supportsLocalAgentJwt: false }),
  findActiveServerAdapter: () => ({ type: "codex_local", execute, supportsLocalAgentJwt: false }),
  runningProcesses: new Map(),
}));

const support = await getEmbeddedPostgresTestSupport();
const suite = support.supported ? describe : describe.skip;

const enforcePolicy = {
  mode: "enforce",
  workers: [
    { id: "opus", adapterConfig: { model: "compass-opus5.5", effort: "high" } },
    { id: "sonnet", adapterConfig: { model: "compass-sonnet5.5" } },
  ],
};

suite("project worker policy on task adapter overrides", () => {
  let database: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>>;
  let db: ReturnType<typeof createDb>;
  let root: string;
  let heartbeat: ReturnType<typeof heartbeatService>;
  let svc: ReturnType<typeof issueService>;

  beforeAll(async () => {
    root = await realpath(await mkdtemp(path.join(os.tmpdir(), "paperclip-worker-policy-")));
    vi.stubEnv("PAPERCLIP_HOME", path.join(root, "home"));
    vi.stubEnv("PAPERCLIP_INSTANCE_ID", "vitest");
    database = await startEmbeddedPostgresTestDatabase("worker-policy");
    db = createDb(database.connectionString);
    heartbeat = heartbeatService(db);
    svc = issueService(db);
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

  async function seed(workerPolicy: unknown) {
    const companyId = randomUUID(), projectId = randomUUID(), agentId = randomUUID();
    await db.insert(companies).values({ id: companyId, name: "Policy co", issuePrefix: `W${companyId.slice(0, 6)}`, defaultResponsibleUserId: "responsible-user" });
    await db.insert(projects).values({ id: projectId, companyId, name: "App", status: "in_progress", workerPolicy: workerPolicy as any });
    await db.insert(agents).values({ id: agentId, companyId, name: "PM", role: "pm", status: "idle", adapterType: "codex_local", adapterConfig: { model: "agent-own-model" }, runtimeConfig: {}, permissions: {} });
    return { companyId, projectId, agentId };
  }

  it("rejects an unlisted model and expands a listed worker on create", async () => {
    const { companyId, projectId, agentId } = await seed(enforcePolicy);
    await expect(
      svc.create(companyId, { title: "bad", projectId, assigneeAgentId: agentId, status: "todo", assigneeAdapterOverrides: { adapterConfig: { model: "compass-fable5" } } } as any),
    ).rejects.toMatchObject({ status: 422 });
    const created = await svc.create(companyId, { title: "good", projectId, assigneeAgentId: agentId, status: "todo", assigneeAdapterOverrides: { adapterConfig: { worker: "opus" } } } as any);
    expect(created.assigneeAdapterOverrides).toEqual({ adapterConfig: { model: "compass-opus5.5", effort: "high" } });
    const [row] = await db.select().from(issues).where(eq(issues.id, created.id));
    expect(row!.assigneeAdapterOverrides).toEqual({ adapterConfig: { model: "compass-opus5.5", effort: "high" } });
  }, 30_000);

  it("keeps today's behaviour when the project has no policy or mode is off", async () => {
    for (const policy of [null, { mode: "off", workers: [] }]) {
      const { companyId, projectId, agentId } = await seed(policy);
      const created = await svc.create(companyId, { title: "free", projectId, assigneeAgentId: agentId, status: "todo", assigneeAdapterOverrides: { adapterConfig: { model: "anything" } } } as any);
      expect(created.assigneeAdapterOverrides).toEqual({ adapterConfig: { model: "anything" } });
    }
  }, 30_000);

  it("enforces on update, including when a task moves into an enforcing project", async () => {
    const { companyId, projectId, agentId } = await seed(enforcePolicy);
    const free = await seed(null);
    const issue = await svc.create(companyId, { title: "t", projectId, assigneeAgentId: agentId, status: "todo" } as any);
    await expect(svc.update(issue.id, { assigneeAdapterOverrides: { adapterConfig: { model: "nope" } } } as any)).rejects.toMatchObject({ status: 422 });
    const updated = await svc.update(issue.id, { assigneeAdapterOverrides: { adapterConfig: { worker: "sonnet" } } } as any);
    expect(updated!.assigneeAdapterOverrides).toEqual({ adapterConfig: { model: "compass-sonnet5.5" } });

    const moving = await svc.create(free.companyId, { title: "m", projectId: free.projectId, assigneeAgentId: free.agentId, status: "todo", assigneeAdapterOverrides: { adapterConfig: { model: "anything" } } } as any);
    await db.update(projects).set({ workerPolicy: enforcePolicy as any }).where(eq(projects.id, free.projectId));
    // A change that does not touch overrides or the project is not blocked by older data.
    await expect(svc.update(moving.id, { title: "renamed" } as any)).resolves.toMatchObject({ title: "renamed" });
  }, 30_000);

  async function runIssue(agentId: string, issueId: string) {
    const run = await heartbeat.wakeup(agentId, { source: "on_demand", triggerDetail: "manual", contextSnapshot: { issueId } });
    expect(run).not.toBeNull();
    await vi.waitFor(async () => {
      expect(["succeeded", "failed", "cancelled", "timed_out"]).toContain((await heartbeat.getRun(run!.id))?.status);
    }, { timeout: 15_000 });
    await drainHeartbeatRunsToQuiescence(db, heartbeat);
    const calls = execute.mock.calls.filter(([input]) => input.runId === run!.id);
    expect(calls).toHaveLength(1);
    return calls[0]![0];
  }

  it("strips unlisted legacy overrides at run time and keeps listed ones", async () => {
    const { companyId, projectId, agentId } = await seed(enforcePolicy);
    const insert = async (overrides: unknown) => {
      const id = randomUUID();
      await db.insert(issues).values({ id, companyId, projectId, title: "legacy", status: "todo", assigneeAgentId: agentId, assigneeAdapterOverrides: overrides as any });
      return id;
    };
    const rejected = await runIssue(agentId, await insert({ adapterConfig: { model: "compass-fable5", effort: "low" } }));
    expect(rejected.config.model).toBe("agent-own-model");
    expect(rejected.config.effort).toBeUndefined();

    const listed = await runIssue(agentId, await insert({ adapterConfig: { worker: "sonnet" } }));
    expect(listed.config.model).toBe("compass-sonnet5.5");
    expect(listed.config.worker).toBeUndefined();
  }, 60_000);
});
