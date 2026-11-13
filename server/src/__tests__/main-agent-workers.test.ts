import { seedManagedDispatchWorkspace } from "./helpers/managed-dispatch-workspace.js";
import express from "express";
import { createServer, type Server } from "node:http";
import { issueRoutes } from "../routes/issues.js";
import { errorHandler } from "../middleware/error-handler.js";
import type { StorageService } from "../storage/types.js";
import { beforeAll, afterAll, describe, expect, it, vi } from "vitest";
import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { eq } from "drizzle-orm";
import { agents, companies, projects, projectWorkspaces, authUsers, companyMemberships, principalPermissionGrants, issues, executionWorkspaces, createDb } from "@paperclipai/db";
import { renderPmWorkerPolicy, type PmWorkerPolicy } from "@paperclipai/shared";
import { startRecoveryPostgres } from "./helpers/recovery-postgres.js";
import { pmWorkerPolicyService } from "../services/pm-worker-policy.js";
import { resolveManagedInstructionsRoot } from "../services/agent-instructions.js";
import { agentFileStore } from "../services/agent-file-store.js";
import { mainAgentDispatchScope, mainAgentProjectId, workerPolicyLayout } from "../services/main-agent-workers.js";
import { applyMainAgentDispatch, pmCoordinationMiddleware } from "../middleware/pm-coordination.js";

vi.mock("../adapters/registry.js", async original => ({ ...await original<typeof import("../adapters/registry.js")>(),
  listAdapterModels: async () => [{ id: "gpt-6-astra", label: "Astra" }, { id: "compass-sonnet5.5", label: "Sonnet" }],
}));

describe("main agent worker policy and dispatch", () => {
  let database: Awaited<ReturnType<typeof startRecoveryPostgres>>, db: ReturnType<typeof createDb>, home: string, root: string;
  let server: Server, apiUrl: string;
  let afterDispatch: (() => Promise<void>) | undefined;
  const companyId = randomUUID(), projectId = randomUUID(), otherProjectId = randomUUID(), mainId = randomUUID(), claudeId = randomUUID(), codexId = randomUUID();
  const userId = randomUUID(), sourceId = randomUUID(), claudeChoice = randomUUID(), codexChoice = randomUUID();
  const actor = { type: "board" as const, userId, source: "session" as const };
  const policy: PmWorkerPolicy = { version: 2, defaultSelectionId: claudeChoice, workers: [
    { agentId: claudeId, harness: "claude_local", selections: [{ id: claudeChoice, model: "compass-sonnet5.5", thinking: "high", permission: "approve-all", speed: "standard", purpose: "預設 worker" }] },
    { agentId: codexId, harness: "codex_local", selections: [{ id: codexChoice, model: "gpt-6-astra", thinking: "xhigh", permission: "approve-all", speed: "fast", purpose: "複雜任務 worker" }] },
  ] };
  const workspaceId = randomUUID();
  const workspaceSelection = { kind: "existing", workspaceId } as const;
  const readMain = async () => (await db.select().from(agents).where(eq(agents.id, mainId)))[0]!;
  const post = (body: Record<string, unknown>) => applyMainAgentDispatch(db, { agentId: mainId, companyId }, { method: "POST", path: `/companies/${companyId}/issues`, body });

  beforeAll(async () => {
    home = await fs.mkdtemp(path.join(os.tmpdir(), "main-agent-workers-"));
    vi.stubEnv("PAPERCLIP_HOME", home); vi.stubEnv("PAPERCLIP_IN_WORKTREE", "1"); vi.stubEnv("PAPERCLIP_AGENT_JWT_SECRET", "owned-main-agent-test");
    database = await startRecoveryPostgres("main-agent-workers-"); db = createDb(database.connectionString);
    await db.insert(authUsers).values({ id: userId, name: "Owner", email: `${userId}@example.test`, createdAt: new Date(), updatedAt: new Date() });
    await db.insert(companies).values({ id: companyId, name: "Main agent fixture", issuePrefix: "MAW", defaultResponsibleUserId: userId });
    await db.insert(companyMemberships).values({ companyId, principalType: "user", principalId: userId, membershipRole: "owner" });
    await db.insert(companyMemberships).values({ companyId, principalType: "agent", principalId: mainId, membershipRole: "member" });
    await db.insert(principalPermissionGrants).values({ companyId, principalType: "user", principalId: userId, permissionKey: "agents:configure", scope: { agentIds: [mainId] } });
    await db.insert(projects).values([{ id: projectId, companyId, name: "Project" }, { id: otherProjectId, companyId, name: "Other" }]);
    const source = path.join(home, "source"); await fs.mkdir(source);
    await db.insert(projectWorkspaces).values({ id: sourceId, companyId, projectId, name: "Development source", cwd: source, isPrimary: true });
    await seedManagedDispatchWorkspace(db, { id: workspaceId, companyId, projectId, sourceId, cwd: source, kind: "repository_root" });
    root = resolveManagedInstructionsRoot({ id: mainId, companyId, name: "Main", adapterConfig: {} });
    await db.insert(agents).values([
      { id: mainId, companyId, name: "Main", status: "active", adapterType: "ccpocket_bridge",
        adapterConfig: { role: "main", projectId, cwd: source, instructionsBundleMode: "managed", instructionsRootPath: root, instructionsEntryFile: "AGENTS.md" }, runtimeConfig: {} },
      { id: claudeId, companyId, name: "Shared Claude", status: "active", adapterType: "claude_local", adapterConfig: { model: "global-claude" }, runtimeConfig: { requireProjectWorkspace: true } },
      { id: codexId, companyId, name: "Shared Codex", status: "active", adapterType: "codex_local", adapterConfig: { model: "global-codex" }, runtimeConfig: { requireProjectWorkspace: true } },
    ]);
    await fs.mkdir(root, { recursive: true });
    await fs.writeFile(path.join(root, "AGENTS.md"), "# Main\n");
    await fs.writeFile(path.join(root, "PROJECT.md"), "# Project\nOwner-written facts.\n");
    const app = express(); app.use(express.json());
    app.use((req, _res, next) => {
      req.actor = { type: "agent", source: "agent_jwt", agentId: mainId, companyId,
        onBehalfOfUserId: userId, onBehalfOfMemberships: [{ companyId, status: "active", membershipRole: "owner" }] };
      next();
    });
    app.use("/api", pmCoordinationMiddleware(db));
    app.use(async (_req, _res, next) => { try { const hook = afterDispatch; afterDispatch = undefined; await hook?.(); next(); } catch (error) { next(error); } });
    app.use("/api", issueRoutes(db, {} as StorageService)); app.use(errorHandler);
    server = createServer(app); await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
    apiUrl = "http://127.0.0.1:" + (server.address() as { port: number }).port;

  }, 90_000);
  afterAll(async () => { if (server) { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); } await db?.$client.end({ timeout: 1 }); await database?.cleanup(); vi.unstubAllEnvs(); if (home) await fs.rm(home, { recursive: true, force: true }); });

  it("recognizes only ccpocket main agents with a project", () => {
    const base = { id: mainId, companyId, adapterType: "ccpocket_bridge", adapterConfig: { role: "main", projectId } };
    expect(mainAgentProjectId(base)).toBe(projectId);
    expect(mainAgentProjectId({ ...base, adapterConfig: { role: "pm", projectId } })).toBeNull();
    expect(mainAgentProjectId({ ...base, adapterType: "claude_local" })).toBeNull();
    expect(mainAgentProjectId({ ...base, adapterConfig: { role: "main", projectId: "all-set" } })).toBeNull();
    expect(workerPolicyLayout(base)).toEqual({ version: "main-v1", workerDocumentPath: "PROJECT.md" });
    expect(mainAgentDispatchScope(base)).toBeNull();
    expect(() => mainAgentDispatchScope({ ...base, runtimeConfig: { pmDelegation: { version: 2 } } })).toThrow("invalid");
  });

  it("does nothing before the Owner saves a policy", async () => {
    const body = { projectId, title: "Ordinary", assigneeAdapterOverrides: { workerSelectionId: claudeChoice } };
    expect(await post(body)).toBe(false);
    expect(body).not.toHaveProperty("executionPolicy");
  });

  it("saves the policy into PROJECT.md with option IDs and protects the managed table", async () => {
    const svc = pmWorkerPolicyService(db), before = await svc.read(companyId, mainId, actor);
    expect(before.documentPath).toBe("PROJECT.md");
    await svc.save(companyId, mainId, { policy, baseRevision: before.revision, baseHash: before.documentHash }, actor);
    const after = await svc.read(companyId, mainId, actor);
    expect(after.policy).toEqual(policy); expect(after.warnings).toEqual([]);
    expect(after.document).toContain("Owner-written facts.");
    expect(after.document).toContain(`| ${codexChoice} | 複雜任務 worker | Codex | gpt-6-astra | xhigh | fast |  |`);
    expect(after.document).toContain(renderPmWorkerPolicy(policy, "main-v1"));
    await expect(svc.save(companyId, mainId, { policy, baseRevision: after.revision, baseHash: after.documentHash }, { type: "agent", agentId: mainId, companyId })).rejects.toThrow("Owner");
    await expect(agentFileStore(db).write({ companyId, agentId: mainId, path: "PROJECT.md", bytes: Buffer.from("Changed"), baseHash: after.documentHash }, actor)).rejects.toThrow("managed worker table");
  });

  it("expands an option ID into the worker, model and main-agent review", async () => {
    const body: Record<string, unknown> = { title: "Use Codex", workspaceSelection, assigneeAdapterOverrides: { workerSelectionId: codexChoice } };
    expect(await post(body)).toBe(true);
    expect(body).toMatchObject({ projectId, assigneeAgentId: codexId, assigneeAdapterOverrides: { workerSelectionId: codexChoice, adapterConfig: { model: "gpt-6-astra" } },
      executionWorkspaceSettings: { mode: "isolated_workspace", sessionOnly: false } });
    const stages = (body.executionPolicy as { stages: Array<{ type: string; participants: Array<{ agentId?: string }> }> }).stages;
    expect(stages).toEqual([expect.objectContaining({ type: "review", participants: [expect.objectContaining({ agentId: mainId })] })]);
    const byDefault: Record<string, unknown> = { title: "Default", workspaceSelection, assigneeAgentId: claudeId };
    expect(await post(byDefault)).toBe(true);
    expect(byDefault).toMatchObject({ assigneeAgentId: claudeId, assigneeAdapterOverrides: { workerSelectionId: claudeChoice } });
  });

  it("creates worker tasks through HTTP with external resources, registered roots, and project defaults", async () => {
    // Keep this HTTP boundary independently selectable with -t.
    const policyService = pmWorkerPolicyService(db), policyBefore = await policyService.read(companyId, mainId, actor);
    await policyService.save(companyId, mainId, { policy, baseRevision: policyBefore.revision, baseHash: policyBefore.documentHash }, actor);
    const create = async (extra: Record<string, unknown>) => {
      const response = await fetch(apiUrl + "/api/companies/" + companyId + "/issues", {
        method: "POST", headers: { "content-type": "application/json" },
        body: JSON.stringify({ title: "Main dispatch " + randomUUID(), initialPlan: "Review bounded evidence.", status: "backlog",
          assigneeAdapterOverrides: { workerSelectionId: codexChoice }, ...extra }),
      });
      return { status: response.status, body: await response.json() as Record<string, any> };
    };
    for (const selection of [{ kind: "session_only" }, workspaceSelection]) {
      const response = await create({ workspaceSelection: selection });
      expect(response, JSON.stringify(response.body)).toMatchObject({ status: 201,
        body: { projectId, assigneeAgentId: codexId, workspaceSelection: { selection } } });
      const [saved] = await db.select().from(issues).where(eq(issues.id, response.body.id));
      expect(saved?.workspaceSelection).toMatchObject({ source: "explicit", selection });
      if (selection.kind === "session_only") expect(saved?.executionWorkspaceSettings).toMatchObject({ sessionOnly: true });
      expect(saved?.executionWorkspaceSettings).not.toHaveProperty("sharedWorkspaceConcurrency");
      expect(saved?.executionWorkspaceId).toBe(selection.kind === "existing" ? workspaceId : null);
    }
    await db.update(projects).set({ executionWorkspacePolicy: { defaultExecutionWorkspaceId: workspaceId } }).where(eq(projects.id, projectId));
    try {
      expect(await create({})).toMatchObject({ status: 201, body: { executionWorkspaceId: workspaceId } });
      const [row] = await db.select().from(executionWorkspaces).where(eq(executionWorkspaces.id, workspaceId));
      await db.update(executionWorkspaces).set({ metadata: { ...row!.metadata,
        mainManagedWorktree: { ...(row!.metadata!.mainManagedWorktree as object), phase: "converging" } } }).where(eq(executionWorkspaces.id, workspaceId));
      expect(await create({})).toMatchObject({ status: 409 });
      await db.update(executionWorkspaces).set({ metadata: row!.metadata }).where(eq(executionWorkspaces.id, workspaceId));
      expect(await create({ workspaceSelection: { kind: "configured_source", projectWorkspaceId: sourceId } })).toMatchObject({ status: 409 });
      expect(await create({ workspaceSelection: { kind: "session_only" }, executionWorkspaceSettings: { environmentId: randomUUID() } }))
        .toMatchObject({ status: 403 });
      expect(await create({ projectId: otherProjectId, workspaceSelection })).toMatchObject({ status: 403 });
      await db.update(projectWorkspaces).set({ metadata: { usage: "production" } }).where(eq(projectWorkspaces.id, sourceId));
      expect(await create({ workspaceSelection })).toMatchObject({ status: 422, body: { details: { code: "PM_DEVELOPMENT_SOURCE_REQUIRED" } } });
      const developmentId = randomUUID();
      await seedManagedDispatchWorkspace(db, { id: developmentId, companyId, projectId, sourceId,
        cwd: path.join(home, "development"), sourceCwd: path.join(home, "source") });
      expect(await create({ workspaceSelection: { kind: "existing", workspaceId: developmentId } }))
        .toMatchObject({ status: 201, body: { executionWorkspaceId: developmentId } });
      await db.update(projectWorkspaces).set({ metadata: null }).where(eq(projectWorkspaces.id, sourceId));
      const owner = await readMain();
      afterDispatch = async () => { await db.update(agents).set({ runtimeConfig: { ...owner.runtimeConfig, pmDelegation: null } }).where(eq(agents.id, mainId)); };
      expect(await create({ workspaceSelection: { kind: "session_only" } })).toMatchObject({ status: 403 });
      await db.update(agents).set({ runtimeConfig: owner.runtimeConfig }).where(eq(agents.id, mainId));
      afterDispatch = async () => { await db.update(agents).set({ adapterConfig: { ...owner.adapterConfig, projectId: otherProjectId } }).where(eq(agents.id, mainId)); };
      expect(await create({ workspaceSelection: { kind: "session_only" } })).toMatchObject({ status: 403 });
      await db.update(agents).set({ adapterConfig: owner.adapterConfig }).where(eq(agents.id, mainId));
      const privateId = randomUUID();
      await db.insert(issues).values({ id: privateId, companyId, projectId, title: "Private source",
        status: "done", visibility: "private", privacyRootIssueId: privateId,
        createdByAgentId: claudeId, assigneeAgentId: claudeId, executionWorkspaceId: workspaceId });
      expect(await create({ workspaceSelection })).toMatchObject({ status: 404 });
      await db.delete(issues).where(eq(issues.id, privateId));
    } finally { await db.update(projects).set({ executionWorkspacePolicy: null }).where(eq(projects.id, projectId)); }
  });

  it("rejects worker dispatch outside the project or without a workspace, and leaves other requests alone", async () => {
    await expect(post({ projectId: otherProjectId, title: "Elsewhere", workspaceSelection, assigneeAdapterOverrides: { workerSelectionId: codexChoice } })).rejects.toThrow();
    await expect(post({ title: "No workspace", assigneeAdapterOverrides: { workerSelectionId: codexChoice } })).rejects.toThrow();
    await expect(post({ title: "Unknown option", workspaceSelection, assigneeAdapterOverrides: { workerSelectionId: randomUUID() } })).rejects.toThrow();
    const own: Record<string, unknown> = { projectId: otherProjectId, title: "Self task", assigneeAgentId: mainId };
    expect(await post(own)).toBe(false);
    expect(own).toEqual({ projectId: otherProjectId, title: "Self task", assigneeAgentId: mainId });
    expect(await applyMainAgentDispatch(db, { agentId: mainId, companyId }, { method: "PATCH", path: `/issues/${randomUUID()}`, body: { assigneeAgentId: codexId } })).toBe(false);
    expect((await readMain()).runtimeConfig?.pmDelegation).toEqual(policy);
  });
});
