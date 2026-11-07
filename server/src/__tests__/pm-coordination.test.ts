import { renderPmWorkerPolicy, type PmWorkerPolicy } from "@paperclipai/shared";
import { workerSelectionOverrides } from "../services/pm-worker-options.js";
import { beforeAll, afterAll, describe, expect, it, vi } from "vitest";
import express from "express";
import { execFileSync } from "node:child_process";
import { projectSessionRecords } from "../services/project-execution-records.js";
import { createServer, type Server } from "node:http";
import { randomUUID, createHash } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { and, eq } from "drizzle-orm";
import { assets, runnerApiResponseReservations, agents, agentWakeupRequests, companies, projects, projectWorkspaces, issues, heartbeatRuns, authUsers, companyMemberships, activityLog, principalPermissionGrants, completionContracts, issueThreadInteractions, toolGatewaySessions, createDb } from "@paperclipai/db";
import { startRecoveryPostgres } from "./helpers/recovery-postgres.js";
import { resolveManagedInstructionsRoot, agentInstructionsService } from "../services/agent-instructions.js";
import { agentInstructionWorkingCopyService } from "../services/agent-instruction-working-copies.js";
import { buildNativeRuntimeContext } from "../services/native-runtime/runtime-context.js";
import { PaperclipRunnerToolAuthority } from "../services/native-runtime/paperclip-runner-tool-authority.js";
import { PM_BUNDLE_FILES, pmCoordinationScope } from "../services/pm-coordination-policy.js";
import { readPmBundleFile, writePmBundleFile } from "../services/pm-bundle-tools.js";
import { assertPmApiRequest, pmCoordinationMiddleware } from "../middleware/pm-coordination.js";
import { verifyLocalAgentJwt } from "../agent-auth-jwt.js";
import { issueRoutes } from "../routes/issues.js";
import { errorHandler } from "../middleware/error-handler.js";
import type { StorageService } from "../storage/types.js";
import { PaperclipControlPlanePort } from "../services/native-runtime/paperclip-control-plane-port.js";
import { finalizeNativeRun } from "../services/native-runtime/native-run-finalizer.js";
import { nativeCompletionFeedback } from "../services/native-runtime/native-completion-feedback.js";
import { claimNativeReviewExecutionLock } from "../services/native-runtime/native-review-participant.js";
import { CONTROL_PLANE_CONFORMANCE_RESULT, CONTROL_PLANE_CONFORMANCE_TERMINAL } from "../vendor/paperclip-runner/testing.js";
import { documentService } from "../services/documents.js";
import { agentFileStore, snapshotAgentFiles } from "../services/agent-file-store.js";
import { createToolGatewayService } from "../services/tool-gateway.js";
import { saveDecisionDelegation } from "../services/delegated-decision-policy.js";
import { issueThreadInteractionService } from "../services/issue-thread-interactions.js";
import { questionResponseDeliveryService } from "../services/question-response-delivery.js";
import { executePmProjectRead } from "../services/pm-project-read-tools.js";

describe.each(["claude_local", "codex_local"] as const)("%s PM capabilities on owned storage and database", (pmHarness) => {
  let database: Awaited<ReturnType<typeof startRecoveryPostgres>>, db: ReturnType<typeof createDb>, home: string;
  const previousHome = process.env.PAPERCLIP_HOME;
  const companyId = randomUUID(), projectId = randomUUID(), otherProjectId = randomUUID(), agentId = randomUUID(), workerId = randomUUID(), userId = randomUUID();
  const issueId = randomUUID(), otherIssueId = randomUUID(), runId = randomUUID();
  let root: string, localRoot: string, authority: PaperclipRunnerToolAuthority, scope: NonNullable<ReturnType<typeof pmCoordinationScope>>;
  let server: Server, apiUrl: string;
  const wakes: Array<{agentId: string; key: string | undefined}> = [];
  const selectionId = randomUUID(), sourceId = randomUUID();
  const workspaceSelection = { kind: "configured_source", projectWorkspaceId: sourceId, mode: "managed_isolated" } as const;
  const selection = { id: selectionId, model: "gpt-5.4", thinking: "high", permission: "approve-reads" as const, speed: "standard" as const };
  const policy: PmWorkerPolicy = { version: 2, defaultSelectionId: selectionId, workers: [{ agentId: workerId, harness: "codex_local", selections: [selection] }] };
  const override = { workerSelectionId: selectionId, adapterConfig: workerSelectionOverrides("codex_local", selection) };
  const execute = (tool: string, args: unknown, callId = randomUUID()) => authority.execute({ tool, arguments: args, callId });
  beforeAll(async () => {
    vi.stubEnv("PAPERCLIP_AGENT_JWT_SECRET", "owned-pm-capabilities-test-key");
    vi.stubEnv("PAPERCLIP_IN_WORKTREE", "1"); // Real queue writes, no provider dispatch from HTTP handlers.
    home = await fs.mkdtemp(path.join(os.tmpdir(), "pm-capabilities-")); process.env.PAPERCLIP_HOME = home;
    database = await startRecoveryPostgres("pm-capabilities-db-"); db = createDb(database.connectionString);
    await db.insert(companies).values({ id: companyId, name: "PM isolation", issuePrefix: "PMC", issueCounter: 2 });
    await db.insert(projects).values([{ id: projectId, companyId, name: "PM project" }, { id: otherProjectId, companyId, name: "Other project" }]);
    const repo = path.join(home, "source"); await fs.mkdir(repo);
    execFileSync("git", ["init", repo], { stdio: "ignore" });
    execFileSync("git", ["-C", repo, "-c", "user.name=Fixture", "-c", "user.email=fixture@example.test", "commit", "--allow-empty", "-m", "Fixture"], { stdio: "ignore" });
    await db.insert(projectWorkspaces).values({ id: sourceId, companyId, projectId, name: "Owned Git source", cwd: repo, isPrimary: true });
    await db.insert(authUsers).values({ id: userId, name: "Owner", email: `${userId}@example.test`, createdAt: new Date(), updatedAt: new Date() });
    root = resolveManagedInstructionsRoot({ id: agentId, companyId, name: "PM", adapterConfig: {} });
    const runtimeConfig = { workspaceBinding: { mode: "project_pm", projectId, workerRoot: home, workerSlots: 0, workerIsolation: "shared" },
      pmDelegation: policy };
    await db.insert(agents).values([
      { id: agentId, companyId, name: "PM", status: "active", adapterType: pmHarness, runtimeConfig,
        adapterConfig: { instructionsBundleMode: "managed", instructionsRootPath: root, instructionsEntryFile: "AGENTS.md" } },
      { id: workerId, companyId, name: "Shared worker", status: "active", adapterType: "codex_local", runtimeConfig: { requireTaskWorktree: true } },
    ]);
    await db.insert(companyMemberships).values([{ companyId, principalType: "user", principalId: userId, membershipRole: "operator" },
      { companyId, principalType: "agent", principalId: agentId, membershipRole: "member" }]);
    await db.insert(principalPermissionGrants).values({ companyId, principalType: "user", principalId: userId, permissionKey: "agents:configure", scope: { agentIds: [agentId] } });
    await db.insert(issues).values([
      { id: issueId, companyId, projectId, issueNumber: 1, identifier: "PMC-1", title: "Coordinate", status: "in_progress", workMode: "standard", assigneeAgentId: agentId,
        executionPolicy: { mode: "normal", stages: [{ type: "approval", approvalsNeeded: 1, participants: [{ type: "user", userId }] }] } },
      { id: otherIssueId, companyId, projectId: otherProjectId, issueNumber: 2, identifier: "PMC-2", title: "Unrelated", status: "todo" },
    ]);
    await db.insert(heartbeatRuns).values({ id: runId, companyId, agentId, status: "running", runtimeMode: "native", nativeIssueId: issueId,
      responsibleUserId: userId, invocationSource: "assignment", contextSnapshot: { issueId } });
    await db.update(issues).set({ executionRunId: runId }).where(eq(issues.id, issueId));
    for (const file of PM_BUNDLE_FILES) { await fs.mkdir(path.dirname(path.join(root, file)), { recursive: true }); await fs.writeFile(path.join(root, file), `# ${file}\nOwner baseline\n`); }
    await fs.appendFile(path.join(root, "WORKERS.md"), renderPmWorkerPolicy(policy));
    const copy = (await agentInstructionWorkingCopyService(db).prepare({ companyId, agentId, runId, cwd: home }))!;
    localRoot = copy.localRoot;
    const [agent] = await db.select().from(agents).where(eq(agents.id, agentId)); scope = pmCoordinationScope(agent!)!;
    const runtimeContext = await buildNativeRuntimeContext({ db, agent: agent!, runId, runtimeConfig: {}, runtimeSkillEntries: [],
      instructionWorkingCopy: { rootPath: localRoot, entryPath: "AGENTS.md", kind: "agent_files" } });
    authority = new PaperclipRunnerToolAuthority(db, { companyId, agentId, runId, issueId, workMode: "standard", runtimeContext,
      enqueueWakeup: async (id, options) => { wakes.push({agentId: id, key: options.idempotencyKey}); return null; } });
    const app = express(); app.use(express.json());
    app.use((req, res, next) => {
      const claims = verifyLocalAgentJwt(req.headers.authorization?.replace(/^Bearer /, "") ?? "");
      if (!claims) { res.status(401).end(); return; }
      req.actor = { type: "agent", source: "agent_jwt", agentId: claims.sub, companyId: claims.company_id,
        runId: claims.run_id, keyScope: claims.key_scope ?? undefined, onBehalfOfUserId: claims.responsible_user_id,
        onBehalfOfMemberships: [{ companyId, status: "active", membershipRole: "operator" }] };
      next();
    });
    app.use("/api", pmCoordinationMiddleware(db)); app.use("/api", issueRoutes(db, {} as StorageService)); app.use(errorHandler);
    server = createServer(app); await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
    apiUrl = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  }, 90_000);
  afterAll(async () => {
    if (server) { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); }
    authority?.close(); await db?.$client.end({ timeout: 1 }); await database?.cleanup();
    vi.unstubAllEnvs();
    if (previousHome === undefined) delete process.env.PAPERCLIP_HOME; else process.env.PAPERCLIP_HOME = previousHome;
    if (home) {
      const unlock = async (directory: string): Promise<void> => {
        await fs.chmod(directory, 0o700);
        for (const entry of await fs.readdir(directory, { withFileTypes: true })) if (entry.isDirectory()) await unlock(path.join(directory, entry.name));
      };
      await unlock(home); await fs.rm(home, { recursive: true, force: true });
    }
  });
  const reads = async () => { for (const file of PM_BUNDLE_FILES) await readPmBundleFile(db, scope, runId, { path: file }); };
  it("reads and searches project files while rejecting symlink escape and binaries", async () => {
    await fs.writeFile(path.join(home, "project-evidence.txt"), "first\nacceptance evidence\nlast\n");
    await fs.writeFile(path.join(home, "binary-evidence"), Buffer.from([1, 0, 2]));
    await fs.symlink("/etc/passwd", path.join(home, "escape-link"));
    expect(await executePmProjectRead(db, scope, runId, "read_project_file", { path: "project-evidence.txt", startLine: 2, maxLines: 1 }))
      .toMatchObject({ content: "acceptance evidence" });
    expect(await executePmProjectRead(db, scope, runId, "search_project_files", { path: "project-evidence.txt", text: "acceptance" }))
      .toMatchObject({ results: [{ path: "project-evidence.txt", line: 2, text: "acceptance evidence" }] });
    await expect(executePmProjectRead(db, scope, runId, "read_project_file", { path: "escape-link" })).rejects.toThrow("outside");
    await expect(executePmProjectRead(db, scope, runId, "read_project_file", { path: "binary-evidence" })).rejects.toThrow("Binary");
    await fs.unlink(path.join(home, "escape-link"));
  });
  it("rejects guessed execution tools, cross-project reads and generic API escalation", async () => {
    const [agent] = await db.select().from(agents).where(eq(agents.id, agentId));
    await expect(buildNativeRuntimeContext({ db, agent: agent!, runId, runtimeConfig: {}, runtimeSkillEntries: [] }))
      .rejects.toThrow("registered agent-directory working copy");
    await expect(buildNativeRuntimeContext({ db, agent: agent!, runId, runtimeConfig: { homeMode: "preconfigured" }, runtimeSkillEntries: [] }))
      .rejects.toThrow("isolated native runtime");
    const names = authority.definitions().map(tool => tool.name);
    expect(names).toContain("read_bundle_file"); expect(names).toContain("write_bundle_file"); expect(names).toContain("request_approval");
    for (const tool of ["workspace_write", "workspace_run", "hire_agent", "decide_approval", "fake_connector_write"]) {
      expect(names).not.toContain(tool); await expect(execute(tool, {})).rejects.toThrow();
    }
    await expect(execute("get_task", { taskId: otherIssueId })).rejects.toThrow("outside");
    for (const [method, target] of [["PATCH", `/agents/${agentId}`], ["PUT", `/agents/${workerId}/instructions-bundle/file`], ["POST", "/approvals/anything/approve"], ["GET", `/issues/${otherIssueId}`], ["GET", `/companies/${companyId}/issues`]]) {
      await expect(assertPmApiRequest(db, scope, { method: method!, path: target!, query: {}, body: {}, runId })).rejects.toThrow();
    }
  });
  it("reads only captured API assets from this PM and this task", async () => {
    const ownAsset = randomUUID(), foreignAsset = randomUUID(), workerAsset = randomUUID(), uncapturedAsset = randomUUID(), otherRun = randomUUID(), workerRun = randomUUID();
    await db.insert(assets).values([ownAsset, foreignAsset, workerAsset, uncapturedAsset].map(id => ({ id, companyId, provider: "local_disk", objectKey: id, contentType: "application/json", byteSize: 2, sha256: "a".repeat(64), createdByAgentId: agentId })));
    await db.insert(heartbeatRuns).values({ id: otherRun, companyId, agentId, nativeIssueId: otherIssueId, status: "succeeded", runtimeMode: "native" });
    await db.insert(heartbeatRuns).values({ id: workerRun, companyId, agentId: workerId, nativeIssueId: issueId, status: "succeeded", runtimeMode: "native" });
    await db.insert(runnerApiResponseReservations).values([{ companyId, runId, assetId: ownAsset, reservedBytes: 2 }, { companyId, runId: otherRun, assetId: foreignAsset, reservedBytes: 2 }, { companyId, runId: workerRun, assetId: workerAsset, reservedBytes: 2 }]);
    const request = (asset: string) => ({ method: "GET", path: `/assets/${asset}/content`, query: {}, body: {}, runId });
    await expect(assertPmApiRequest(db, scope, request(ownAsset))).resolves.toBeUndefined();
    for (const denied of [foreignAsset, workerAsset, uncapturedAsset, "not-a-uuid"]) {
      await expect(assertPmApiRequest(db, scope, request(denied))).rejects.toThrow("outside the PM");
    }
    await expect(assertPmApiRequest(db, scope, request(randomUUID()))).rejects.toThrow("outside the PM");
    await expect(assertPmApiRequest(db, scope, { ...request(ownAsset), method: "DELETE" })).rejects.toThrow("outside the PM");
  });
  it("requires read receipts before dispatch, preserves Owner gates, and wakes only the explicit worker once", async () => {
    const args = { idempotencyKey: "dispatch", title: "Bounded worker task", initialPlan: "Inspect, implement, verify, deliver evidence.",
      assigneeActorId: workerId, assigneeAdapterOverrides: override, workspaceSelection };
    await expect(execute("create_task", args)).rejects.toThrow("Read the current bundle");
    await reads();
    for (const selection of [undefined, { kind: "task_directory" }, { kind: "existing", workspaceId: randomUUID() }, { ...workspaceSelection, mode: "shared" }]) {
      await expect(execute("create_task", { ...args, workspaceSelection: selection })).rejects.toMatchObject({
        details: { code: "PM_ISOLATED_WORKSPACE_REQUIRED" }, paperclipPublicToolError: expect.stringContaining("PM_ISOLATED_WORKSPACE_REQUIRED"),
      });
    }
    await expect(execute("create_task", { ...args, executionWorkspaceSettings: { mode: "shared_workspace" } })).rejects.toThrow("managed_isolated");
    await expect(assertPmApiRequest(db, scope, { method: "POST", path: `/companies/${companyId}/issues`, query: {}, runId,
      body: { title: args.title, initialPlan: args.initialPlan, projectId, parentId: issueId, assigneeAgentId: workerId, workspaceSelection: { kind: "task_directory" } } })).rejects.toThrow("managed_isolated");
    expect(await db.select({ id: issues.id }).from(issues).where(eq(issues.parentId, issueId))).toHaveLength(0);
    expect(wakes).toHaveLength(0);
    await expect(execute("create_task", { ...args, assigneeActorId: agentId })).rejects.toThrow("shared worker");
    const otherWorkspaceId = randomUUID();
    await db.insert(projectWorkspaces).values({ id: otherWorkspaceId, companyId, projectId: otherProjectId, name: "Other source", cwd: home });
    await expect(execute("create_task", { ...args, workspaceSelection: { kind: "configured_source", projectWorkspaceId: otherWorkspaceId, mode: "managed_isolated" } })).rejects.toThrow("outside");
    await expect(execute("create_task", { ...args, executionPolicy: { authorizationPolicy: {} } })).rejects.toThrow();
    const defaultArgs = { idempotencyKey: args.idempotencyKey, title: args.title, initialPlan: args.initialPlan, workspaceSelection: args.workspaceSelection };
    const created = await execute("create_task", defaultArgs) as { task: { id: string } };
    expect(created).toMatchObject({ task: { parentId: issueId, assigneeActorId: workerId } });
    const [task] = await db.select().from(issues).where(eq(issues.id, created.task.id));
    expect(task?.assigneeAdapterOverrides).toEqual(override);
    expect(task?.executionPolicy?.stages).toEqual(expect.arrayContaining([
      expect.objectContaining({ type: "approval", participants: [expect.objectContaining({ type: "user", userId })] }),
      expect.objectContaining({ type: "review", participants: [expect.objectContaining({ type: "agent", agentId })] }),
    ]));
    await execute("create_task", defaultArgs);
    expect(wakes.every(wake => wake.agentId === workerId)).toBe(true);
    expect(new Set(wakes.map(wake => wake.key))).toEqual(new Set([`created-child:${created.task.id}`]));
    expect(await db.select({ id: issues.id }).from(issues).where(eq(issues.parentId, issueId))).toHaveLength(1);
  });
  it("reports current dispatch metadata without exposing worker configuration", async () => {
    const listed = await execute("list_agents", {}) as any;
    expect(listed.dispatchReadiness).toMatchObject({ version: 2, defaultSelectionId: selectionId, documentSynchronized: true, blockers: [],
      selections: [{ id: selectionId, agentId: workerId, ready: true }] });
    expect(listed.actors.find((a: any) => a.id === workerId)).not.toHaveProperty("adapterConfig");
    const original = await fs.readFile(path.join(root, "WORKERS.md"), "utf8");
    await fs.writeFile(path.join(root, "WORKERS.md"), "# out of sync");
    try { expect((await execute("list_agents", {}) as any).dispatchReadiness).toMatchObject({ documentSynchronized: false, blockers: ["PM_WORKER_DOCUMENT_OUT_OF_SYNC"] }); }
    finally { await fs.writeFile(path.join(root, "WORKERS.md"), original); }
    const [saved] = await db.select().from(agents).where(eq(agents.id, agentId));
    await db.update(agents).set({ runtimeConfig: { ...saved!.runtimeConfig, pmDelegation: { version: 1, workers: [{ agentId: workerId, selections: [{ model: "old", effort: "high" }] }] } } }).where(eq(agents.id, agentId));
    try { expect((await execute("list_agents", {}) as any).dispatchReadiness).toMatchObject({ version: 1, blockers: ["PM_WORKER_MIGRATION_REQUIRED"] }); }
    finally { await db.update(agents).set({ runtimeConfig: saved!.runtimeConfig }).where(eq(agents.id, agentId)); }
  });
  it("allows only own-project session diagnostics and projects no raw failure payload", async () => {
    await expect(assertPmApiRequest(db, scope, { method: "GET", path: `/projects/${projectId}/sessions`, query: {}, body: {}, runId })).resolves.toBeUndefined();
    await expect(assertPmApiRequest(db, scope, { method: "GET", path: `/projects/${otherProjectId}/sessions`, query: {}, body: {}, runId })).rejects.toThrow();
    await expect(assertPmApiRequest(db, scope, { method: "GET", path: `/agents/${workerId}/config`, query: {}, body: {}, runId })).rejects.toThrow();
    const failedId = randomUUID();
    await db.insert(heartbeatRuns).values({ id: failedId, companyId, agentId: workerId, status: "failed", issueId,
      errorCode: "workspace_validation_failed", error: "secret fixture must not escape", contextSnapshot: { issueId },
      resultJson: { secret: "private", executionRecovery: { kind: "bootstrap", providerWorkStarted: false } } });
    const records = await projectSessionRecords(db, companyId, projectId, { type: "board", source: "session", userId });
    const record = records.records.find(row => row.runId === failedId)!;
    expect(record.diagnostics).toMatchObject({ failureCategory: "workspace", providerWorkStarted: false, processStop: "not_started" });
    expect(JSON.stringify(record)).not.toContain("secret");
    expect(record).not.toHaveProperty("resultJson");
    await db.delete(heartbeatRuns).where(eq(heartbeatRuns.id, failedId));
  });
  it("rejects discovery and execution through a previously issued connector session", async () => {
    const token = `owned-pm-test-${randomUUID()}`;
    await db.insert(toolGatewaySessions).values({ companyId, agentId, runId, issueId, projectId,
      tokenHash: createHash("sha256").update(token).digest("hex"), expiresAt: new Date(Date.now() + 60_000) });
    const gateway = createToolGatewayService(db);
    await expect(gateway.listToolsForSession(token)).rejects.toMatchObject({ status: 403, reasonCode: "pm_connector_denied" });
    await expect(gateway.executeTool({ sessionToken: token, tool: "guessed_connector_write", parameters: {} })).rejects.toMatchObject({ status: 403, reasonCode: "pm_connector_denied" });
  });
  it("saves only own support files with CAS, a reason and a synchronized working baseline", async () => {
    await reads(); const before = await readPmBundleFile(db, scope, runId, { path: "memory/decisions.md" });
    await expect(writePmBundleFile(db, scope, runId, { path: "AGENTS.md", content: "expanded role", baseHash: before.contentHash, changeReason: "expand" })).rejects.toThrow("Owner-managed");
    const changed = "# Decisions\nUse bounded reviews; source: owned test.\n";
    expect(await writePmBundleFile(db, scope, runId, { path: "memory/decisions.md", content: changed, baseHash: before.contentHash, changeReason: "Record verified workflow" }))
      .toMatchObject({ saved: true, workingCopySynchronized: true });
    expect(await fs.readFile(path.join(localRoot, "memory/decisions.md"), "utf8")).toBe(changed);
    const [agent] = await db.select().from(agents).where(eq(agents.id, agentId));
    expect((await agentInstructionsService().readFile(agent!, "memory/decisions.md")).content).toBe(changed);
    await expect(writePmBundleFile(db, scope, runId, { path: "memory/decisions.md", content: changed, baseHash: before.contentHash, changeReason: "stale save" })).rejects.toThrow("changed since");
    const logs = await db.select().from(activityLog).where(and(eq(activityLog.runId, runId), eq(activityLog.action, "agent.files_updated")));
    expect(logs.some(row => row.details?.changeReason === "Record verified workflow")).toBe(true);
  });

  it("dispatches an independent chat task, returns worker delivery, then accepts the corrected delivery through HTTP", async () => {
    const delegateId = randomUUID(), delegateRunId = randomUUID(), delegatingOwnerId = randomUUID();
    await db.insert(authUsers).values({ id: delegatingOwnerId, name: "Delegating Owner", email: `${delegatingOwnerId}@example.test`, createdAt: new Date(), updatedAt: new Date() });
    await db.insert(companyMemberships).values({ companyId, principalType: "user", principalId: delegatingOwnerId, membershipRole: "owner" });
    await db.insert(agents).values({ id: delegateId, companyId, name: "Decision delegate", adapterType: "process" });
    await db.insert(heartbeatRuns).values({ id: delegateRunId, companyId, agentId: delegateId, status: "running" });
    await saveDecisionDelegation(db, { companyId, ownerUserId: delegatingOwnerId, agentId: delegateId,
      baseRevision: null, enabled: true, allowSelfApproval: true, scopes: ["task_decisions"] });
    await db.update(issues).set({ conversationAgentId: agentId, conversationUserId: userId, conversationState: "active", executionPolicy: null }).where(eq(issues.id, issueId));
    await reads();
    const created = await execute("create_task", { idempotencyKey: "chat-flow", title: "Independent chat work", initialPlan: "Deliver, address review, deliver again.",
      assigneeActorId: workerId, assigneeAdapterOverrides: override, workspaceSelection }) as { task: { id: string; parentId: string | null } };
    expect(created.task.parentId).toBeNull();
    const childId = created.task.id, contractId = randomUUID();
    await db.insert(completionContracts).values({ id: contractId, companyId, issueId: childId, revision: 1,
      schemaVersion: "paperclip.completion-contract.v1", policyVersion: "standalone-v1", risk: "standard",
      completionAuthority: "server_arbiter", incompleteCriteriaPolicy: "preserve_non_terminal",
      contractJson: { revision: "standalone-v1", objective: "Deliver evidence", criteria: [{ id: "objective", requirement: "Deliver evidence" }] },
      canonicalSha256: "owned-review-contract", createdByActorType: "system", createdByActorId: "test" });
    let deliveryRevision: string | null = null;
    for (const decision of ["reject", "accept"] as const) {
      const workerRunId = randomUUID(), sessionId = randomUUID(), instanceId = randomUUID();
      await db.update(issues).set({ status: "in_progress", executionRunId: null }).where(eq(issues.id, childId));
      await db.insert(heartbeatRuns).values({ id: workerRunId, companyId, agentId: workerId, nativeIssueId: childId,
        status: "running", runtimeMode: "native", nativeSessionId: sessionId, runnerInstanceId: instanceId,
        completionContractId: contractId, completionContractSha256: "owned-review-contract", contextSnapshot: { issueId: childId } });
      const delivery = await documentService(db).upsertIssueDocument({ issueId: childId, key: "delivery", title: "Worker evidence", format: "markdown",
        body: decision === "reject" ? "Initial evidence: missing acceptance case." : "Corrected evidence: acceptance case covered.",
        baseRevisionId: deliveryRevision, createdByAgentId: workerId, createdByRunId: workerRunId });
      deliveryRevision = delivery.document.latestRevisionId;
      const port = new PaperclipControlPlanePort(db, { companyId, issueId: childId, runId: workerRunId, agentId: workerId, sessionId,
        completionContractId: contractId, completionContractSha256: "owned-review-contract", sourceInstanceId: instanceId, controlPlaneSourceInstanceId: "owned-pm-flow" });
      await port.openRun({ identity: { companyId, issueId: childId, runId: workerRunId, agentId: workerId, sessionId }, backendKind: "mock", sourceInstanceId: instanceId });
      const result = { ...structuredClone(CONTROL_PLANE_CONFORMANCE_RESULT), reportedWorkDisposition: "needs_review" as const,
        summary: "Worker delivery is saved in the delivery document.",
        attentionRequests: [{ kind: "review" as const, ownerClass: "agent" as const, targetAgentId: agentId, summary: "Review the saved delivery." }] };
      await nativeCompletionFeedback(db, workerRunId, result);
      await port.completeRun({ result, terminal: { ...CONTROL_PLANE_CONFORMANCE_TERMINAL, reportedWorkDisposition: "needs_review" }, callerResultId: `${decision}-delivery` });
      await finalizeNativeRun({ db, runId: workerRunId, workspaceFinalizeStatus: "succeeded" });
      const [interaction] = await db.select().from(issueThreadInteractions).where(and(eq(issueThreadInteractions.sourceRunId, workerRunId), eq(issueThreadInteractions.addresseeAgentId, agentId)));
      expect(interaction).toMatchObject({ status: "pending" });
      const reviewRunId = randomUUID(), nativeReview = { nativeReviewInteractionId: interaction!.id,
        nativeReviewDecisionId: (interaction!.payload as { target: { revisionId: string } }).target.revisionId };
      await db.insert(heartbeatRuns).values({ id: reviewRunId, companyId, agentId, status: "running", runtimeMode: "native", nativeIssueId: childId,
        responsibleUserId: userId, contextSnapshot: { issueId: childId, ...nativeReview } });
      expect(await claimNativeReviewExecutionLock(db, { companyId, issueId: childId, agentId, runId: reviewRunId,
        contextSnapshot: nativeReview, agentNameKey: "pm", claimedAt: new Date() })).toBe(true);
      const copy = (await agentInstructionWorkingCopyService(db).prepare({ companyId, agentId, runId: reviewRunId, cwd: home }))!;
      const [agent] = await db.select().from(agents).where(eq(agents.id, agentId));
      const runtimeContext = await buildNativeRuntimeContext({ db, agent: agent!, runId: reviewRunId, runtimeConfig: {}, runtimeSkillEntries: [],
        instructionWorkingCopy: { rootPath: copy.localRoot, entryPath: "AGENTS.md", kind: "agent_files" } });
      const review = new PaperclipRunnerToolAuthority(db, { companyId, agentId, runId: reviewRunId, issueId: childId, workMode: "standard", runtimeContext, nativeReview, apiUrl });
      try {
        await expect(review.execute({ tool: "resolve_review", callId: "unread", arguments: { decision, reason: "Evidence checked" } })).rejects.toThrow("Read the current bundle");
        for (const file of ["AGENTS.md", "PROJECT.md", "memory/handoff.md", "REVIEW.md"]) await review.execute({ tool: "read_bundle_file", callId: randomUUID(), arguments: { path: file } });
        await expect(review.execute({ tool: "create_task", callId: "review-dispatch", arguments: {} })).rejects.toThrow();
        if (decision === "reject") {
          expect(review.definitions().some(tool => tool.name === "request_human_input")).toBe(true);
          const requested = await review.execute({ tool: "request_human_input", callId: "review-question", arguments: {
            interactionKind: "questions", idempotencyKey: "review-question", title: "Review tradeoff", prompt: "Which scope applies?",
            continuationPolicy: "wake_assignee", payload: { questions: [{ id: "scope", prompt: "Scope", selectionMode: "single",
              options: [{ id: "original", label: "Keep the agreed scope" }], required: true }] },
          } }) as { interaction: { id: string; delegation: { revision: string; recipientAgentId: string } } };
          expect(requested.interaction.delegation.recipientAgentId).toBe(delegateId);
          await issueThreadInteractionService(db).answerQuestions({ id: childId, companyId }, requested.interaction.id,
            { answers: [{ questionId: "scope", optionIds: ["original"] }], summaryMarkdown: "Existing scope still applies",
              delegationRevision: requested.interaction.delegation.revision }, { agentId: delegateId, runId: delegateRunId });
          const wakeup = vi.fn(async (target: string, input: any) => {
            await db.insert(agentWakeupRequests).values({ companyId, agentId: target, source: "automation", status: "queued",
              idempotencyKey: input.idempotencyKey, payload: input.payload });
            return null;
          });
          await questionResponseDeliveryService(db, { heartbeat: { wakeup, cancelRun: vi.fn() } }).deliver(requested.interaction.id);
          expect(wakeup).toHaveBeenCalledWith(agentId, expect.objectContaining({ contextSnapshot: expect.objectContaining({
            ...nativeReview, sourceRunId: workerRunId }) }));
          const [unclaimed] = await db.select().from(issues).where(eq(issues.id, childId));
          expect(unclaimed).toMatchObject({ assigneeAgentId: workerId, executionRunId: reviewRunId });
        }
        expect(await review.execute({ tool: "resolve_review", callId: decision, arguments: { decision,
          reason: `${decision}: checked delivery revision ${deliveryRevision}; ${decision === "reject" ? "add the missing acceptance case" : "acceptance case verified"}` } }))
          .toMatchObject({ status: decision === "accept" ? "accepted" : "rejected" });
      } finally { review.close(); }
      const [updated] = await db.select().from(issues).where(eq(issues.id, childId));
      expect(updated?.assigneeAgentId).toBe(workerId); expect(updated?.assigneeAdapterOverrides).toEqual(override);
      expect(updated?.status).toBe(decision === "accept" ? "done" : "todo");
      await db.update(heartbeatRuns).set({ status: "succeeded" }).where(eq(heartbeatRuns.id, reviewRunId));
    }
    const all = await db.select().from(issueThreadInteractions).where(eq(issueThreadInteractions.issueId, childId));
    expect(all.filter(row => row.addresseeAgentId === agentId).map(row => row.status).sort()).toEqual(["accepted", "rejected"]);
    expect(all.find(row => row.status === "accepted")?.result).toMatchObject({ acceptanceReason: expect.stringContaining("acceptance case verified") });
  }, 30_000);

  it("does not let run-end collection overwrite a newer canonical support-file save", async () => {
    await reads();
    const file = "memory/decisions.md", before = await readPmBundleFile(db, scope, runId, { path: file });
    const baseline = await snapshotAgentFiles(localRoot);
    const newer = "# Decisions\nA newer Owner-reviewed process.\n";
    await agentFileStore(db).write({ companyId, agentId, path: file, bytes: Buffer.from(newer), baseHash: before.contentHash! },
      { type: "board", source: "local_implicit", userId, companyIds: [companyId] });
    await fs.writeFile(path.join(localRoot, file), "# Stale unacknowledged local content\n");
    await expect(agentFileStore(db).apply({ companyId, agentId, sourceDir: localRoot, baseline },
      { type: "agent", source: "agent_jwt", companyId, agentId, runId })).rejects.toThrow("controlled bundle tools");
    expect(await fs.readFile(path.join(root, file), "utf8")).toBe(newer);
    await fs.writeFile(path.join(localRoot, file), before.content!);
    const collected = await agentInstructionWorkingCopyService(db).collectStopped({ companyId, runId });
    expect(collected?.state).toBe("unchanged");
    expect(await fs.readFile(path.join(root, file), "utf8")).toBe(newer);
  });
});
