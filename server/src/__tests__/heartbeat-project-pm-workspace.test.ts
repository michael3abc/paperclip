import { randomUUID } from "node:crypto";
import { execFileSync } from "node:child_process";
import { eq } from "drizzle-orm";
import { mkdtemp, mkdir, realpath, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { agentWakeupRequests, agents, authUsers, companies, companyMemberships, createDb, heartbeatRuns, issueComments, issues, projects, projectWorkspaces } from "@paperclipai/db";
import { getEmbeddedPostgresTestSupport, startEmbeddedPostgresTestDatabase } from "./helpers/embedded-postgres.js";
import { heartbeatService } from "../services/heartbeat.ts";
import { resolveProjectPmBinding } from "../services/agent-workspace-binding.js";
import { drainHeartbeatRunsToQuiescence } from "./helpers/drain-heartbeat-runs.js";
import { applyIssueExecutionPolicyTransition, normalizeIssueExecutionPolicy } from "../services/issue-execution-policy.js";

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
    await db.insert(authUsers).values({ id: "responsible-user", name: "Fixture owner", email: "owner@example.test", createdAt: new Date(), updatedAt: new Date() });
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

  async function seedPm(options: { allowCrossProject?: boolean } = {}) {
    const companyId = randomUUID(), projectId = randomUUID(), agentId = randomUUID();
    const workerRoot = path.join(root, companyId, "repo");
    await mkdir(workerRoot, { recursive: true });
    execFileSync("git", ["init", "-q", "-b", "main"], { cwd: workerRoot });
    await db.insert(companies).values({ id: companyId, name: "PM company", issuePrefix: `M${companyId.slice(0, 6)}`, defaultResponsibleUserId: "responsible-user" });
    await db.insert(companyMemberships).values({ companyId, principalType: "user", principalId: "responsible-user", status: "active", membershipRole: "member" });
    await db.insert(projects).values({ id: projectId, companyId, name: "App", status: "in_progress" });
    await db.insert(projectWorkspaces).values({ id: randomUUID(), companyId, projectId, name: "Repo", sourceType: "local_path", cwd: workerRoot, isPrimary: true });
    await db.insert(agents).values({ id: agentId, companyId, name: "PM", role: "pm", status: "idle", adapterType: "codex_local", adapterConfig: {}, runtimeConfig: {}, permissions: {} });
    const inboxIssueId = randomUUID();
    await db.insert(issues).values({ id: inboxIssueId, companyId, projectId, title: "PM inbox", status: "backlog", assigneeAgentId: agentId });
    const binding = await resolveProjectPmBinding(db, {
      companyId, agentId, validateInbox: true,
      binding: { mode: "project_pm", projectId, workerRoot, workerIsolation: "shared", workerSlots: 2, inboxIssueId, ...(options.allowCrossProject ? { allowCrossProject: true } : {}) },
    });
    await db.update(agents).set({ runtimeConfig: { workspaceBinding: binding } }).where(eq(agents.id, agentId));
    return { companyId, projectId, agentId, workerRoot, inboxIssueId, agentHome: binding.agentHome };
  }

  /** A second project of the same company with its own primary workspace directory. */
  async function seedOtherProject(companyId: string) {
    const otherProjectId = randomUUID();
    const otherRoot = path.join(root, companyId, "other-repo");
    await mkdir(otherRoot, { recursive: true });
    execFileSync("git", ["init", "-q", "-b", "main"], { cwd: otherRoot });
    await db.insert(projects).values({ id: otherProjectId, companyId, name: "Other", status: "in_progress" });
    await db.insert(projectWorkspaces).values({ id: randomUUID(), companyId, projectId: otherProjectId, name: "Other repo", sourceType: "local_path", cwd: otherRoot, isPrimary: true });
    return { otherProjectId, otherRoot };
  }

  async function runToEnd(agentId: string, contextSnapshot: Record<string, unknown>) {
    const run = await heartbeat.wakeup(agentId, { source: "on_demand", triggerDetail: "manual", contextSnapshot });
    expect(run).not.toBeNull();
    await vi.waitFor(async () => {
      const latest = await heartbeat.getRun(run!.id);
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

  it.each(["review", "approval"] as const)("keeps a %s stage in the PM home and restores worker overrides after revision", async (type) => {
    const pm = await seedPm();
    const workerId = randomUUID(), childId = randomUUID();
    await db.update(agents).set({ adapterConfig: { cwd: pm.agentHome, model: "pm-model", modelReasoningEffort: "high" } }).where(eq(agents.id, pm.agentId));
    await db.insert(agents).values({ id: workerId, companyId: pm.companyId, name: "Worker", role: "engineer", status: "idle", adapterType: "codex_local", adapterConfig: { model: "default-worker-model" } });
    const policy = normalizeIssueExecutionPolicy({ stages: [{ type, participants: [{ type: "agent", agentId: pm.agentId }] }] })!;
    const overrides = { useProjectWorkspace: true, adapterConfig: { cwd: pm.workerRoot, model: "task-worker-model", modelReasoningEffort: "xhigh" } };
    const transition = applyIssueExecutionPolicyTransition({ issue: { status: "in_progress", assigneeAgentId: workerId }, policy,
      requestedStatus: "done", requestedAssigneePatch: {}, actor: { agentId: workerId }, commentBody: "Deliver the tested result" });
    await db.insert(issues).values({ id: childId, companyId: pm.companyId, projectId: pm.projectId, parentId: pm.inboxIssueId,
      title: "Review the worker result", assigneeAgentId: workerId, status: "in_progress", executionPolicy: { ...policy },
      assigneeAdapterOverrides: overrides, ...transition.patch });
    const review = await runToEnd(pm.agentId, { issueId: childId });
    expect({ status: review.run.status, error: review.run.error }).toEqual({ status: "succeeded", error: null });
    expect(review.calls).toHaveLength(1);
    expect(review.calls[0]![0].context.paperclipPmWorkspace).toMatchObject({ role: "pm", cwd: pm.agentHome });
    expect(review.calls[0]![0].config).toMatchObject({ cwd: pm.agentHome, model: "pm-model", modelReasoningEffort: "high" });
    const [reviewed] = await db.select().from(issues).where(eq(issues.id, childId));
    expect(reviewed!.assigneeAdapterOverrides).toEqual(overrides);
    const revision = applyIssueExecutionPolicyTransition({ issue: reviewed!, policy, requestedStatus: "in_progress",
      requestedAssigneePatch: {}, actor: { agentId: pm.agentId }, commentBody: "Revise the missing evidence" });
    await db.update(issues).set(revision.patch).where(eq(issues.id, childId));
    const work = await runToEnd(workerId, { issueId: childId });
    expect({ status: work.run.status, error: work.run.error }).toEqual({ status: "succeeded", error: null });
    expect(work.calls[0]![0].config).toMatchObject({ cwd: pm.workerRoot, model: "task-worker-model", modelReasoningEffort: "xhigh" });
  }, 60_000);

  it("delivers a native PM turn in its home on the worker host without probing that path locally", async () => {
    const companyId = randomUUID(), projectId = randomUUID(), agentId = randomUUID();
    const workerRoot = "/remote-only/" + companyId + "/repo", pmHome = "/remote-only/" + companyId + "/pm-home";
    await db.insert(companies).values({ id: companyId, name: "Remote PM company", issuePrefix: `R${companyId.slice(0, 6)}`, defaultResponsibleUserId: "responsible-user" });
    await db.insert(projects).values({ id: projectId, companyId, name: "Remote app", status: "in_progress" });
    await db.insert(projectWorkspaces).values({ id: randomUUID(), companyId, projectId, name: "Repo", sourceType: "remote_managed", cwd: workerRoot,
      metadata: { hostId: "shopee-e" }, remoteWorkspaceRef: "shopee-e:" + workerRoot, isPrimary: true });
    await db.insert(agents).values({ id: agentId, companyId, name: "PM", role: "pm", status: "idle", adapterType: "ccpocket_bridge", adapterConfig: {}, runtimeConfig: {}, permissions: {} });
    const binding = await resolveProjectPmBinding(db, {
      companyId, agentId, validateInbox: false,
      binding: { mode: "project_pm", projectId, workerRoot, workerHostId: "shopee-e", pmHome, workerIsolation: "shared", workerSlots: 2 },
    });
    await db.update(agents).set({ runtimeConfig: { workspaceBinding: binding } }).where(eq(agents.id, agentId));
    const pmRun = await runToEnd(agentId, {});
    expect({ status: pmRun.run.status, error: pmRun.run.error }).toEqual({ status: "succeeded", error: null });
    const context = pmRun.calls[0]![0].context;
    expect(context.paperclipPmWorkspace).toMatchObject({ role: "pm", cwd: pmHome, pmHome, workerHostId: "shopee-e", agentHome: binding.agentHome });
    expect(context.paperclipWorkspace.cwd).toBe(pmHome);
  }, 60_000);

  it("runs one PM turn beside up to workerSlots worker turns and keeps a full role queued", async () => {
    const pm = await seedPm();
    const gates = new Map<string, () => void>();
    execute.mockImplementation(async (input: any) => {
      await new Promise<void>((resolve) => gates.set(input.runId, resolve));
      return { exitCode: 0, signal: null, timedOut: false };
    });
    try {
      const child = async (title: string) => {
        const id = randomUUID();
        await db.insert(issues).values({ id, companyId: pm.companyId, projectId: pm.projectId, parentId: pm.inboxIssueId, title, status: "todo", assigneeAgentId: pm.agentId });
        return id;
      };
      const topLevelId = randomUUID();
      await db.insert(issues).values({ id: topLevelId, companyId: pm.companyId, projectId: pm.projectId, title: "Plan the release", status: "todo", assigneeAgentId: pm.agentId });
      const [c1, c2, c3] = [await child("One"), await child("Two"), await child("Three")];
      const wake = async (issueId: string) => (await heartbeat.wakeup(pm.agentId, { source: "on_demand", triggerDetail: "manual", contextSnapshot: { issueId } }))!.id;
      const status = async (runId: string) => (await heartbeat.getRun(runId))!.status;
      const started = () => new Set(execute.mock.calls.map(([input]) => input.runId as string));

      const pm1 = await wake(pm.inboxIssueId);
      await vi.waitFor(() => expect(started().has(pm1)).toBe(true), { timeout: 15_000 });
      // The second PM run is queued first, yet it must not block the workers behind it.
      const pm2 = await wake(topLevelId);
      const w1 = await wake(c1);
      const w2 = await wake(c2);
      const w3 = await wake(c3);
      await vi.waitFor(() => expect([...started()].sort()).toEqual([pm1, w1, w2].sort()), { timeout: 15_000 });
      expect(await status(pm2)).toBe("queued");
      expect(await status(w3)).toBe("queued");
      const running = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.agentId, pm.agentId));
      const roles = running.filter((run) => run.status === "running")
        .map((run) => (run.contextSnapshot as Record<string, any>).paperclipPmWorkspace?.role).sort();
      expect(roles).toEqual(["pm", "worker", "worker"]);

      gates.get(pm1)!();
      await vi.waitFor(() => expect(started().has(pm2)).toBe(true), { timeout: 15_000 });
      expect(await status(w3)).toBe("queued");
      const pm2Run = await heartbeat.getRun(pm2);
      expect((pm2Run!.contextSnapshot as Record<string, any>).paperclipPmWorkspace).toMatchObject({ role: "pm", cwd: pm.agentHome, issueId: topLevelId });

      gates.get(w1)!();
      await vi.waitFor(() => expect(started().has(w3)).toBe(true), { timeout: 15_000 });
      const w3Call = execute.mock.calls.find(([input]) => input.runId === w3)!;
      expect(w3Call[0].context.paperclipPmWorkspace).toMatchObject({ role: "worker", cwd: pm.workerRoot, issueId: c3 });
    } finally {
      // Later executions use the default; gated ones (gates are set synchronously) are released.
      execute.mockImplementation(async () => ({ exitCode: 0, signal: null, timedOut: false }));
      for (const release of gates.values()) release();
    }
  }, 90_000);

  it("keeps every intake comment that coalesces into a queued PM inbox run at claim", async () => {
    const pm = await seedPm();
    const gates = new Map<string, () => void>();
    execute.mockImplementation(async (input: any) => {
      await new Promise<void>((resolve) => gates.set(input.runId, resolve));
      return { exitCode: 0, signal: null, timedOut: false };
    });
    try {
      const topLevelId = randomUUID();
      await db.insert(issues).values({ id: topLevelId, companyId: pm.companyId, projectId: pm.projectId, title: "Plan the release", status: "todo", assigneeAgentId: pm.agentId });
      const started = () => new Set(execute.mock.calls.map(([input]) => input.runId as string));
      const busy = (await heartbeat.wakeup(pm.agentId, { source: "on_demand", triggerDetail: "manual", contextSnapshot: { issueId: topLevelId } }))!.id;
      await vi.waitFor(() => expect(started().has(busy)).toBe(true), { timeout: 15_000 });

      const intake = async (dedupeId: string) => {
        const commentId = randomUUID();
        await db.insert(issueComments).values({ id: commentId, companyId: pm.companyId, issueId: pm.inboxIssueId, body: `ask ${dedupeId}` });
        const pmIntake = { dedupeId, source: "console", sourceRef: null };
        await heartbeat.wakeup(pm.agentId, {
          source: "automation", triggerDetail: "system", reason: "pm_intake",
          payload: { issueId: pm.inboxIssueId, commentId, mutation: "pm_intake", pmIntake },
          contextSnapshot: { issueId: pm.inboxIssueId, taskId: pm.inboxIssueId, commentId, wakeCommentId: commentId, source: "pm.intake", wakeReason: "pm_intake", pmIntake },
        });
        return commentId;
      };
      const q1 = await intake("q1");
      const q2 = await intake("q2");
      const inboxRuns = (await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.agentId, pm.agentId)))
        .filter((run) => (run.contextSnapshot as Record<string, any>).issueId === pm.inboxIssueId);
      expect(inboxRuns.map((run) => run.status)).toEqual(["queued"]);
      const coalesced = await db.select().from(agentWakeupRequests).where(eq(agentWakeupRequests.runId, inboxRuns[0]!.id));
      expect(coalesced.map((wake) => wake.status).sort()).toEqual(["coalesced", "queued"]);

      gates.get(busy)!();
      await vi.waitFor(() => expect(started().has(inboxRuns[0]!.id)).toBe(true), { timeout: 15_000 });
      const claimed = (await heartbeat.getRun(inboxRuns[0]!.id))!.contextSnapshot as Record<string, any>;
      expect({ ids: claimed.wakeCommentIds, latest: claimed.wakeCommentId }).toEqual({ ids: [q1, q2], latest: q2 });
      const call = execute.mock.calls.find(([input]) => input.runId === inboxRuns[0]!.id)!;
      expect(call[0].context.wakeCommentIds).toEqual([q1, q2]);
    } finally {
      execute.mockImplementation(async () => ({ exitCode: 0, signal: null, timedOut: false }));
      for (const release of gates.values()) release();
    }
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

  it("lets a whitelisted PM take another project's issues and runs its worker in that project's workspace", async () => {
    const pm = await seedPm({ allowCrossProject: true });
    const { otherProjectId, otherRoot } = await seedOtherProject(pm.companyId);
    const topId = randomUUID(), childId = randomUUID();
    await db.insert(issues).values({ id: topId, companyId: pm.companyId, projectId: otherProjectId, title: "Other top", status: "todo", assigneeAgentId: pm.agentId });
    await db.insert(issues).values({ id: childId, companyId: pm.companyId, projectId: otherProjectId, parentId: topId, title: "Other child", status: "todo", assigneeAgentId: pm.agentId });

    const workerRun = await runToEnd(pm.agentId, { issueId: childId });
    expect({ status: workerRun.run.status, error: workerRun.run.error }).toEqual({ status: "succeeded", error: null });
    const workerContext = workerRun.calls[0]![0].context;
    expect(workerContext.paperclipPmWorkspace).toMatchObject({ role: "worker", projectId: otherProjectId, workerRoot: otherRoot, cwd: otherRoot, issueId: childId });
    expect(workerContext.paperclipWorkspace.cwd).toBe(otherRoot);
    expect(workerContext.paperclipWorkspace.cwd).not.toBe(pm.workerRoot);

    // A top-level issue of another project is a PM turn that stays in the agent home.
    const pmRun = await runToEnd(pm.agentId, { issueId: topId });
    expect({ status: pmRun.run.status, error: pmRun.run.error }).toEqual({ status: "succeeded", error: null });
    expect(pmRun.calls[0]![0].context.paperclipPmWorkspace).toMatchObject({ role: "pm", cwd: pm.agentHome, issueId: topId });

    // The whitelist does not cover issues that belong to no project: a worker there has no workspace.
    const orphanId = randomUUID();
    await db.insert(issues).values({ id: orphanId, companyId: pm.companyId, projectId: null, title: "No project", status: "todo", assigneeAgentId: pm.agentId });
    const orphan = await runToEnd(pm.agentId, { issueId: orphanId });
    expect({ status: orphan.run.status, errorCode: orphan.run.errorCode }).toEqual({ status: "cancelled", errorCode: "project_pm_out_of_bounds" });
    expect(orphan.calls).toHaveLength(0);
  }, 60_000);

  it("still cancels another project's issue for a PM without the whitelist flag", async () => {
    const pm = await seedPm();
    const { otherProjectId } = await seedOtherProject(pm.companyId);
    const topId = randomUUID(), childId = randomUUID();
    await db.insert(issues).values({ id: topId, companyId: pm.companyId, projectId: otherProjectId, title: "Other top", status: "todo", assigneeAgentId: pm.agentId });
    await db.insert(issues).values({ id: childId, companyId: pm.companyId, projectId: otherProjectId, parentId: topId, title: "Other child", status: "todo", assigneeAgentId: pm.agentId });
    for (const issueId of [topId, childId]) {
      const rejected = await runToEnd(pm.agentId, { issueId });
      expect({ status: rejected.run.status, errorCode: rejected.run.errorCode }).toEqual({ status: "cancelled", errorCode: "project_pm_out_of_bounds" });
      expect(rejected.calls).toHaveLength(0);
    }
  }, 60_000);
});
