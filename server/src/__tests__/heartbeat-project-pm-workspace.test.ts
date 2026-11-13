import { randomUUID } from "node:crypto";
import { execFileSync } from "node:child_process";
import { eq } from "drizzle-orm";
import { mkdtemp, mkdir, realpath, rm, writeFile, readFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { agentInstructionWorkingCopies, agentWakeupRequests, agents, authUsers, companies, companyMemberships, createDb, heartbeatRuns, issueComments, issues, projects, projectWorkspaces } from "@paperclipai/db";
import { getEmbeddedPostgresTestSupport, startEmbeddedPostgresTestDatabase } from "./helpers/embedded-postgres.js";
import { heartbeatService } from "../services/heartbeat.ts";
import { resolveProjectPmBinding } from "../services/agent-workspace-binding.js";
import { drainHeartbeatRunsToQuiescence } from "./helpers/drain-heartbeat-runs.js";
import { applyIssueExecutionPolicyTransition, normalizeIssueExecutionPolicy } from "../services/issue-execution-policy.js";
import { instanceSettingsService } from "../services/instance-settings.js";
import { sharedCheckoutHolderSettled } from "../services/heartbeat/shared-checkout.js";
import { seedManagedDispatchWorkspace } from "./helpers/managed-dispatch-workspace.js";

const execute = vi.hoisted(() => vi.fn(async (_input: any) => ({ exitCode: 0, signal: null, timedOut: false })));
vi.mock("../adapters/registry.js", () => ({
  getServerAdapter: () => ({ managedWorktreeOperation: async ({ operation }: any) => ({
    schema: "paperclip.managed-worktree-host.v1", action: operation.action, operationId: operation.operationId,
    cwd: operation.cwd, branch: operation.branch, head: "a".repeat(40), targetHead: null,
    commonDir: operation.cwd + "/.git", dirty: false, merged: false,
  }) }),
}));
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

  async function seedPm(options: { allowCrossProject?: boolean; workerSlots?: number } = {}) {
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
      binding: { mode: "project_pm", projectId, workerRoot, workerIsolation: "shared", workerSlots: options.workerSlots ?? 2, inboxIssueId, ...(options.allowCrossProject ? { allowCrossProject: true } : {}) },
    });
    await db.update(agents).set({ runtimeConfig: { workspaceBinding: binding } }).where(eq(agents.id, agentId));
    return { companyId, projectId, agentId, workerRoot, inboxIssueId, agentHome: binding.agentHome };
  }

  /** A second project of the same company with its own primary workspace directory. */
  async function seedOtherProject(companyId: string, directory = "other-repo") {
    const otherProjectId = randomUUID();
    const otherRoot = path.join(root, companyId, directory);
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
      expect(["succeeded", "failed", "cancelled", "timed_out"], JSON.stringify({ status: latest?.status, error: latest?.error, errorCode: latest?.errorCode, retryReason: latest?.scheduledRetryReason, retryAt: latest?.scheduledRetryAt, context: latest?.contextSnapshot, result: latest?.resultJson })).toContain(latest?.status);
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

  it("rejects a coordinator-only PM's assigned child before calling the adapter", async () => {
    const pm = await seedPm({ workerSlots: 0 });
    const childId = randomUUID();
    await db.insert(issues).values({ id: childId, companyId: pm.companyId, projectId: pm.projectId,
      parentId: pm.inboxIssueId, title: "Implementation belongs to a separate worker", status: "todo", assigneeAgentId: pm.agentId });
    const rejected = await runToEnd(pm.agentId, { issueId: childId });
    expect(rejected.run).toMatchObject({ status: "cancelled", errorCode: "project_pm_out_of_bounds" });
    expect(rejected.run.error).toContain("separate worker");
    expect(rejected.calls).toHaveLength(0);
    const planning = await runToEnd(pm.agentId, { issueId: pm.inboxIssueId });
    expect(planning.run.status).toBe("failed");
    expect(planning.run.error).toContain("qualified local native Claude ACP or Codex runtime");
    expect(planning.calls).toHaveLength(0);
  }, 60_000);

  it("runs one shared worker across projects in separate task worktrees with task-specific models", async () => {
    const pm = await seedPm({ workerSlots: 0 });
    const other = await seedOtherProject(pm.companyId);
    await instanceSettingsService(db).updateExperimental({ enableIsolatedWorkspaces: true });
    for (const [projectId, cwd] of [[pm.projectId, pm.workerRoot], [other.otherProjectId, other.otherRoot]]) {
      execFileSync("git", ["-c", "user.name=Test", "-c", "user.email=test@example.test", "commit", "--allow-empty", "-m", "Seed"], { cwd });
      await db.update(projects).set({ executionWorkspacePolicy: { enabled: true, defaultMode: "isolated_workspace", allowIssueOverride: false,
        workspaceStrategy: { type: "git_worktree", baseRef: "main", worktreeParentDir: path.join(root, "task-worktrees", projectId!) } } }).where(eq(projects.id, projectId!));
    }
    const workerId = randomUUID();
    await db.insert(agents).values({ id: workerId, companyId: pm.companyId, name: "Shared worker", role: "engineer", status: "idle",
      adapterType: "codex_local", adapterConfig: { model: "default-model" },
      runtimeConfig: { heartbeat: { maxConcurrentRuns: 20 }, requireTaskWorktree: true } });
    const taskIds = [randomUUID(), randomUUID(), randomUUID()];
    const sessionIds = new Map<string, string>(taskIds.map(id => [id, randomUUID()]));
    const policy = normalizeIssueExecutionPolicy({ stages: [{ type: "review", participants: [{ type: "agent", agentId: pm.agentId }] }] })!;
    for (const [i, id] of taskIds.entries()) await db.insert(issues).values({ id, companyId: pm.companyId,
      projectId: i === 2 ? other.otherProjectId : pm.projectId, parentId: i === 2 ? null : pm.inboxIssueId,
      title: `Independent task ${i}`, status: "todo", assigneeAgentId: workerId,
      executionPolicy: { ...policy },
      assigneeAdapterOverrides: { adapterConfig: { model: `task-model-${i}`, modelReasoningEffort: "high" } } });
    async function deliver(input: any) {
      const [issue] = await db.select().from(issues).where(eq(issues.id, input.context.issueId));
      const delivery = applyIssueExecutionPolicyTransition({ issue: issue!, policy, requestedStatus: "done",
        requestedAssigneePatch: {}, actor: { agentId: workerId }, commentBody: "Worktree output ready for PM review" });
      await db.update(issues).set(delivery.patch).where(eq(issues.id, issue!.id));
      return { exitCode: 0, signal: null, timedOut: false, sessionId: sessionIds.get(issue!.id)! };
    }
    const gates = new Map<string, () => void>();
    execute.mockImplementation(async (input: any) => {
      await writeFile(path.join(input.context.paperclipWorkspace.cwd, "task-output.txt"), input.config.model);
      await new Promise<void>(resolve => gates.set(input.runId, resolve));
      return deliver(input);
    });
    try {
      const runs = [];
      for (const id of taskIds) runs.push((await heartbeat.wakeup(workerId, { source: "on_demand", triggerDetail: "manual", contextSnapshot: { issueId: id } }))!);
      await vi.waitFor(() => expect(gates.size).toBe(3), { timeout: 25_000 });
      const calls = runs.map(run => execute.mock.calls.find(([input]) => input.runId === run.id)![0]);
      expect(new Set(calls.map(input => input.context.paperclipWorkspace.cwd)).size).toBe(3);
      for (const [i, input] of calls.entries()) {
        expect(input.config.model).toBe(`task-model-${i}`);
        const cwd = input.context.paperclipWorkspace.cwd;
        expect(await readFile(path.join(cwd, "task-output.txt"), "utf8")).toBe(`task-model-${i}`);
        expect(cwd).not.toBe(pm.workerRoot);
        expect(cwd).not.toBe(other.otherRoot);
        expect(execFileSync("git", ["rev-parse", "--is-inside-work-tree"], { cwd, encoding: "utf8" }).trim()).toBe("true");
      }
      for (const release of gates.values()) release();
      execute.mockImplementation(deliver);
      await drainHeartbeatRunsToQuiescence(db, heartbeat);
      // This adapter double returns a session ID but has no child process or
      // instruction collector. Model its completed stop explicitly; success
      // alone must not make the original worktree available to a successor.
      for (const [i, run] of runs.entries()) {
        expect((await heartbeat.getRun(run.id))!.status).toBe("succeeded");
        expect(await sharedCheckoutHolderSettled(db, pm.companyId, run.id)).toBe(false);
        const cwd = calls[i].context.paperclipWorkspace.cwd;
        await db.insert(agentInstructionWorkingCopies).values({ runId: run.id, companyId: pm.companyId, agentId: workerId,
          responsibleUserId: "responsible-user", entryFile: "AGENTS.md", baseHash: "a".repeat(64),
          localRoot: cwd, executionRoot: cwd, location: "local", state: "captured",
          receipt: { source: "completed-test-adapter" }, processStoppedAt: new Date() });
        expect(await sharedCheckoutHolderSettled(db, pm.companyId, run.id)).toBe(true);
      }
      const [submitted] = await db.select().from(issues).where(eq(issues.id, taskIds[0]!));
      const returned = applyIssueExecutionPolicyTransition({ issue: submitted!, policy, requestedStatus: "in_progress",
        requestedAssigneePatch: {}, actor: { agentId: pm.agentId }, commentBody: "Revise the same output" });
      await db.update(issues).set(returned.patch).where(eq(issues.id, taskIds[0]!));
      const revision = await runToEnd(workerId, { issueId: taskIds[0] });
      expect({ status: revision.run.status, errorCode: revision.run.errorCode, error: revision.run.error }).toEqual({ status: "succeeded", errorCode: null, error: null });
      expect(revision.calls[0]![0].context.paperclipWorkspace.cwd).toBe(calls[0].context.paperclipWorkspace.cwd);
      expect(revision.calls[0]![0].config.model).toBe("task-model-0");
      expect(revision.calls[0]![0].runtime.sessionId).toBe(sessionIds.get(taskIds[0]!));
    } finally {
      execute.mockImplementation(async () => ({ exitCode: 0, signal: null, timedOut: false }));
      for (const release of gates.values()) release();
    }
  }, 60_000);

  it("does not inherit a worker task connection during PM review", async () => {
    const pm = await seedPm({ workerSlots: 1 });
    const workerId = randomUUID(), childId = randomUUID();
    await db.update(agents).set({ adapterConfig: { cwd: pm.agentHome, model: "pm-model", modelReasoningEffort: "high" } }).where(eq(agents.id, pm.agentId));
    await db.insert(agents).values({ id: workerId, companyId: pm.companyId, name: "Worker", status: "idle", adapterType: "codex_local" });
    const policy = normalizeIssueExecutionPolicy({ stages: [{ type: "review", participants: [{ type: "agent", agentId: pm.agentId }] }] })!;
    const transition = applyIssueExecutionPolicyTransition({ issue: { status: "in_progress", assigneeAgentId: workerId }, policy,
      requestedStatus: "done", requestedAssigneePatch: {}, actor: { agentId: workerId }, commentBody: "Deliver" });
    const aiConnection = { mode: "delegated" as const, provider: "anthropic" as const, method: "api_key" as const, connectionId: randomUUID(), grantId: randomUUID() };
    await db.insert(issues).values({ id: childId, companyId: pm.companyId, projectId: pm.projectId, parentId: pm.inboxIssueId, title: "Review", assigneeAgentId: workerId,
      executionPolicy: { ...policy }, assigneeAdapterOverrides: { aiConnection, adapterConfig: { model: "worker-model" } }, ...transition.patch });
    const review = await runToEnd(pm.agentId, { issueId: childId });
    expect({ status: review.run.status, error: review.run.error }).toEqual({ status: "succeeded", error: null });
    expect(review.calls[0]![0].config.model).toBe("pm-model");
    expect(review.calls[0]![0].context.aiConnection).toBeUndefined();
  }, 60_000);

  it.each(["review", "approval"] as const)("keeps a dual-role %s stage in the PM home and restores worker overrides after revision", async (type) => {
    // Legacy dual-role compatibility. Zero-slot PMs use the qualified native
    // review route exercised by pm-coordination.test.ts.
    const pm = await seedPm({ workerSlots: 1 });
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

  it("runs D and E through one shared worker with independent capacity and pinned remote cwd", async () => {
    await instanceSettingsService(db).updateExperimental({ enableIsolatedWorkspaces: true });
    const companyId = randomUUID(), agentId = randomUUID();
    await db.insert(companies).values({ id: companyId, name: "Shared remote company", issuePrefix: `S${companyId.slice(0, 6)}`, defaultResponsibleUserId: "responsible-user" });
    await db.insert(companyMemberships).values({ companyId, principalType: "user", principalId: "responsible-user", status: "active", membershipRole: "member" });
    await db.insert(agents).values({ id: agentId, companyId, name: "Shared Codex", status: "idle", adapterType: "ccpocket_bridge",
      adapterConfig: { provider: "codex", hostId: "shopee-e", model: "shopee-e/codex/default" },
      runtimeConfig: { requireProjectWorkspace: true, bridgeWorkerHostCapacity: { "shopee-d": 1, "shopee-e": 1 },
        heartbeat: { enabled: false, wakeOnDemand: true, maxConcurrentRuns: 2 } }, permissions: {} });
    const tasks: Array<{ id: string; hostId: string; cwd: string }> = [];
    for (const hostId of ["shopee-d", "shopee-d", "shopee-e"]) {
      const id = randomUUID(), projectId = randomUUID(), sourceId = randomUUID(), cwd = `/remote-only/${companyId}/${projectId}`;
      await db.insert(projects).values({ id: projectId, companyId, name: id, status: "in_progress",
        executionWorkspacePolicy: { enabled: true, defaultMode: "shared_workspace", workspaceStrategy: { type: "project_primary" } } });
      await db.insert(projectWorkspaces).values({ id: sourceId, companyId, projectId, name: "Remote source", sourceType: "remote_managed", cwd,
        metadata: { hostId }, remoteWorkspaceRef: `${hostId}:${cwd}`, isPrimary: true });
      const executionWorkspaceId = randomUUID();
      await seedManagedDispatchWorkspace(db, { id: executionWorkspaceId, companyId, projectId, sourceId, cwd, hostId, kind: "repository_root" });
      await db.insert(issues).values({ id, companyId, projectId, projectWorkspaceId: sourceId, executionWorkspaceId,
        executionWorkspacePreference: "reuse_existing", executionWorkspaceSettings: { mode: "isolated_workspace", workspaceStrategy: { type: "git_worktree" } },
        title: id, status: "todo", assigneeAgentId: agentId,
        assigneeAdapterOverrides: { adapterConfig: { model: `${hostId}/codex/task-model` } } });
      tasks.push({ id, hostId, cwd });
    }
    const gates = new Map<string, () => void>();
    execute.mockImplementation(async (input: any) => {
      await new Promise<void>(resolve => gates.set(input.runId, resolve));
      return { exitCode: 0, signal: null, timedOut: false };
    });
    try {
      const runs: string[] = [];
      for (const task of tasks) {
        const wake = await heartbeat.wakeup(agentId, { source: "on_demand", triggerDetail: "manual", contextSnapshot: { issueId: task.id } });
        runs.push(wake!.id);
      }
      await vi.waitFor(async () => {
        for (const index of [0, 2]) {
          const run = await heartbeat.getRun(runs[index]!);
          expect(gates.has(runs[index]!), JSON.stringify({ status: run?.status, error: run?.error, code: run?.errorCode })).toBe(true);
        }
      }, { timeout: 20_000 });
      expect((await heartbeat.getRun(runs[1]!))!.status).toBe("queued");
      for (const index of [0, 2]) {
        const input = execute.mock.calls.find(([input]) => input.runId === runs[index])![0];
        expect(input.config).toMatchObject({ hostId: tasks[index]!.hostId, model: `${tasks[index]!.hostId}/codex/task-model` });
        expect(input.context.paperclipWorkspace).toMatchObject({ cwd: tasks[index]!.cwd, remoteHostId: tasks[index]!.hostId });
        expect((await heartbeat.getRun(runs[index]!))!.contextSnapshot).toMatchObject({ bridgeWorkerRoute: { hostId: tasks[index]!.hostId } });
      }
      gates.get(runs[0]!)!();
      await vi.waitFor(() => expect(gates.has(runs[1]!)).toBe(true), { timeout: 20_000 });
      expect((await heartbeat.getRun(runs[2]!))!.status).toBe("running");
      for (const release of gates.values()) release();
      await vi.waitFor(async () => {
        for (const id of runs) {
          const run = await heartbeat.getRun(id);
          expect({ status: run?.status, error: run?.error }).toEqual({ status: "succeeded", error: null });
        }
      }, { timeout: 20_000 });
    } finally {
      for (const release of gates.values()) release();
      execute.mockImplementation(async () => ({ exitCode: 0, signal: null, timedOut: false }));
    }
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

  it("runs a remote-host main agent's task in its fixed remote source without probing it locally", async () => {
    const companyId = randomUUID(), projectId = randomUUID(), agentId = randomUUID(), issueId = randomUUID();
    const cwd = "/remote-only/" + companyId + "/Product_Matching";
    await db.insert(companies).values({ id: companyId, name: "Remote main company", issuePrefix: `Q${companyId.slice(0, 6)}`, defaultResponsibleUserId: "responsible-user" });
    await db.insert(companyMemberships).values({ companyId, principalType: "user", principalId: "responsible-user", status: "active", membershipRole: "member" });
    await db.insert(projects).values({ id: projectId, companyId, name: "Remote main", status: "in_progress" });
    await db.insert(projectWorkspaces).values({ id: randomUUID(), companyId, projectId, name: "Repo", sourceType: "remote_managed", cwd, isPrimary: true });
    await db.insert(agents).values({ id: agentId, companyId, name: "Main", role: "engineer", status: "idle", adapterType: "ccpocket_bridge",
      adapterConfig: { hostId: "shopee-e", role: "main", cwd }, runtimeConfig: { workspaceBinding: { mode: "fixed", cwd, hostId: "shopee-e" } }, permissions: {} });
    await db.insert(issues).values({ id: issueId, companyId, projectId, title: "Remote task", status: "todo", assigneeAgentId: agentId });
    const taskRun = await runToEnd(agentId, { issueId });
    expect({ status: taskRun.run.status, error: taskRun.run.error }).toEqual({ status: "succeeded", error: null });
    expect(taskRun.calls[0]![0].context.paperclipWorkspace.cwd).toBe(cwd);
    const chatRun = await runToEnd(agentId, {});
    expect({ status: chatRun.run.status, error: chatRun.run.error }).toEqual({ status: "succeeded", error: null });
    expect(chatRun.calls[0]![0].context.paperclipWorkspace.cwd).toBe(cwd);
    // Another host's adapter configuration is refused before the adapter starts.
    await db.update(agents).set({ adapterConfig: { hostId: "shopee-d", role: "main", cwd } }).where(eq(agents.id, agentId));
    const mismatched = await runToEnd(agentId, {});
    expect(mismatched.run.status).toBe("failed");
    expect(mismatched.calls).toHaveLength(0);
  }, 60_000);

  it("runs one PM turn beside up to workerSlots worker turns and keeps a full role queued", async () => {
    // Role capacity is independent of the physical writer claim. Give each
    // worker a registered, disjoint directory so only role slots limit it.
    const pm = await seedPm({ allowCrossProject: true });
    const second = await seedOtherProject(pm.companyId);
    const third = await seedOtherProject(pm.companyId, "third-repo");
    const gates = new Map<string, () => void>();
    execute.mockImplementation(async (input: any) => {
      await new Promise<void>((resolve) => gates.set(input.runId, resolve));
      return { exitCode: 0, signal: null, timedOut: false };
    });
    try {
      const child = async (title: string, projectId: string) => {
        const id = randomUUID();
        await db.insert(issues).values({ id, companyId: pm.companyId, projectId, parentId: pm.inboxIssueId, title, status: "todo", assigneeAgentId: pm.agentId });
        return id;
      };
      const topLevelId = randomUUID();
      await db.insert(issues).values({ id: topLevelId, companyId: pm.companyId, projectId: pm.projectId, title: "Plan the release", status: "todo", assigneeAgentId: pm.agentId });
      const [c1, c2, c3] = [await child("One", pm.projectId), await child("Two", second.otherProjectId), await child("Three", third.otherProjectId)];
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
      for (const [runId, cwd] of [[w1, pm.workerRoot], [w2, second.otherRoot]]) {
        const call = execute.mock.calls.find(([input]) => input.runId === runId)!;
        expect(call[0].context.paperclipWorkspace.cwd).toBe(cwd);
        expect((await heartbeat.getRun(runId!))!.contextSnapshot).toMatchObject({ sharedCheckoutClaim: { path: cwd } });
      }

      gates.get(pm1)!();
      await vi.waitFor(() => expect(started().has(pm2)).toBe(true), { timeout: 15_000 });
      expect(await status(w3)).toBe("queued");
      const pm2Run = await heartbeat.getRun(pm2);
      expect((pm2Run!.contextSnapshot as Record<string, any>).paperclipPmWorkspace).toMatchObject({ role: "pm", cwd: pm.agentHome, issueId: topLevelId });

      gates.get(w1)!();
      await vi.waitFor(() => expect(started().has(w3)).toBe(true), { timeout: 15_000 });
      const w3Call = execute.mock.calls.find(([input]) => input.runId === w3)!;
      expect(w3Call[0].context.paperclipPmWorkspace).toMatchObject({ role: "worker", cwd: third.otherRoot, issueId: c3 });
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
