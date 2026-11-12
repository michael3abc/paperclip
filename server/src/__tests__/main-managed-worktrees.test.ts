import { randomUUID } from "node:crypto";
import { hostname } from "node:os";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { eq } from "drizzle-orm";
import { agents, companies, createDb, executionWorkspaces, heartbeatRuns, issues, projects, projectWorkspaces,
  workspaceOperations, EMBEDDED_POSTGRES_TEST_TIMEOUT_MS } from "@paperclipai/db";
import { readMainManagedWorktree } from "@paperclipai/shared";
import type { ManagedWorktreeHostInput, ManagedWorktreeHostResult } from "@paperclipai/adapter-utils/managed-worktree-host";
import { getEmbeddedPostgresTestSupport, startEmbeddedPostgresTestDatabase } from "./helpers/embedded-postgres.js";
import { mainManagedWorktreeService } from "../services/main-managed-worktrees.js";
import { claimAdapterSessionAuthority } from "../services/adapter-session-authority.js";
import { resolveCooperativeTaskWorkspace } from "../services/cooperative-task-workspace.js";
import { issueService } from "../services/issues.js";

const support = await getEmbeddedPostgresTestSupport();
(support.supported ? describe : describe.skip)("main managed worktree lifecycle", () => {
  let database: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>>;
  let db: ReturnType<typeof createDb>;
  beforeAll(async () => {
    database = await startEmbeddedPostgresTestDatabase("managed-worktrees-"); db = createDb(database.connectionString);
  }, EMBEDDED_POSTGRES_TEST_TIMEOUT_MS);
  afterAll(async () => { await db?.$client.end({ timeout: 0 }); await database?.cleanup(); });
  async function fixture(remote = false) {
    const companyId = randomUUID(), projectId = randomUUID(), agentId = randomUUID(), sourceId = randomUUID(), workspaceId = randomUUID(), issueId = randomUUID(), runId = randomUUID();
    const sourceCwd = "/fixture/" + projectId + "/source", parentDir = "/fixture/" + projectId + "/trees";
    await db.insert(companies).values({ id: companyId, name: "Managed tree fixture", issuePrefix: "MW" + companyId.slice(0, 7) });
    await db.insert(agents).values({ id: agentId, companyId, name: "Main", role: "engineer", adapterType: "ccpocket_bridge",
      adapterConfig: { role: "main", projectId, cwd: sourceCwd }, status: "running" });
    await db.insert(projects).values({ id: projectId, companyId, name: "Managed project", leadAgentId: agentId,
      executionWorkspacePolicy: { enabled: true, workspaceStrategy: { type: "git_worktree", worktreeParentDir: parentDir } } });
    await db.insert(projectWorkspaces).values({ id: sourceId, companyId, projectId, name: "Source", cwd: sourceCwd,
      sourceType: remote ? "remote_managed" : "local_path", metadata: remote ? { hostId: "fixture-remote" } : {} });
    await db.insert(issues).values({ id: issueId, companyId, projectId, title: "Original conversation", status: "in_progress", assigneeAgentId: agentId });
    await db.insert(heartbeatRuns).values({ id: runId, companyId, agentId, status: "running", invocationSource: "on_demand",
      contextSnapshot: { issueId }, runnerProfileJson: { adapterDispatch: { adapterType: "ccpocket_bridge" } } });
    await claimAdapterSessionAuthority(db, { companyId, agentId, runId, taskKey: issueId }, {
      hostId: "fixture", provider: "codex", nativeSessionId: randomUUID(), bridgeSessionId: randomUUID(),
      expectedPreviousRunId: null, expectedGeneration: 0, operationId: randomUUID(),
    });
    const actor = { type: "agent" as const, source: "agent_jwt" as const, companyId, agentId, runId };
    const scope = { companyId, projectId, workspaceId, actor };
    const response = (input: ManagedWorktreeHostInput): ManagedWorktreeHostResult => ({ schema: "paperclip.managed-worktree-host.v1",
      action: input.action, operationId: input.operationId, cwd: input.cwd, commonDir: sourceCwd + "/.git",
      head: "a".repeat(40), targetHead: "a".repeat(40), branch: input.branch, dirty: false, merged: true,
      ...(input.action === "retire" ? { retired: true } : {}) });
    const host = vi.fn(async (_host: string | null, input: ManagedWorktreeHostInput) => response(input));
    const service = mainManagedWorktreeService(db, { host, receiptRoot: "/private/test-receipts" });
    const registration = { action: "register" as const, operationId: randomUUID(), expectedGeneration: 0, projectWorkspaceId: sourceId,
      name: "batch", branch: "michael/batch", targetBranch: "michael/main" };
    const command = (action: "join" | "leave" | "converge" | "reopen" | "merge" | "retire", expectedGeneration: number) =>
      ({ action, expectedGeneration, operationId: randomUUID(), ...(action === "join" || action === "leave" ? { issueId } : {}),
        ...(["merge", "retire"].includes(action) ? { expectedHead: "a".repeat(40), expectedTargetHead: "a".repeat(40) } : {}) });
    const row = async () => (await db.select().from(executionWorkspaces).where(eq(executionWorkspaces.id, workspaceId)))[0]!;
    return { scope, service, host, response, registration, command, row, companyId, projectId, agentId, sourceId, workspaceId, issueId, runId, sourceCwd, parentDir };
  }

  it("registers once with durable generation and never treats the origin task as its owner", async () => {
    const f = await fixture();
    const receipt = await f.service.operate(f.scope, f.registration);
    expect(receipt).toMatchObject({ phase: "open", generation: 1 });
    expect(await f.service.operate(f.scope, f.registration)).toEqual(receipt);
    expect(f.host).toHaveBeenCalledTimes(1);
    expect(await f.row()).toMatchObject({ sourceIssueId: null, cleanupEligibleAt: null });
    await db.update(issues).set({ status: "done" }).where(eq(issues.id, f.issueId));
    expect(readMainManagedWorktree((await f.row()).metadata)?.phase).toBe("open");
  });

  it("registers a repository root and retires metadata without merging or deleting its directory", async () => {
    const f = await fixture();
    const registration = { ...f.registration, kind: "repository_root" as const, cwd: f.sourceCwd,
      branch: "michael/main", targetBranch: "michael/main" };
    f.host.mockImplementationOnce(async (_host, input) => ({ ...f.response(input), head: null, targetHead: null, merged: false, dirty: true }));
    expect(await f.service.operate(f.scope, registration)).toMatchObject({ phase: "open", generation: 1 });
    expect(readMainManagedWorktree((await f.row()).metadata)).toMatchObject({ kind: "repository_root", lastReceipt: { head: null } });
    await f.service.operate(f.scope, f.command("converge", 1));
    await expect(f.service.operate(f.scope, f.command("merge", 2))).rejects.toThrow("repository_root_metadata_lifecycle_only");
    expect(await f.service.operate(f.scope, { action: "retire", expectedGeneration: 2, operationId: randomUUID() }))
      .toMatchObject({ phase: "retired", generation: 3, filesystemEffect: "none" });
    expect(f.host).toHaveBeenCalledTimes(1);
    expect(await f.row()).toMatchObject({ cwd: f.sourceCwd, status: "archived" });
  });

  it("adopts an existing nested workspace ID and transports explicit initialization to its registered host", async () => {
    const f = await fixture(true), cwd = f.parentDir + "/paperclip/task-id/original";
    await db.insert(executionWorkspaces).values({ id: f.workspaceId, companyId: f.companyId, projectId: f.projectId,
      projectWorkspaceId: f.sourceId, name: "Legacy", cwd, branchName: null, mode: "isolated_workspace",
      strategyType: "git_worktree", providerType: "remote_managed", metadata: { legacyEvidence: "keep" } });
    const command = { ...f.registration, action: "initialize" as const, kind: "repository_root" as const, cwd,
      branch: "main", targetBranch: "main" };
    await f.service.operate(f.scope, command);
    expect(f.host).toHaveBeenCalledWith("fixture-remote", expect.objectContaining({ action: "initialize", kind: "repository_root", cwd }));
    expect(await f.row()).toMatchObject({ id: f.workspaceId, cwd, branchName: "main", metadata: { legacyEvidence: "keep" } });
    expect(await f.service.operate(f.scope, command)).toMatchObject({ workspaceId: f.workspaceId, generation: 1 });
    expect(f.host).toHaveBeenCalledTimes(1);
  });

  it("rejects foreign nested source scope and out-of-parent coordinates before host operations", async () => {
    const f = await fixture(), foreignProject = randomUUID();
    await db.insert(projects).values({ id: foreignProject, companyId: f.companyId, name: "Foreign" });
    await db.insert(projectWorkspaces).values({ companyId: f.companyId, projectId: foreignProject, name: "Foreign source",
      cwd: f.sourceCwd + "/private-project", sourceType: "local_path" });
    await expect(f.service.operate(f.scope, { ...f.registration, kind: "repository_root", cwd: f.sourceCwd + "/private-project/nested" }))
      .rejects.toThrow("worktree_foreign_project_path");
    await expect(f.service.operate(f.scope, { ...f.registration, kind: "repository_root", cwd: "/unapproved/source" }))
      .rejects.toThrow("worktree_path_outside_parent");
    expect(f.host).not.toHaveBeenCalled();
  });

  it("adopts a local legacy git_worktree row without broad same-company source exclusion", async () => {
    const f = await fixture(), broadProject = randomUUID(), cwd = f.sourceCwd + "/paperclip/task-id";
    await db.insert(projects).values({ id: broadProject, companyId: f.companyId, name: "Broad session cwd" });
    await db.insert(projectWorkspaces).values({ companyId: f.companyId, projectId: broadProject, name: "Broad",
      cwd: "/fixture/" + f.projectId, sourceType: "local_path" });
    await db.insert(executionWorkspaces).values({ id: f.workspaceId, companyId: f.companyId, projectId: f.projectId,
      projectWorkspaceId: f.sourceId, name: "Legacy", cwd, branchName: "michael/batch", mode: "isolated_workspace",
      strategyType: "git_worktree", providerType: "git_worktree", metadata: { trainingReceipt: "retain" } });
    await f.service.operate(f.scope, { ...f.registration, cwd });
    expect(await f.row()).toMatchObject({ id: f.workspaceId, providerType: "git_worktree", metadata: { trainingReceipt: "retain" } });
    expect(f.host).toHaveBeenCalledWith(null, expect.objectContaining({ cwd }));
    expect(f.host.mock.calls[0]![1].excludedRoots).not.toContain("/fixture/" + f.projectId);
  });

  it("adopts the original local git_repo source and nested git_worktree without a source alias", async () => {
    const f = await fixture(), cwd = f.parentDir + "/paperclip/" + f.issueId;
    await db.update(projectWorkspaces).set({ sourceType: "git_repo", metadata: { hostId: hostname(), usage: "development" },
      repoUrl: null, remoteProvider: null, remoteWorkspaceRef: null }).where(eq(projectWorkspaces.id, f.sourceId));
    const [sourceBefore] = await db.select().from(projectWorkspaces).where(eq(projectWorkspaces.id, f.sourceId));
    await db.insert(executionWorkspaces).values({ id: f.workspaceId, companyId: f.companyId, projectId: f.projectId,
      projectWorkspaceId: f.sourceId, name: "Legacy", cwd, branchName: "michael/batch", mode: "isolated_workspace",
      strategyType: "git_worktree", providerType: "git_worktree", metadata: { trainingReceipt: "retain" } });
    await f.service.operate(f.scope, { ...f.registration, cwd });
    expect(f.host).toHaveBeenCalledWith(null, expect.objectContaining({ action: "inspect", cwd, sourceCwd: f.sourceCwd }));
    expect(await f.row()).toMatchObject({ id: f.workspaceId, projectWorkspaceId: f.sourceId, providerType: "git_worktree", cwd, metadata: { trainingReceipt: "retain" } });
    expect((await db.select().from(projectWorkspaces).where(eq(projectWorkspaces.id, f.sourceId)))[0]).toEqual(sourceBefore);
  });

  it("a local git_repo with an origin URL still requires host Git validation", async () => {
    const f = await fixture();
    await db.update(projectWorkspaces).set({ sourceType: "git_repo", repoUrl: "https://example.invalid/source.git", metadata: {} }).where(eq(projectWorkspaces.id, f.sourceId));
    f.host.mockRejectedValueOnce(Object.assign(new Error("not a git repository"), { worktreeEffectStarted: false }));
    await expect(f.service.operate(f.scope, f.registration)).rejects.toThrow("not a git repository");
    expect(f.host).toHaveBeenCalledWith(null, expect.objectContaining({ action: "inspect" }));
    expect(readMainManagedWorktree((await f.row()).metadata)?.phase).not.toBe("open");
  });

  it.each([
    { metadata: { hostId: "foreign-host" } },
    { metadata: { hostId: 42 } },
    { remoteProvider: "remote-provider" },
    { remoteWorkspaceRef: "remote-workspace" },
  ])("rejects remote or ambiguous git_repo coordinates before local host I/O: %j", async patch => {
    const f = await fixture();
    await db.update(projectWorkspaces).set({ sourceType: "git_repo", ...patch }).where(eq(projectWorkspaces.id, f.sourceId));
    await expect(f.service.operate(f.scope, f.registration)).rejects.toThrow("worktree_host_capability_unavailable");
    expect(f.host).not.toHaveBeenCalled();
    expect(await f.row()).toBeUndefined();
  });

  it("a git_repo URL without a local cwd is never auto-cloned for registration", async () => {
    const f = await fixture();
    await db.update(projectWorkspaces).set({ sourceType: "git_repo", cwd: null, repoUrl: "https://example.invalid/source.git" }).where(eq(projectWorkspaces.id, f.sourceId));
    await expect(f.service.operate(f.scope, f.registration)).rejects.toThrow("worktree_source_configuration_required");
    expect(f.host).not.toHaveBeenCalled();
  });

  it("admits an unborn registered root without a first commit while retaining current-run authorization", async () => {
    const f = await fixture();
    f.host.mockImplementation(async (_host, input) => ({ ...f.response(input), head: null, targetHead: null, merged: false, dirty: true }));
    await f.service.operate(f.scope, { ...f.registration, kind: "repository_root", cwd: f.sourceCwd });
    await db.update(issues).set({ executionWorkspaceId: f.workspaceId,
      workspaceSelection: { version: 1, source: "explicit", selection: { kind: "existing", workspaceId: f.workspaceId } },
    }).where(eq(issues.id, f.issueId));
    expect(await f.service.prepareRun(f.scope, f.issueId, 1)).toMatchObject({ generation: 1, observed: { head: null } });
    expect(f.host).toHaveBeenLastCalledWith(null, expect.objectContaining({ action: "inspect", kind: "repository_root" }));
    await db.update(heartbeatRuns).set({ status: "cancelled" }).where(eq(heartbeatRuns.id, f.runId));
    await expect(f.service.prepareRun(f.scope, f.issueId, 1)).rejects.toThrow();
    expect(f.host).toHaveBeenCalledTimes(2);
  });

  it("allows multiple task participants without a writer lock, closes join at converge and reopens explicitly", async () => {
    const f = await fixture(); await f.service.operate(f.scope, f.registration);
    const board = { ...f.scope, actor: { type: "board" as const, source: "local_implicit" as const, isInstanceAdmin: true } };
    const otherIssue = randomUUID();
    await db.insert(issues).values({ id: otherIssue, companyId: f.companyId, projectId: f.projectId, title: "Other task", status: "in_progress", assigneeAgentId: f.agentId });
    await Promise.all([
      f.service.operate(f.scope, f.command("join", 1)),
      f.service.operate(board, { ...f.command("join", 1), issueId: otherIssue }),
    ]);
    expect(Object.keys(readMainManagedWorktree((await f.row()).metadata)!.participants)).toHaveLength(2);
    expect(await f.service.operate(f.scope, f.command("converge", 1))).toMatchObject({ phase: "converging", generation: 2 });
    await expect(f.service.operate(f.scope, f.command("join", 2))).rejects.toThrow("workspace_converging");
    await expect(f.service.operate(f.scope, f.command("reopen", 1))).rejects.toThrow("worktree_generation_conflict");
    expect(await f.service.operate(f.scope, f.command("reopen", 2))).toMatchObject({ phase: "open", generation: 3 });
  });

  it("serializes concurrent converge calls and persists only the winner", async () => {
    const f = await fixture(); await f.service.operate(f.scope, f.registration);
    const results = await Promise.allSettled([f.service.operate(f.scope, f.command("converge", 1)), f.service.operate(f.scope, f.command("converge", 1))]);
    expect(results.filter(result => result.status === "fulfilled")).toHaveLength(1);
    expect((await f.row()).metadata?.lifecycleGeneration).toBe(2);
  });

  it("requires registered worktrees at task creation, preserves session-only resources, and refuses a converging default", async () => {
    const f = await fixture();
    const input = { companyId: f.companyId, projectId: f.projectId };
    await expect(resolveCooperativeTaskWorkspace(db, input)).rejects.toMatchObject({ details: { code: "configuration_required" } });
    const task = { title: "Code task", projectId: f.projectId, assigneeAgentId: f.agentId };
    await expect(issueService(db).create(f.companyId, task)).rejects.toThrow("Select a linked worktree");
    await f.service.operate(f.scope, f.registration);
    const operation = { action: "set_default" as const, expectedGeneration: 1, operationId: randomUUID() };
    await f.service.operate(f.scope, operation);
    await f.service.operate(f.scope, operation);
    expect(await resolveCooperativeTaskWorkspace(db, input)).toMatchObject({ executionWorkspaceId: f.workspaceId,
      executionWorkspaceSettings: { sessionOnly: false } });
    const created = await issueService(db).create(f.companyId, task);
    expect(created).toMatchObject({ executionWorkspaceId: f.workspaceId, workspaceSelection: { selection: { kind: "existing", workspaceId: f.workspaceId } } });
    expect(await resolveCooperativeTaskWorkspace(db, { ...input, executionWorkspaceSettings: { sessionOnly: true } }))
      .toMatchObject({ executionWorkspaceId: null, projectWorkspaceId: null });
    expect(await resolveCooperativeTaskWorkspace(db, { ...input, conversationAgentId: f.agentId }))
      .toMatchObject({ executionWorkspaceId: null, executionWorkspaceSettings: { sessionOnly: true } });
    await f.service.operate(f.scope, f.command("converge", 2));
    await expect(issueService(db).create(f.companyId, task)).rejects.toThrow("closed to new work");
    expect(await db.select().from(issues).where(eq(issues.companyId, f.companyId))).toHaveLength(2);
  });

  it("keeps unknown host outcomes pending across restart and reconciles only the original operation", async () => {
    const f = await fixture();
    const creation = { ...f.registration, action: "create" as const, expectedHead: "a".repeat(40), expectedTargetHead: "a".repeat(40) };
    f.host.mockRejectedValueOnce(new Error("lost reply"));
    await expect(f.service.operate(f.scope, creation)).rejects.toThrow("lost reply");
    expect(readMainManagedWorktree((await f.row()).metadata)?.pendingOperationId).toBe(f.registration.operationId);
    await expect(f.service.operate(f.scope, f.command("reopen", 1))).rejects.toThrow("worktree_operation_reconciliation_required");
    const restarted = mainManagedWorktreeService(db, { host: f.host, receiptRoot: "/private/test-receipts" });
    expect(await restarted.recheck(f.scope, f.registration.operationId, 1)).toMatchObject({ phase: "open", generation: 1 });
    expect(f.host.mock.calls[1]![1]).toMatchObject({ operationId: f.registration.operationId, action: "create", recheckOnly: true });
  });

  it("does not let a refused retire deadlock reopening the tree", async () => {
    const f = await fixture(); await f.service.operate(f.scope, f.registration);
    await f.service.operate(f.scope, f.command("join", 1));
    await f.service.operate(f.scope, f.command("converge", 1));
    await f.service.operate(f.scope, f.command("merge", 2));
    await expect(f.service.operate(f.scope, f.command("retire", 3))).rejects.toThrow("retire_blocked_participants");
    expect(readMainManagedWorktree((await f.row()).metadata)?.pendingOperationId).toBeNull();
    expect(await f.service.operate(f.scope, f.command("reopen", 4))).toMatchObject({ phase: "open", generation: 5 });
    expect(f.host.mock.calls.map(call => call[1].action)).toEqual(["inspect", "merge"]);
  });

  it("requires the current running main and preserves Owner holds", async () => {
    const f = await fixture();
    await expect(f.service.operate({ ...f.scope, actor: { ...f.scope.actor, source: "agent_key", runId: undefined } }, f.registration)).rejects.toThrow("run-bound");
    await db.update(heartbeatRuns).set({ status: "succeeded" }).where(eq(heartbeatRuns.id, f.runId));
    await expect(f.service.operate(f.scope, f.registration)).rejects.toThrow("no longer running");
    await db.update(heartbeatRuns).set({ status: "running" }).where(eq(heartbeatRuns.id, f.runId));
    await db.update(agents).set({ lifecycleHolds: ["manual"] }).where(eq(agents.id, f.agentId));
    await expect(f.service.operate(f.scope, f.registration)).rejects.toThrow("held");
    expect(f.host).not.toHaveBeenCalled();
  });

  it.each(["paused", "manual_hold", "project_paused"])("prepareRun preserves %s while permitting recovery of error status", async blocker => {
    const f = await fixture(); await f.service.operate(f.scope, f.registration);
    await db.update(issues).set({ executionWorkspaceId: f.workspaceId,
      workspaceSelection: { version: 1, source: "explicit", selection: { kind: "existing", workspaceId: f.workspaceId } },
    }).where(eq(issues.id, f.issueId));
    if (blocker === "paused") await db.update(agents).set({ status: "paused" }).where(eq(agents.id, f.agentId));
    if (blocker === "manual_hold") await db.update(agents).set({ status: "error", lifecycleHolds: ["manual"] }).where(eq(agents.id, f.agentId));
    if (blocker === "project_paused") await db.update(projects).set({ pausedAt: new Date() }).where(eq(projects.id, f.projectId));
    await expect(f.service.prepareRun(f.scope, f.issueId, 1)).rejects.toThrow("worktree_run_no_longer_admitted");
    expect(f.host).toHaveBeenCalledTimes(1); // registration only; no host dispatch after the hold.
  });

  it("routes a remote source to its registered host, never to controller filesystem operations", async () => {
    const f = await fixture(true); await f.service.operate(f.scope, f.registration);
    expect(f.host.mock.calls[0]).toMatchObject(["fixture-remote", { cwd: f.parentDir + "/batch", sourceCwd: f.sourceCwd }]);
    expect(readMainManagedWorktree((await f.row()).metadata)?.hostId).toBe("fixture-remote");
  });

  it("rejects an operation ID reused for different input and leaves the original receipt intact", async () => {
    const f = await fixture(); await f.service.operate(f.scope, f.registration);
    await expect(f.service.operate(f.scope, { ...f.registration, name: "other" })).rejects.toThrow("worktree_operation_conflict");
    const [saved] = await db.select().from(workspaceOperations).where(eq(workspaceOperations.id, f.registration.operationId));
    expect(saved.status).toBe("succeeded"); expect(f.host).toHaveBeenCalledTimes(1);
  });
});
