import { beforeAll, afterAll, describe, expect, it, vi } from "vitest";
import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { eq } from "drizzle-orm";
import { agents, companies, projects, projectWorkspaces, authUsers, companyMemberships, principalPermissionGrants, createDb } from "@paperclipai/db";
import { renderPmWorkerPolicy, type PmWorkerPolicy } from "@paperclipai/shared";
import { startRecoveryPostgres } from "./helpers/recovery-postgres.js";
import { pmWorkerPolicyService } from "../services/pm-worker-policy.js";
import { resolveManagedInstructionsRoot } from "../services/agent-instructions.js";
import { agentFileStore } from "../services/agent-file-store.js";
import { mainAgentDispatchScope, mainAgentProjectId, workerPolicyLayout } from "../services/main-agent-workers.js";
import { applyMainAgentDispatch } from "../middleware/pm-coordination.js";

vi.mock("../adapters/registry.js", async original => ({ ...await original<typeof import("../adapters/registry.js")>(),
  listAdapterModels: async () => [{ id: "gpt-6-astra", label: "Astra" }, { id: "compass-sonnet5.5", label: "Sonnet" }],
}));

describe("main agent worker policy and dispatch", () => {
  let database: Awaited<ReturnType<typeof startRecoveryPostgres>>, db: ReturnType<typeof createDb>, home: string, root: string;
  const companyId = randomUUID(), projectId = randomUUID(), otherProjectId = randomUUID(), mainId = randomUUID(), claudeId = randomUUID(), codexId = randomUUID();
  const userId = randomUUID(), sourceId = randomUUID(), claudeChoice = randomUUID(), codexChoice = randomUUID();
  const actor = { type: "board" as const, userId, source: "session" as const };
  const policy: PmWorkerPolicy = { version: 2, defaultSelectionId: claudeChoice, workers: [
    { agentId: claudeId, harness: "claude_local", selections: [{ id: claudeChoice, model: "compass-sonnet5.5", thinking: "high", permission: "approve-all", speed: "standard", purpose: "預設 worker" }] },
    { agentId: codexId, harness: "codex_local", selections: [{ id: codexChoice, model: "gpt-6-astra", thinking: "xhigh", permission: "approve-all", speed: "fast", purpose: "複雜任務 worker" }] },
  ] };
  const workspaceSelection = { kind: "configured_source", projectWorkspaceId: sourceId, mode: "shared" } as const;
  const readMain = async () => (await db.select().from(agents).where(eq(agents.id, mainId)))[0]!;
  const post = (body: Record<string, unknown>) => applyMainAgentDispatch(db, { agentId: mainId, companyId }, { method: "POST", path: `/companies/${companyId}/issues`, body });

  beforeAll(async () => {
    home = await fs.mkdtemp(path.join(os.tmpdir(), "main-agent-workers-"));
    vi.stubEnv("PAPERCLIP_HOME", home); vi.stubEnv("PAPERCLIP_IN_WORKTREE", "1"); vi.stubEnv("PAPERCLIP_AGENT_JWT_SECRET", "owned-main-agent-test");
    database = await startRecoveryPostgres("main-agent-workers-"); db = createDb(database.connectionString);
    await db.insert(authUsers).values({ id: userId, name: "Owner", email: `${userId}@example.test`, createdAt: new Date(), updatedAt: new Date() });
    await db.insert(companies).values({ id: companyId, name: "Main agent fixture", issuePrefix: "MAW", defaultResponsibleUserId: userId });
    await db.insert(companyMemberships).values({ companyId, principalType: "user", principalId: userId, membershipRole: "owner" });
    await db.insert(principalPermissionGrants).values({ companyId, principalType: "user", principalId: userId, permissionKey: "agents:configure", scope: { agentIds: [mainId] } });
    await db.insert(projects).values([{ id: projectId, companyId, name: "Project" }, { id: otherProjectId, companyId, name: "Other" }]);
    const source = path.join(home, "source"); await fs.mkdir(source);
    await db.insert(projectWorkspaces).values({ id: sourceId, companyId, projectId, name: "Development source", cwd: source, isPrimary: true });
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
  }, 90_000);
  afterAll(async () => { await db?.$client.end({ timeout: 1 }); await database?.cleanup(); vi.unstubAllEnvs(); if (home) await fs.rm(home, { recursive: true, force: true }); });

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
      executionWorkspaceSettings: { mode: "shared_workspace", sharedWorkspaceConcurrency: "serialize" } });
    const stages = (body.executionPolicy as { stages: Array<{ type: string; participants: Array<{ agentId?: string }> }> }).stages;
    expect(stages).toEqual([expect.objectContaining({ type: "review", participants: [expect.objectContaining({ agentId: mainId })] })]);
    const byDefault: Record<string, unknown> = { title: "Default", workspaceSelection, assigneeAgentId: claudeId };
    expect(await post(byDefault)).toBe(true);
    expect(byDefault).toMatchObject({ assigneeAgentId: claudeId, assigneeAdapterOverrides: { workerSelectionId: claudeChoice } });
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
