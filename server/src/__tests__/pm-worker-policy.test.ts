import { seedManagedDispatchWorkspace } from "./helpers/managed-dispatch-workspace.js";
import { beforeAll, afterAll, describe, expect, it, vi } from "vitest";
import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { eq } from "drizzle-orm";
import { agents, companies, projects, projectWorkspaces, issues, issueWorkProducts, issueExecutionDecisions, heartbeatRuns, authUsers, companyMemberships, principalPermissionGrants, createDb, toolApplications, toolConnections, connectionGrants, toolConnectionInstalls } from "@paperclipai/db";
import { pmInstructionLayout, pmWorkerPolicySchema, renderPmWorkerPolicy, type PmWorkerPolicy } from "@paperclipai/shared";
import { startRecoveryPostgres } from "./helpers/recovery-postgres.js";
import { pmWorkerCatalog, pmWorkerPolicyService } from "../services/pm-worker-policy.js";
import { resolveManagedInstructionsRoot } from "../services/agent-instructions.js";
import { agentFileStore } from "../services/agent-file-store.js";
import * as instructionFiles from "../services/agent-instruction-files.js";
import { assertPmDispatch, pmCoordinationScope } from "../services/pm-coordination-policy.js";
import { projectSessionRecords, projectWorkProductRecords } from "../services/project-execution-records.js";
import { agentService } from "../services/agents.js";

const bridgeProbes = vi.hoisted(() => vi.fn());
vi.mock("../adapters/registry.js", async original => ({ ...await original<typeof import("../adapters/registry.js")>(),
  listAdapterModels: async (type: string, context?: { hostId?: string }) => { bridgeProbes(context); return type === "ccpocket_bridge" ? [
    { id: "michael-server/antigravity/gemini-test", label: "Antigravity · gemini-test", efforts: ["low", "high"] },
    { id: "michael-server/claude/compass-opus5.5", label: "Claude via Bridge", efforts: ["high"] },
    { id: "other-host/antigravity/gemini-test", label: "Another host", efforts: [] },
    { id: "shopee-d/codex/gpt-6-astra", label: "Astra on shopee-d", efforts: ["high"] },
    { id: "shopee-e/codex/gpt-6-astra", label: "Astra on shopee-e", efforts: ["high"] },
    { id: "shopee-e/claude/opus", label: "Claude on shopee-e", efforts: ["high"] },
  ] : [{ id: "gpt-6.1-sol", label: "Sol" }]; },
}));

describe.each(["split-v1", "compact-v1"] as const)("%s PM worker policy with owned database and real files", (instructionLayout) => {
  const documentPath = instructionLayout === "compact-v1" ? "PROJECT.md" : "WORKERS.md";
  let database: Awaited<ReturnType<typeof startRecoveryPostgres>>, db: ReturnType<typeof createDb>, home: string, root: string;
  const companyId = randomUUID(), projectId = randomUUID(), otherProjectId = randomUUID(), pmId = randomUUID(), workerId = randomUUID(), userId = randomUUID();
  const issueId = randomUUID(), otherIssueId = randomUUID(), runId = randomUUID(), legacyRunId = randomUUID(), otherRunId = randomUUID(), choiceId = randomUUID();
  const sourceId = randomUUID();
  const workspaceId = randomUUID();
  const workspaceSelection = { kind: "existing", workspaceId } as const;
  const actor = { type: "board" as const, userId, source: "session" as const };
  const policy: PmWorkerPolicy = { version: 2, defaultSelectionId: choiceId, workers: [{ agentId: workerId, harness: "codex_local",
    selections: [{ id: choiceId, model: "gpt-6.1-sol", thinking: "high", permission: "approve-reads", speed: "standard", purpose: "一般 coding agent" }] }] };
  const readAgent = async () => (await db.select().from(agents).where(eq(agents.id, pmId)))[0]!;
  const scope = async () => pmCoordinationScope(await readAgent())!;
  beforeAll(async () => {
    home = await fs.mkdtemp(path.join(os.tmpdir(), "pm-worker-policy-"));
    vi.stubEnv("PAPERCLIP_HOME", home); vi.stubEnv("PAPERCLIP_IN_WORKTREE", "1"); vi.stubEnv("PAPERCLIP_AGENT_JWT_SECRET", "owned-worker-policy-test");
    database = await startRecoveryPostgres("pm-worker-policy-"); db = createDb(database.connectionString);
    await db.insert(authUsers).values({ id: userId, name: "Owner", email: `${userId}@example.test`, createdAt: new Date(), updatedAt: new Date() });
    await db.insert(companies).values({ id: companyId, name: "Worker settings fixture", issuePrefix: "PWT", defaultResponsibleUserId: userId });
    await db.insert(companyMemberships).values({ companyId, principalType: "user", principalId: userId, membershipRole: "owner" });
    await db.insert(principalPermissionGrants).values({ companyId, principalType: "user", principalId: userId, permissionKey: "agents:configure", scope: { agentIds: [pmId] } });
    await db.insert(projects).values([{ id: projectId, companyId, name: "Project" }, { id: otherProjectId, companyId, name: "Other" }]);
    const repo = path.join(home, "source"); await fs.mkdir(repo);
    execFileSync("git", ["init", repo], { stdio: "ignore" });
    execFileSync("git", ["-C", repo, "-c", "user.name=Fixture", "-c", "user.email=fixture@example.test", "commit", "--allow-empty", "-m", "Fixture"], { stdio: "ignore" });
    await db.insert(projectWorkspaces).values({ id: sourceId, companyId, projectId, name: "Owned Git source", cwd: repo, isPrimary: true });
    await seedManagedDispatchWorkspace(db, { id: workspaceId, companyId, projectId, sourceId, cwd: repo });
    root = resolveManagedInstructionsRoot({ id: pmId, companyId, name: "PM", adapterConfig: {} });
    await db.insert(agents).values([
      { id: pmId, companyId, name: "PM", status: "active", adapterType: "claude_local",
        adapterConfig: { instructionsBundleMode: "managed", instructionsRootPath: root, instructionsEntryFile: "AGENTS.md" },
        runtimeConfig: { pmInstructionLayout: instructionLayout, workspaceBinding: { mode: "project_pm", projectId, workerRoot: home, workerSlots: 0, workerIsolation: "shared" } } },
      { id: workerId, companyId, name: "Shared Codex", status: "active", adapterType: "codex_local", adapterConfig: { model: "unchanged-global-model", engine: "acp" }, runtimeConfig: { requireTaskWorktree: true } },
    ]);
    await fs.mkdir(root, { recursive: true });
    await fs.writeFile(path.join(root, "AGENTS.md"), "# PM\n");
    await fs.writeFile(path.join(root, documentPath), "# Workers\nKeep handwritten review and isolation rules.\n");
    await db.insert(issues).values([{ id: issueId, companyId, projectId, title: "Original task", status: "done", assigneeAgentId: workerId,
      assigneeAdapterOverrides: { adapterConfig: { model: "historical-model" } } }, { id: otherIssueId, companyId, projectId: otherProjectId, title: "Unrelated", status: "done", assigneeAgentId: workerId }]);
    await db.insert(issueExecutionDecisions).values({ companyId, issueId, stageId: randomUUID(), stageType: "review", actorAgentId: pmId, outcome: "approved", body: "Evidence accepted" });
    await db.insert(issueWorkProducts).values([
      { companyId, projectId: otherProjectId, issueId, type: "pull_request", provider: "test", title: "Registered delivery", status: "ready", reviewState: "approved" },
      { companyId, projectId, issueId: otherIssueId, type: "pull_request", provider: "test", title: "Other project delivery", status: "ready" },
    ]);
    await db.insert(heartbeatRuns).values([
      { id: runId, companyId, agentId: workerId, nativeIssueId: issueId, runtimeMode: "native", status: "succeeded", sessionIdAfter: "original-session" },
      { id: legacyRunId, companyId, agentId: workerId, issueId, runtimeMode: "legacy", status: "cancelled", sessionIdAfter: "original-direct-adapter-session" },
      { id: otherRunId, companyId, agentId: workerId, issueId: otherIssueId, runtimeMode: "legacy", status: "succeeded" },
    ]);
  }, 90_000);
  afterAll(async () => { await db?.$client.end({ timeout: 1 }); await database?.cleanup(); vi.unstubAllEnvs(); if (home) await fs.rm(home, { recursive: true, force: true }); });

  it("saves all fields and the projection, retaining existing tasks and worker defaults", async () => {
    const svc = pmWorkerPolicyService(db), before = await svc.read(companyId, pmId, actor);
    expect(before.policy).toBeNull(); expect(before.warnings.length).toBeGreaterThan(0);
    const receipt = await svc.save(companyId, pmId, { policy, baseRevision: before.revision, baseHash: before.documentHash }, actor);
    const after = await svc.read(companyId, pmId, actor);
    expect(after.policy).toEqual(policy); expect(after.revision).toBe(receipt.revision); expect(after.warnings).toEqual([]);
    expect(after.document).toContain("Keep handwritten review and isolation rules.");
    expect(after.documentPath).toBe(documentPath);
    if (instructionLayout === "compact-v1") {
      expect(after.document).toContain("| 一般 coding agent | Codex | gpt-6.1-sol | high | standard | 是 |");
      expect(after.document).not.toContain(choiceId);
      expect(after.document).not.toContain("```json");
      await expect(fs.stat(path.join(root, "WORKERS.md"))).rejects.toMatchObject({ code: "ENOENT" });
    } else {
      expect(after.document).toContain("approve-reads");
      expect(JSON.parse(after.document.split("```json\n")[1]!.split("\n```")[0]!)).toEqual(policy);
    }
    const task = (await db.select().from(issues).where(eq(issues.id, issueId)))[0]!;
    expect(task.assigneeAdapterOverrides).toEqual({ adapterConfig: { model: "historical-model" } });
    expect((await db.select().from(agents).where(eq(agents.id, workerId)))[0]!.adapterConfig?.model).toBe("unchanged-global-model");
    const selection = await assertPmDispatch(db, await scope(), { workspaceSelection, projectId });
    expect(selection).toMatchObject({ assigneeAgentId: workerId, assigneeAdapterOverrides: { workerSelectionId: choiceId,
      adapterConfig: { model: "gpt-6.1-sol", permissionMode: "approve-reads", dangerouslyBypassApprovalsAndSandbox: false } } });
    await expect(svc.save(companyId, pmId, { policy, baseRevision: before.revision, baseHash: before.documentHash }, actor)).rejects.toThrow("changed");
  });
  it("rejects file conflicts, agent escalation and generic configuration bypass", async () => {
    const svc = pmWorkerPolicyService(db), before = await svc.read(companyId, pmId, actor);
    await fs.appendFile(path.join(root, documentPath), "Concurrent note.\n");
    await expect(svc.save(companyId, pmId, { policy, baseRevision: before.revision, baseHash: before.documentHash }, actor)).rejects.toThrow("changed");
    await expect(svc.save(companyId, pmId, { policy, baseRevision: before.revision, baseHash: before.documentHash }, { type: "agent", agentId: pmId, companyId })).rejects.toThrow("Owner");
    await expect(agentService(db).update(pmId, { runtimeConfig: { ...(await readAgent()).runtimeConfig, pmDelegation: null } })).rejects.toThrow("worker-policy API");
    await expect(agentService(db).update(pmId, { runtimeConfig: { ...(await readAgent()).runtimeConfig,
      pmInstructionLayout: instructionLayout === "compact-v1" ? "split-v1" : "compact-v1" } },
      { recordRevision: { createdByAgentId: pmId } })).rejects.toThrow("Only an Owner");
    const current = await svc.read(companyId, pmId, actor);
    await expect(agentFileStore(db).write({ companyId, agentId: pmId, path: documentPath, bytes: Buffer.from("Changed authorization"), baseHash: current.documentHash }, actor)).rejects.toThrow("managed worker table");
  });
  it("rolls policy back on a projection failure and fences a partially written file", async () => {
    const svc = pmWorkerPolicyService(db), before = await svc.read(companyId, pmId, actor);
    const changed = structuredClone(policy); changed.workers[0]!.selections[0]!.thinking = "low";
    const original = instructionFiles.materializeInstructionBytes;
    const fault = vi.spyOn(instructionFiles, "materializeInstructionBytes").mockImplementationOnce(async (...args) => { await original(...args); throw new Error("Injected projection failure"); });
    try { await expect(svc.save(companyId, pmId, { policy: changed, baseRevision: before.revision, baseHash: before.documentHash }, actor)).rejects.toThrow("Injected"); }
    finally { fault.mockRestore(); }
    expect((await readAgent()).runtimeConfig?.pmDelegation).toEqual(policy);
    await expect(assertPmDispatch(db, await scope(), { workspaceSelection, projectId })).rejects.toThrow("out of sync");
    const repair = await svc.read(companyId, pmId, actor);
    expect(repair.warnings).toContainEqual(expect.stringContaining("out of sync"));
    await svc.save(companyId, pmId, { policy, baseRevision: repair.revision, baseHash: repair.documentHash }, actor);
    await expect(assertPmDispatch(db, await scope(), { workspaceSelection, projectId })).resolves.toMatchObject({ assigneeAgentId: workerId });
  });
  it("allows only one concurrent editor and rejects legacy settings for new dispatch", async () => {
    const svc = pmWorkerPolicyService(db), before = await svc.read(companyId, pmId, actor);
    const changed = structuredClone(policy); changed.workers[0]!.selections[0]!.thinking = "low";
    const second = structuredClone(changed); second.workers[0]!.selections[0]!.thinking = null;
    const outcomes = await Promise.allSettled([changed, second].map(candidate => svc.save(companyId, pmId,
      { policy: candidate, baseRevision: before.revision, baseHash: before.documentHash }, actor)));
    expect(outcomes.filter(result => result.status === "fulfilled")).toHaveLength(1);
    expect(outcomes.filter(result => result.status === "rejected")).toHaveLength(1);
    const current = await svc.read(companyId, pmId, actor);
    await svc.save(companyId, pmId, { policy, baseRevision: current.revision, baseHash: current.documentHash }, actor);
    const old = { ...(await scope()), delegation: { version: 1 as const, workers: [{ agentId: workerId, selections: [{ model: "historical-model" }] }] } };
    await expect(assertPmDispatch(db, old, { projectId, assigneeAgentId: workerId, assigneeAdapterOverrides: { adapterConfig: { model: "historical-model" } } })).rejects.toThrow("historical worker lists");
  });
  it("lists native runs by task project, retaining session IDs and excluding the shared worker's other project", async () => {
    const result = await projectSessionRecords(db, companyId, projectId, actor);
    expect(result.records.map(row => row.runId).sort()).toEqual([runId, legacyRunId].sort());
    expect(result.records.find(row => row.runId === runId)).toMatchObject({ sessionId: "original-session", status: "succeeded", issueId });
    const deliveries = await projectWorkProductRecords(db, companyId, projectId, actor);
    expect(deliveries.records).toHaveLength(2);
    expect(deliveries.records.find(row => row.source === "work_product")).toMatchObject({ title: "Registered delivery", issueId, reviewState: "approved" });
    expect(deliveries.records.find(row => row.source === "review")).toMatchObject({ issueId, status: "approved" });
    expect(result.pms).toEqual([{ id: pmId, name: "PM" }]);
    expect((await projectSessionRecords(db, randomUUID(), projectId, actor)).records).toEqual([]);
  });
  it("saves connection-bound Sonnet/Qwen options, dispatches exact bindings and rejects revoked or uninstalled routes", async () => {
    const appId = randomUUID();
    await db.insert(toolApplications).values({ id: appId, companyId, name: "Owned model routes", type: "rest_api" });
    const routes = [];
    for (const [index, model] of ["compass-sonnet5.5", "Qwen3.8_RTX2080ti_Strata", "uninstalled-model"].entries()) {
      const connectionId = randomUUID(), grantId = randomUUID();
      const binding = { mode: "delegated" as const, provider: "anthropic" as const, method: "api_key" as const, connectionId, grantId };
      await db.insert(toolConnections).values({ id: connectionId, companyId, applicationId: appId, name: model, uid: model, transport: "runtime_auth", connectionPurpose: "ai", enabled: true, status: "active", healthStatus: "ok",
        config: { ai: { provider: "anthropic", method: "api_key", routing: { kind: index === 0 ? "gateway" : "local", protocol: "messages", baseUrl: "http://127.0.0.1:8790", auth: "bearer", models: [{ id: model }] } } } });
      await db.insert(connectionGrants).values({ id: grantId, companyId, connectionId, kind: "user", subjectUserId: userId, status: "active" });
      if (index < 2) await db.insert(toolConnectionInstalls).values({ companyId, connectionId, targetType: "agent", targetId: workerId });
      routes.push({ model, binding });
    }
    await db.update(agents).set({ adapterType: "claude_local", runtimeConfig: { requireTaskWorktree: true, aiConnection: routes[0]!.binding } }).where(eq(agents.id, workerId));
    const svc = pmWorkerPolicyService(db), before = await svc.read(companyId, pmId, actor);
    const catalog = before.catalog.find(item => item.agentId === workerId)!;
    expect(catalog.models.map(item => item.id).sort()).toEqual(["Qwen3.8_RTX2080ti_Strata", "compass-sonnet5.5"]);
    const selections = routes.slice(0, 2).map(route => ({ id: randomUUID(), model: route.model, aiConnection: route.binding, thinking: "high", permission: "approve-all" as const, speed: "standard" as const }));
    const routed: PmWorkerPolicy = { version: 2, defaultSelectionId: selections[0]!.id, workers: [{ agentId: workerId, harness: "claude_local", selections }] };
    await svc.save(companyId, pmId, { policy: routed, baseRevision: before.revision, baseHash: before.documentHash }, actor);
    const after = await svc.read(companyId, pmId, actor);
    expect(after.policy).toEqual(routed); expect(after.warnings).toEqual([]);
    for (const choice of selections) {
      const dispatched = await assertPmDispatch(db, await scope(), { workspaceSelection, projectId, assigneeAdapterOverrides: { workerSelectionId: choice.id } });
      expect(dispatched.assigneeAdapterOverrides).toMatchObject({ aiConnection: choice.aiConnection, adapterConfig: { model: choice.model, effort: "high", permissionMode: "approve-all" } });
    }
    expect((await db.select().from(agents).where(eq(agents.id, workerId)))[0]!.runtimeConfig?.aiConnection).toEqual(routes[0]!.binding);
    await expect(assertPmDispatch(db, await scope(), { workspaceSelection, projectId, assigneeAdapterOverrides: { workerSelectionId: selections[0]!.id, aiConnection: routes[1]!.binding } })).rejects.toThrow("connection differs");
    const wrongRoute = structuredClone(routed); wrongRoute.workers[0]!.selections[0]!.aiConnection = routes[1]!.binding;
    await expect(svc.save(companyId, pmId, { policy: wrongRoute, baseRevision: after.revision, baseHash: after.documentHash }, actor)).rejects.toThrow("not supported");
    await db.update(connectionGrants).set({ status: "revoked" }).where(eq(connectionGrants.id, routes[1]!.binding.grantId));
    await expect(assertPmDispatch(db, await scope(), { workspaceSelection, projectId, assigneeAdapterOverrides: { workerSelectionId: selections[1]!.id } })).rejects.toThrow("unavailable or not installed");
  });

  it("changes layout only after the Owner prepares the exact target files and model projection", async () => {
    const before = await readAgent();
    const nextVersion = instructionLayout === "compact-v1" ? "split-v1" : "compact-v1";
    const runtimeConfig = { ...before.runtimeConfig, pmInstructionLayout: nextVersion };
    const options = { recordRevision: { source: "api", createdByUserId: userId } };
    await expect(agentService(db).update(pmId, { runtimeConfig }, options)).rejects.toThrow();
    const next = pmInstructionLayout(runtimeConfig), currentPolicy = pmWorkerPolicySchema.parse(before.runtimeConfig!.pmDelegation);
    for (const file of next.files) {
      await fs.mkdir(path.dirname(path.join(root, file)), { recursive: true });
      await fs.writeFile(path.join(root, file), file === next.workerDocumentPath
        ? `# Project\n${renderPmWorkerPolicy(currentPolicy, nextVersion)}\n` : `# ${file}\nPrepared by Owner\n`);
    }
    await agentService(db).update(pmId, { runtimeConfig }, options);
    expect((await readAgent()).runtimeConfig).toEqual(runtimeConfig);
    expect((await pmWorkerPolicyService(db).read(companyId, pmId, actor)).documentPath).toBe(next.workerDocumentPath);
  });

  it("offers plain CC Pocket Antigravity/Claude shared workers with explicit Full access, never Bridge main agents", async () => {
    const agyId = randomUUID(), mainId = randomUUID(), bridgeClaudeId = randomUUID();
    const bridge = { hostId: "michael-server", model: "michael-server/antigravity/gemini-test", permissionMode: "fullAccess" };
    await db.insert(agents).values([
      { id: agyId, companyId, name: "Antigravity worker", status: "active", adapterType: "ccpocket_bridge", adapterConfig: { ...bridge, provider: "antigravity" }, runtimeConfig: { requireProjectWorkspace: true } },
      { id: mainId, companyId, name: "Main", status: "active", adapterType: "ccpocket_bridge", adapterConfig: { ...bridge, provider: "antigravity", role: "main", projectId }, runtimeConfig: { requireProjectWorkspace: true } },
      { id: bridgeClaudeId, companyId, name: "Bridge Claude", status: "active", adapterType: "ccpocket_bridge", adapterConfig: { hostId: "michael-server", provider: "claude", model: "michael-server/claude/compass-opus5.5" }, runtimeConfig: { requireProjectWorkspace: true } },
    ]);
    const svc = pmWorkerPolicyService(db), before = await svc.read(companyId, pmId, actor);
    expect(before.catalog.map(item => item.agentId)).not.toContain(mainId);
    expect(before.catalog.find(item => item.agentId === bridgeClaudeId)).toMatchObject({ provider: "claude", hostId: "michael-server",
      permissions: ["default", "full-access"], models: [{ id: "michael-server/claude/compass-opus5.5", thinking: ["high"], speeds: ["standard"] }] });
    expect(before.catalog.find(item => item.agentId === agyId)).toEqual({ agentId: agyId, name: "Antigravity worker", harness: "ccpocket_bridge",
      provider: "antigravity", hostId: "michael-server", permissions: ["default", "full-access"], models: [{ id: "michael-server/antigravity/gemini-test", label: "Antigravity · gemini-test", thinking: ["low", "high"], speeds: ["standard"] }] });
    const [full, standard] = [randomUUID(), randomUUID()];
    const agy: PmWorkerPolicy = { version: 2, defaultSelectionId: full, workers: [{ agentId: agyId, harness: "ccpocket_bridge", selections: [
      { id: full, model: "michael-server/antigravity/gemini-test", thinking: "high", permission: "full-access", speed: "standard", purpose: "Antigravity coding" },
      { id: standard, model: "michael-server/antigravity/gemini-test", thinking: null, permission: "default", speed: "standard" }] }] };
    for (const patch of [{ permission: "approve-all" as const }, { speed: "fast" as const }, { thinking: "xhigh" }, { model: "other-host/antigravity/gemini-test" }, { model: "michael-server/claude/compass-opus5.5" }]) {
      const invalid = structuredClone(agy); Object.assign(invalid.workers[0]!.selections[0]!, patch);
      await expect(svc.save(companyId, pmId, { policy: invalid, baseRevision: before.revision, baseHash: before.documentHash }, actor)).rejects.toThrow("not supported");
    }
    const asMain = structuredClone(agy); asMain.workers[0]!.agentId = mainId;
    await expect(svc.save(companyId, pmId, { policy: asMain, baseRevision: before.revision, baseHash: before.documentHash }, actor)).rejects.toThrow("unavailable");
    await svc.save(companyId, pmId, { policy: agy, baseRevision: before.revision, baseHash: before.documentHash }, actor);
    const after = await svc.read(companyId, pmId, actor);
    expect(after.policy).toEqual(agy); expect(after.warnings).toEqual([]);
    expect(after.document).toContain("michael-server/antigravity/gemini-test");
    await expect(assertPmDispatch(db, await scope(), { workspaceSelection, projectId })).resolves.toEqual({ assigneeAgentId: agyId, assigneeAdapterOverrides: { workerSelectionId: full,
      adapterConfig: { model: "michael-server/antigravity/gemini-test", effort: "high", permissionMode: "fullAccess", dangerouslyBypassApprovalsAndSandbox: true } } });
    await expect(assertPmDispatch(db, await scope(), { workspaceSelection, projectId, assigneeAdapterOverrides: { workerSelectionId: standard } })).resolves.toMatchObject({
      assigneeAdapterOverrides: { adapterConfig: { effort: null, permissionMode: "default", dangerouslyBypassApprovalsAndSandbox: false } } });
    // A worker that later becomes a Bridge main agent is no longer a dispatch target.
    await db.update(agents).set({ adapterConfig: { ...bridge, provider: "antigravity", role: "main", projectId } }).where(eq(agents.id, agyId));
    await expect(assertPmDispatch(db, await scope(), { workspaceSelection, projectId })).rejects.toThrow("unavailable");
  });

  it("offers one shared worker on D and E without probing the other host or another company", async () => {
    const sharedId = randomUUID();
    await db.insert(agents).values({ id: sharedId, companyId, name: "Shopee Shared Codex", status: "idle", adapterType: "ccpocket_bridge",
      adapterConfig: { hostId: "shopee-e", provider: "codex" },
      runtimeConfig: { requireProjectWorkspace: true, bridgeWorkerHostCapacity: { "shopee-d": 4, "shopee-e": 4 } } });
    try {
      for (const hostId of ["shopee-d", "shopee-e"]) {
        bridgeProbes.mockClear();
        const catalog = await pmWorkerCatalog(db, companyId, undefined, hostId);
        const shared = catalog.find(entry => entry.agentId === sharedId)!;
        expect(shared).toMatchObject({ hostId, models: [{ id: `${hostId}/codex/gpt-6-astra` }] });
        expect(bridgeProbes.mock.calls.every(([context]) => context?.hostId === hostId)).toBe(true);
      }
      bridgeProbes.mockImplementation(context => { if (context?.hostId === "shopee-d") throw new Error("D offline"); });
      await expect(pmWorkerCatalog(db, companyId, undefined, "shopee-d")).rejects.toThrow("D offline");
      await expect(pmWorkerCatalog(db, companyId, undefined, "shopee-e")).resolves.toEqual(expect.arrayContaining([expect.objectContaining({ agentId: sharedId })]));
      expect(await pmWorkerCatalog(db, randomUUID(), undefined, "shopee-e")).toEqual([]);
      expect((await pmWorkerCatalog(db, companyId, undefined, "michael-server")).some(entry => entry.agentId === sharedId)).toBe(false);
    } finally {
      bridgeProbes.mockReset();
      await db.update(agents).set({ status: "terminated" }).where(eq(agents.id, sharedId));
    }
  });

  it("offers remote Bridge workers only on their own host and dispatches to registered directories or session-only", async () => {
    const remoteId = randomUUID(), remoteSourceId = randomUUID(), unhostedSourceId = randomUUID(), remoteWorkspaceId = randomUUID(), unhostedWorkspaceId = randomUUID();
    await db.insert(agents).values({ id: remoteId, companyId, name: "Shopee-E Codex", status: "active", adapterType: "ccpocket_bridge",
      adapterConfig: { hostId: "shopee-e", provider: "codex", model: "shopee-e/codex/gpt-6-astra", permissionMode: "fullAccess" }, runtimeConfig: { requireProjectWorkspace: true } });
    await db.insert(projectWorkspaces).values([
      { id: remoteSourceId, companyId, projectId, name: "Remote source", sourceType: "remote_managed", cwd: "/home/yoyo/Projects/Fixture", metadata: { hostId: "shopee-e" } },
      { id: unhostedSourceId, companyId, projectId, name: "Unhosted remote source", sourceType: "remote_managed", cwd: "/home/yoyo/Projects/Unknown" }]);
    await seedManagedDispatchWorkspace(db, { id: remoteWorkspaceId, companyId, projectId, sourceId: remoteSourceId,
      cwd: "/home/yoyo/Projects/Fixture", hostId: "shopee-e" });
    await seedManagedDispatchWorkspace(db, { id: unhostedWorkspaceId, companyId, projectId, sourceId: unhostedSourceId,
      cwd: "/home/yoyo/Projects/Unknown", hostId: "shopee-e" });
    const choice = randomUUID();
    const remote: PmWorkerPolicy = { version: 2, defaultSelectionId: choice, workers: [{ agentId: remoteId, harness: "ccpocket_bridge",
      selections: [{ id: choice, model: "shopee-e/codex/gpt-6-astra", thinking: "high", permission: "full-access", speed: "standard" }] }] };
    const svc = pmWorkerPolicyService(db);
    // A controller-host owner never sees or saves a worker that runs on another Bridge host.
    const local = await svc.read(companyId, pmId, actor);
    expect(local.catalog.map(item => item.agentId)).not.toContain(remoteId);
    await expect(svc.save(companyId, pmId, { policy: remote, baseRevision: local.revision, baseHash: local.documentHash }, actor))
      .rejects.toMatchObject({ details: expect.objectContaining({ code: "PM_WORKER_HOST_MISMATCH" }) });
    const original = await readAgent();
    await db.update(agents).set({ adapterType: "ccpocket_bridge", adapterConfig: { ...original.adapterConfig, hostId: "shopee-e", provider: "codex" } }).where(eq(agents.id, pmId));
    try {
      const onHost = await svc.read(companyId, pmId, actor);
      expect(onHost.catalog.map(item => item.agentId)).toEqual([remoteId]);
      expect(onHost.catalog[0]).toMatchObject({ provider: "codex", hostId: "shopee-e", models: [{ id: "shopee-e/codex/gpt-6-astra" }] });
      await svc.save(companyId, pmId, { policy: remote, baseRevision: onHost.revision, baseHash: onHost.documentHash }, actor);
      const existing = (workspaceId: string) => ({ kind: "existing", workspaceId }) as const;
      await expect(assertPmDispatch(db, await scope(), { workspaceSelection: existing(remoteWorkspaceId), projectId })).resolves.toMatchObject({ assigneeAgentId: remoteId,
        assigneeAdapterOverrides: { workerSelectionId: choice, adapterConfig: { model: "shopee-e/codex/gpt-6-astra", permissionMode: "fullAccess" } } });
      for (const selection of [existing(workspaceId), existing(unhostedWorkspaceId)]) {
        await expect(assertPmDispatch(db, await scope(), { workspaceSelection: selection, projectId }))
          .rejects.toMatchObject({ details: expect.objectContaining({ code: "PM_WORKER_HOST_MISMATCH" }) });
      }
      // External-resource tasks stay on the Owner-selected remote worker without a fake local source.
      await expect(assertPmDispatch(db, await scope(), { workspaceSelection: { kind: "session_only" }, projectId }))
        .resolves.toMatchObject({ assigneeAgentId: remoteId });
      await expect(assertPmDispatch(db, await scope(), { executionWorkspaceSettings: { sessionOnly: true }, projectId }))
        .resolves.toMatchObject({ assigneeAgentId: remoteId });
      // No explicit workspace and no project default remains a configuration error.
      await expect(assertPmDispatch(db, await scope(), { projectId })).rejects.toMatchObject({ details: expect.objectContaining({ code: "configuration_required" }) });
      // Moving the worker to another host invalidates the saved choice instead of dispatching across hosts.
      await db.update(agents).set({ adapterConfig: { hostId: "shopee-d", provider: "codex", permissionMode: "fullAccess" } }).where(eq(agents.id, remoteId));
      await expect(assertPmDispatch(db, await scope(), { workspaceSelection: { kind: "session_only" }, projectId }))
        .rejects.toMatchObject({ details: { code: "PM_WORKER_HOST_MISMATCH" } });
      await expect(assertPmDispatch(db, await scope(), { workspaceSelection: existing(remoteWorkspaceId), projectId })).rejects.toThrow();
      // Explicit multi-host opt-in permits the same worker ID on D, with D models only.
      await db.update(agents).set({ adapterConfig: { hostId: "shopee-e", provider: "codex", permissionMode: "fullAccess" },
        runtimeConfig: { requireProjectWorkspace: true, bridgeWorkerHostCapacity: { "shopee-d": 4, "shopee-e": 4 } } }).where(eq(agents.id, remoteId));
      await db.update(agents).set({ adapterConfig: { ...original.adapterConfig, hostId: "shopee-d", provider: "codex" } }).where(eq(agents.id, pmId));
      const onD = await svc.read(companyId, pmId, actor);
      expect(onD.catalog.find(entry => entry.agentId === remoteId)).toMatchObject({ hostId: "shopee-d", models: [{ id: "shopee-d/codex/gpt-6-astra" }] });
      const dPolicy = structuredClone(remote);
      dPolicy.workers[0]!.selections[0]!.model = "shopee-d/codex/gpt-6-astra";
      await svc.save(companyId, pmId, { policy: dPolicy, baseRevision: onD.revision, baseHash: onD.documentHash }, actor);
      await expect(assertPmDispatch(db, await scope(), { workspaceSelection: { kind: "session_only" }, projectId }))
        .resolves.toMatchObject({ assigneeAgentId: remoteId, assigneeAdapterOverrides: { adapterConfig: { model: "shopee-d/codex/gpt-6-astra" } } });
      await expect(assertPmDispatch(db, await scope(), { workspaceSelection: existing(remoteWorkspaceId), projectId }))
        .rejects.toMatchObject({ details: expect.objectContaining({ code: "PM_WORKER_HOST_MISMATCH" }) });
    } finally {
      await db.update(agents).set({ adapterType: original.adapterType, adapterConfig: original.adapterConfig }).where(eq(agents.id, pmId));
      await db.update(agents).set({ status: "terminated" }).where(eq(agents.id, remoteId));
    }
  });

});
