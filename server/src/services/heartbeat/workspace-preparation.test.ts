import { execFile as execFileCallback } from "node:child_process";
import { mkdtemp, mkdir, readFile, rm, writeFile, access } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { agents, companies, createDb, EMBEDDED_POSTGRES_TEST_TIMEOUT_MS, environmentLeases, heartbeatRuns, issues, projects, projectWorkspaces, type Db } from "@paperclipai/db";
import { eq, sql } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { getEmbeddedPostgresTestSupport, startEmbeddedPostgresTestDatabase } from "../../__tests__/helpers/embedded-postgres.js";
import { environmentRunOrchestrator } from "../environment-run-orchestrator.js";
import { environmentService } from "../environments.js";
import { executionWorkspaceService } from "../execution-workspaces.js";
import { instanceSettingsService } from "../instance-settings.js";
import { issueService } from "../issues.js";
import { workspaceOperationService } from "../workspace-operations.js";
import { createHeartbeatWorkspaceResolver, resolveExecutionWorkspaceReuseRequestForIssue } from "./workspaces.js";
import { prepareHeartbeatWorkspace, type HeartbeatWorkspacePreparationInput } from "./workspace-preparation.js";

const execFile = promisify(execFileCallback);
const support = await getEmbeddedPostgresTestSupport();

describe.skipIf(!support.supported)("heartbeat workspace preparation boundary", () => {
  let database: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>>;
  let db: Db;
  let home: string;

  beforeAll(async () => {
    home = await mkdtemp(join(tmpdir(), "paperclip-workspace-preparation-"));
    vi.stubEnv("PAPERCLIP_HOME", home);
    database = await startEmbeddedPostgresTestDatabase("paperclip-workspace-preparation");
    db = createDb(database.connectionString);
    await db.execute(sql`set client_min_messages = warning`);
  }, EMBEDDED_POSTGRES_TEST_TIMEOUT_MS);
  afterAll(async () => {
    await db?.$client.end();
    await database?.cleanup();
    vi.unstubAllEnvs();
    if (home) await rm(home, { recursive: true, force: true });
  });
  beforeEach(async () => {
    vi.restoreAllMocks();
    await db.execute(sql`truncate table companies restart identity cascade`);
    await instanceSettingsService(db).updateExperimental({ enableIsolatedWorkspaces: true });
  });

  async function fixture(isolated = false) {
    const [company] = await db.insert(companies).values({ name: "Workspace preparation", issuePrefix: "WSP" }).returning();
    const [agent] = await db.insert(agents).values({ companyId: company.id, name: "Workspace agent", status: "running", adapterType: "process" }).returning();
    const [project] = await db.insert(projects).values({ companyId: company.id, name: "Source project" }).returning();
    const source = join(home, project.id);
    await mkdir(source);
    await execFile("git", ["init", "--initial-branch=main", source]);
    await execFile("git", ["-C", source, "config", "user.email", "test@example.com"]);
    await execFile("git", ["-C", source, "config", "user.name", "Workspace test"]);
    await writeFile(join(source, "README.md"), "source content\n");
    await execFile("git", ["-C", source, "add", "."]);
    await execFile("git", ["-C", source, "commit", "-m", "Source"]);
    const [projectWorkspace] = await db.insert(projectWorkspaces).values({ companyId: company.id, projectId: project.id, name: "Source", cwd: source, isPrimary: true }).returning();
    const [issue] = await db.insert(issues).values({ companyId: company.id, title: "Prepare this workspace", identifier: "WSP-1", projectId: project.id, projectWorkspaceId: projectWorkspace.id, assigneeAgentId: agent.id }).returning();
    const [run] = await db.insert(heartbeatRuns).values({ companyId: company.id, agentId: agent.id, issueId: issue.id, scopeKind: "issue", status: "running", runtimeMode: "legacy" }).returning();
    const localEnvironment = await environmentService(db).ensureLocalEnvironment(company.id);
    const envOrchestrator = environmentRunOrchestrator(db);
    const resolver = createHeartbeatWorkspaceResolver(db);
    const input: HeartbeatWorkspacePreparationInput = {
      run, agent,
      task: { issueRef: issue, issueId: issue.id, context: { issueId: issue.id, projectId: project.id }, executionProjectId: project.id, responsibleUserId: null, previousSessionParams: null },
      policy: {
        trustPreset: { kind: "standard", preset: "standard", boundary: null, sourcePresets: {} },
        isolatedWorkspacesEnabled: true,
        effectiveExecutionWorkspaceMode: isolated ? "isolated_workspace" : "shared_workspace",
        requestedExecutionWorkspaceMode: isolated ? "isolated_workspace" : "shared_workspace",
        useIsolatedTaskDirectory: false, nativeChatWorkspaceScope: null,
        projectExecutionWorkspacePolicy: null, issueExecutionWorkspaceSettings: null, environmentExecutionWorkspaceSettings: null,
        executionPolicy: { executionMode: "any" },
      },
      environment: { selectedEnvironmentId: localEnvironment.id, localEnvironment, selectedEnvironmentForConfig: localEnvironment, environmentResolution: { environmentId: localEnvironment.id, source: "default" }, resolvedInstanceSettings: await instanceSettingsService(db).get() },
      config: { mergedConfig: isolated ? { workspaceStrategy: { type: "git_worktree", baseRef: "main", branchTemplate: "test-{{issue.identifier}}" } } : {}, configSnapshot: null, secretManifest: [] },
      reuse: { requestedShouldReuseExisting: false, existingExecutionWorkspace: null, reusableExistingExecutionWorkspace: null, workspaceReuseRequest: resolveExecutionWorkspaceReuseRequestForIssue({ issueExecutionWorkspaceId: null, issueExecutionWorkspacePreference: null, existingExecutionWorkspaceStatus: null }), nativeRecoveryExecutionWorkspaceId: null, persistedNativeExecutionInput: null, isDotRun: false, runOptions: {} },
      services: { envOrchestrator, executionWorkspacesSvc: executionWorkspaceService(db), workspaceOperationsSvc: workspaceOperationService(db), issuesSvc: issueService(db), ...resolver, appendRunEvent: vi.fn() },
      controllerLease: { assertOwned: vi.fn(async () => {}) }, nativeRunnerPreparationSpans: [],
    };
    return { input, source, issue, run, envOrchestrator };
  }
  const readIssue = (id: string) => db.select().from(issues).where(eq(issues.id, id)).then(rows => rows[0]!);
  const readRun = (id: string) => db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, id)).then(rows => rows[0]!);
  const leases = (id: string) => db.select().from(environmentLeases).where(eq(environmentLeases.heartbeatRunId, id));

  async function reuse(input: HeartbeatWorkspacePreparationInput, workspace: NonNullable<Awaited<ReturnType<typeof prepareHeartbeatWorkspace>>["persistedExecutionWorkspace"]>) {
    input.reuse.requestedShouldReuseExisting = true;
    input.reuse.existingExecutionWorkspace = workspace;
    input.reuse.reusableExistingExecutionWorkspace = workspace;
    input.reuse.workspaceReuseRequest = resolveExecutionWorkspaceReuseRequestForIssue({ issueExecutionWorkspaceId: workspace.id, issueExecutionWorkspacePreference: "reuse_existing", existingExecutionWorkspaceStatus: workspace.status });
    input.task.issueRef = { ...input.task.issueRef!, executionWorkspaceId: workspace.id, executionWorkspacePreference: "reuse_existing" };
    const [run] = await db.insert(heartbeatRuns).values({ companyId: input.run.companyId, agentId: input.agent.id, issueId: input.task.issueId, scopeKind: "issue", status: "running", runtimeMode: "legacy" }).returning();
    input.run = run;
  }

  it("persists the workspace and issue binding before acquiring its environment", async () => {
    const { input, source, issue, envOrchestrator } = await fixture();
    const acquire = envOrchestrator.acquireForRun;
    vi.spyOn(envOrchestrator, "acquireForRun").mockImplementation(async args => {
      expect((await readIssue(issue.id)).executionWorkspaceId).toBe(args.persistedExecutionWorkspace?.id);
      expect((await readRun(input.run.id)).contextSnapshot?.executionWorkspaceId).toBe(args.persistedExecutionWorkspace?.id);
      return acquire(args);
    });
    const result = await prepareHeartbeatWorkspace(db, input);
    expect(result.executionWorkspace.cwd).toBe(source);
    expect(result.persistedExecutionWorkspace).toMatchObject({ companyId: issue.companyId, projectId: issue.projectId, projectWorkspaceId: issue.projectWorkspaceId, mode: "shared_workspace" });
    expect(await leases(input.run.id)).toMatchObject([{ status: "active", executionWorkspaceId: result.persistedExecutionWorkspace!.id }]);
    expect(input.nativeRunnerPreparationSpans.map(span => span.name)).toEqual(["environment.acquire", "environment.workspace.realize"]);
    expect(input.controllerLease.assertOwned).toHaveBeenCalledTimes(2);
  });

  it("keeps a fixed cwd and workspace identity across two continuation rounds without checkout creation", async () => {
    const { input, source } = await fixture();
    input.agent.runtimeConfig = { workspaceBinding: { mode: "fixed", cwd: source } };
    const first = await prepareHeartbeatWorkspace(db, input);
    expect(first.executionWorkspace.cwd).toBe(source);
    expect(first.executionWorkspace.created).toBe(false);
    for (let round = 0; round < 2; round++) {
      await reuse(input, first.persistedExecutionWorkspace!);
      const result = await prepareHeartbeatWorkspace(db, input);
      expect(result.executionWorkspace.cwd).toBe(source);
      expect(result.persistedExecutionWorkspace?.id).toBe(first.persistedExecutionWorkspace!.id);
      expect(result.reusedExecutionWorkspace).toBe(true);
    }
    const { stdout } = await execFile("git", ["-C", source, "worktree", "list", "--porcelain"]);
    expect(stdout.match(/^worktree /gm)).toHaveLength(1);
  });

  it.each([false, true])("uses the fixed cwd for projectless work and operator chat (chat: %s)", async (chat) => {
    const { input, source, issue } = await fixture();
    input.agent.adapterType = "paperclip_runner";
    input.agent.runtimeConfig = { workspaceBinding: { mode: "fixed", cwd: source } };
    await db.update(issues).set({ projectId: null, projectWorkspaceId: null, ...(chat ? {
      conversationAgentId: input.agent.id, conversationUserId: "operator", conversationState: "active" as const,
    } : {}) }).where(eq(issues.id, issue.id));
    input.task.issueRef = { ...input.task.issueRef!, projectId: null, projectWorkspaceId: null };
    input.task.executionProjectId = null;
    input.task.context = { issueId: issue.id };
    const result = await prepareHeartbeatWorkspace(db, input);
    expect(result.executionWorkspace.cwd).toBe(source);
    expect(result.executionWorkspace.worktreePath).toBeNull();
    expect(result.persistedExecutionWorkspace).toBeNull();
  });

  it("admits independent sessions at the same fixed path with separate run leases", async () => {
    const { input, source, issue } = await fixture();
    input.agent.runtimeConfig = { workspaceBinding: { mode: "fixed", cwd: source } };
    const [secondIssue] = await db.insert(issues).values({ companyId: issue.companyId, projectId: issue.projectId,
      projectWorkspaceId: issue.projectWorkspaceId, title: "Parallel task", assigneeAgentId: input.agent.id }).returning();
    const [secondRun] = await db.insert(heartbeatRuns).values({ companyId: issue.companyId, agentId: input.agent.id, issueId: secondIssue.id, scopeKind: "issue", status: "running" }).returning();
    const second: HeartbeatWorkspacePreparationInput = { ...input, run: secondRun, nativeRunnerPreparationSpans: [],
      task: { ...input.task, issueId: secondIssue.id, issueRef: secondIssue, context: { issueId: secondIssue.id } } };
    const results = await Promise.all([prepareHeartbeatWorkspace(db, input), prepareHeartbeatWorkspace(db, second)]);
    expect(results.map(result => result.executionWorkspace.cwd)).toEqual([source, source]);
    const firstLease = (await leases(input.run.id))[0];
    const secondLease = (await leases(secondRun.id))[0];
    expect(firstLease.id).not.toBe(secondLease.id);
    expect(firstLease.heartbeatRunId).toBe(input.run.id);
    expect(secondLease.heartbeatRunId).toBe(secondRun.id);
  });

  it.each(["missing", "project", "isolation", "external", "provision"])("rejects fixed workspace %s conflicts before acquiring a lease", async (kind) => {
    const { input, source, issue } = await fixture();
    input.agent.runtimeConfig = { workspaceBinding: { mode: "fixed", cwd: source } };
    if (kind === "missing") await rm(source, { recursive: true });
    if (kind === "project") input.agent.runtimeConfig.workspaceBinding = { mode: "fixed", cwd: home };
    if (kind === "isolation") input.policy.requestedExecutionWorkspaceMode = "isolated_workspace";
    if (kind === "external") await db.update(issues).set({ originKind: "chat_channel" }).where(eq(issues.id, issue.id));
    if (kind === "provision") input.config.mergedConfig = { workspaceStrategy: { provisionCommand: "touch should-not-run" } };
    await expect(prepareHeartbeatWorkspace(db, input)).rejects.toMatchObject({ code: "workspace_validation_failed" });
    expect(await leases(input.run.id)).toEqual([]);
  });

  it("preserves an incompatible old workspace instead of rewriting its binding", async () => {
    const { input, source } = await fixture(true);
    const old = await prepareHeartbeatWorkspace(db, input);
    await reuse(input, old.persistedExecutionWorkspace!);
    input.policy.requestedExecutionWorkspaceMode = "shared_workspace";
    input.config.mergedConfig = {};
    input.agent.runtimeConfig = { workspaceBinding: { mode: "fixed", cwd: source } };
    const next = await prepareHeartbeatWorkspace(db, input);
    expect(next.executionWorkspace.cwd).toBe(source);
    expect(next.persistedExecutionWorkspace?.id).not.toBe(old.persistedExecutionWorkspace?.id);
    const retained = await executionWorkspaceService(db).getById(old.persistedExecutionWorkspace!.id);
    expect(retained?.cwd).toBe(old.executionWorkspace.cwd);
    await expect(access(old.executionWorkspace.cwd)).resolves.toBeUndefined();
  });

  it("creates a real isolated worktree and reuses its recorded workspace", async () => {
    const { input, source, issue } = await fixture(true);
    const first = await prepareHeartbeatWorkspace(db, input);
    expect(first.executionWorkspace.cwd).not.toBe(source);
    expect(await readFile(join(first.executionWorkspace.cwd, "README.md"), "utf8")).toBe("source content\n");
    expect(await readIssue(issue.id)).toMatchObject({ executionWorkspaceId: first.persistedExecutionWorkspace!.id, executionWorkspacePreference: "reuse_existing" });
    await writeFile(join(first.executionWorkspace.cwd, "retained.txt"), "keep this work");
    await reuse(input, first.persistedExecutionWorkspace!);
    const next = await prepareHeartbeatWorkspace(db, input);
    expect(next.reusedExecutionWorkspace).toMatchObject({ cwd: first.executionWorkspace.cwd });
    expect(next.persistedExecutionWorkspace!.id).toBe(first.persistedExecutionWorkspace!.id);
    expect(await readFile(join(next.executionWorkspace.cwd, "retained.txt"), "utf8")).toBe("keep this work");
  });

  it("keeps the admitted recovery workspace when the issue now points elsewhere", async () => {
    const { input, issue } = await fixture(true);
    const first = await prepareHeartbeatWorkspace(db, input);
    await reuse(input, first.persistedExecutionWorkspace!);
    await db.update(issues).set({ executionWorkspaceId: null, projectWorkspaceId: null }).where(eq(issues.id, issue.id));
    input.task.issueRef = { ...input.task.issueRef!, executionWorkspaceId: null, projectWorkspaceId: null };
    input.reuse.nativeRecoveryExecutionWorkspaceId = first.persistedExecutionWorkspace!.id;
    const anchor = vi.spyOn(input.services, "resolveReusedGitWorkspaceAnchor");
    const next = await prepareHeartbeatWorkspace(db, input);
    expect(next.persistedExecutionWorkspace!.id).toBe(first.persistedExecutionWorkspace!.id);
    expect(anchor).toHaveBeenCalledWith(expect.objectContaining({ immutableNativeBinding: true, explicitProjectWorkspaceId: first.persistedExecutionWorkspace!.projectWorkspaceId }));
    expect(await readIssue(issue.id)).toMatchObject({ executionWorkspaceId: null, projectWorkspaceId: null });
  });

  it("removes a newly created worktree when persistence fails and preserves the original error", async () => {
    const { input, source } = await fixture(true);
    const error = new Error("workspace persistence unavailable");
    let createdCwd = "";
    vi.spyOn(input.services.executionWorkspacesSvc, "create").mockImplementation(async args => { createdCwd = args.cwd!; throw error; });
    await expect(prepareHeartbeatWorkspace(db, input)).rejects.toBe(error);
    expect(createdCwd).not.toBe("");
    await expect(access(createdCwd)).rejects.toThrow();
    expect(await readFile(join(source, "README.md"), "utf8")).toBe("source content\n");
    expect(await leases(input.run.id)).toHaveLength(0);
  });

  it("preserves a reused worktree when its metadata update fails", async () => {
    const { input } = await fixture(true);
    const first = await prepareHeartbeatWorkspace(db, input);
    await reuse(input, first.persistedExecutionWorkspace!);
    await writeFile(join(first.executionWorkspace.cwd, "retained.txt"), "unsaved work");
    const error = new Error("workspace update unavailable");
    vi.spyOn(input.services.executionWorkspacesSvc, "update").mockRejectedValueOnce(error);
    await expect(prepareHeartbeatWorkspace(db, input)).rejects.toBe(error);
    expect(await readFile(join(first.executionWorkspace.cwd, "retained.txt"), "utf8")).toBe("unsaved work");
    expect(await leases(input.run.id)).toHaveLength(0);
  });

  it.each(["acquire", "realize", "ownership"] as const)("preserves %s errors and durable lease state for outer cleanup", async failure => {
    const { input, envOrchestrator } = await fixture();
    const error = new Error(`${failure} failed`);
    if (failure === "acquire") vi.spyOn(envOrchestrator, "acquireForRun").mockRejectedValueOnce(error);
    if (failure === "realize") vi.spyOn(envOrchestrator, "realizeForRun").mockRejectedValueOnce(error);
    if (failure === "ownership") vi.mocked(input.controllerLease.assertOwned).mockResolvedValueOnce(undefined).mockRejectedValueOnce(error);
    await expect(prepareHeartbeatWorkspace(db, input)).rejects.toBe(error);
    expect(input.nativeRunnerPreparationSpans.at(-1)).toMatchObject({ name: failure === "realize" ? "environment.workspace.realize" : "environment.acquire", outcome: "failed" });
    expect((await readRun(input.run.id)).status).toBe("running");
    expect(await leases(input.run.id)).toHaveLength(failure === "acquire" ? 0 : 1);
    if (failure !== "acquire") {
      expect(await leases(input.run.id)).toMatchObject([{ status: "active" }]);
      // The production executor terminalizes first, then releases by durable run ID.
      await db.update(heartbeatRuns).set({ status: "failed" }).where(eq(heartbeatRuns.id, input.run.id));
      await envOrchestrator.releaseForRun({ heartbeatRunId: input.run.id, companyId: input.run.companyId, agentId: input.agent.id, status: "released" });
      expect(await leases(input.run.id)).toMatchObject([{ status: "released" }]);
    }
  });

  it("checks the acquired environment allowlist before realization", async () => {
    const { input, envOrchestrator } = await fixture();
    input.policy.executionPolicy = { managedSandboxOnly: true };
    const realize = vi.spyOn(envOrchestrator, "realizeForRun");
    await expect(prepareHeartbeatWorkspace(db, input)).rejects.toThrow("forbids local execution");
    expect(realize).not.toHaveBeenCalled();
    expect(await leases(input.run.id)).toMatchObject([{ status: "active" }]);
  });

  it("rejects low-trust local execution before resolving or provisioning a workspace", async () => {
    const { input } = await fixture(true);
    input.policy.trustPreset = {
      kind: "low_trust_review", preset: "low_trust_review", sourcePresets: {},
      boundary: { mode: "low_trust_review", companyId: input.agent.companyId, rootIssueId: input.task.issueId! },
    };
    const resolve = vi.spyOn(input.services, "resolveWorkspaceForRun");
    const create = vi.spyOn(input.services.executionWorkspacesSvc, "create");
    await expect(prepareHeartbeatWorkspace(db, input)).rejects.toThrow("requires a sandbox environment");
    expect(resolve).not.toHaveBeenCalled();
    expect(create).not.toHaveBeenCalled();
    expect(await leases(input.run.id)).toHaveLength(0);
  });

  it("rejects remote recovery without its retained sync binding before acquiring a lease", async () => {
    const { input, envOrchestrator } = await fixture();
    input.reuse.runOptions.nativeRestartRecovery = {
      kind: "reattach_remote_runner", runId: input.run.id, leaseOwner: "controller",
      controllerGeneration: 1, providerAttempt: 1, restartKind: "hard", recoveryRequestId: null,
      remote: { providerLeaseId: "original-provider-lease", remoteCwd: "/original" },
    };
    const acquire = vi.spyOn(envOrchestrator, "acquireForRun");
    await expect(prepareHeartbeatWorkspace(db, input)).rejects.toThrow("native_remote_recovery_lease_mismatch");
    expect(acquire).not.toHaveBeenCalled();
    expect(await leases(input.run.id)).toHaveLength(0);
    expect(input.nativeRunnerPreparationSpans).toMatchObject([{ name: "environment.acquire", outcome: "failed" }]);
  });

  it("binds a replacement workspace from realization and snapshots the restore lease", async () => {
    const { input, envOrchestrator, issue } = await fixture();
    const realize = envOrchestrator.realizeForRun;
    vi.spyOn(envOrchestrator, "realizeForRun").mockImplementation(async args => {
      const result = await realize(args);
      const workspace = await input.services.executionWorkspacesSvc.create({ companyId: issue.companyId, projectId: issue.projectId!, projectWorkspaceId: issue.projectWorkspaceId, sourceIssueId: issue.id, name: "Realized workspace", mode: "shared_workspace", strategyType: "project_primary", cwd: args.executionWorkspace.cwd });
      return { ...result, persistedExecutionWorkspace: workspace, lease: { ...result.lease, metadata: { remoteCwd: "/original" } } };
    });
    const result = await prepareHeartbeatWorkspace(db, input);
    expect((await readIssue(issue.id)).executionWorkspaceId).toBe(result.persistedExecutionWorkspace!.id);
    expect(result.persistedExecutionWorkspace!.name).toBe("Realized workspace");
    result.activeEnvironmentLease.lease.metadata!.remoteCwd = "/rebound";
    expect(result.workspaceRestoreSource.metadata?.remoteCwd).toBe("/original");
  });
});
