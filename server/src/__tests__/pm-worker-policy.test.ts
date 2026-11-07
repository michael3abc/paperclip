import { beforeAll, afterAll, describe, expect, it, vi } from "vitest";
import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { eq } from "drizzle-orm";
import { agents, companies, projects, issues, issueWorkProducts, issueExecutionDecisions, heartbeatRuns, authUsers, companyMemberships, principalPermissionGrants, createDb } from "@paperclipai/db";
import type { PmWorkerPolicy } from "@paperclipai/shared";
import { startRecoveryPostgres } from "./helpers/recovery-postgres.js";
import { pmWorkerPolicyService } from "../services/pm-worker-policy.js";
import { resolveManagedInstructionsRoot } from "../services/agent-instructions.js";
import { agentFileStore } from "../services/agent-file-store.js";
import * as instructionFiles from "../services/agent-instruction-files.js";
import { assertPmDispatch, pmCoordinationScope } from "../services/pm-coordination-policy.js";
import { projectSessionRecords, projectWorkProductRecords } from "../services/project-execution-records.js";
import { agentService } from "../services/agents.js";

vi.mock("../adapters/registry.js", async original => ({ ...await original<typeof import("../adapters/registry.js")>(),
  listAdapterModels: async () => [{ id: "gpt-6.1-sol", label: "Sol" }],
}));

describe("PM worker policy with owned database and real files", () => {
  let database: Awaited<ReturnType<typeof startRecoveryPostgres>>, db: ReturnType<typeof createDb>, home: string, root: string;
  const companyId = randomUUID(), projectId = randomUUID(), otherProjectId = randomUUID(), pmId = randomUUID(), workerId = randomUUID(), userId = randomUUID();
  const issueId = randomUUID(), otherIssueId = randomUUID(), runId = randomUUID(), legacyRunId = randomUUID(), otherRunId = randomUUID(), choiceId = randomUUID();
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
    root = resolveManagedInstructionsRoot({ id: pmId, companyId, name: "PM", adapterConfig: {} });
    await db.insert(agents).values([
      { id: pmId, companyId, name: "PM", status: "active", adapterType: "claude_local",
        adapterConfig: { instructionsBundleMode: "managed", instructionsRootPath: root, instructionsEntryFile: "AGENTS.md" },
        runtimeConfig: { workspaceBinding: { mode: "project_pm", projectId, workerRoot: home, workerSlots: 0, workerIsolation: "shared" } } },
      { id: workerId, companyId, name: "Shared Codex", status: "active", adapterType: "codex_local", adapterConfig: { model: "unchanged-global-model", engine: "acp" }, runtimeConfig: { requireTaskWorktree: true } },
    ]);
    await fs.mkdir(root, { recursive: true });
    await fs.writeFile(path.join(root, "AGENTS.md"), "# PM\n");
    await fs.writeFile(path.join(root, "WORKERS.md"), "# Workers\nKeep handwritten review and isolation rules.\n");
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
    expect(after.document).toContain("approve-reads");
    expect(JSON.parse(after.document.split("```json\n")[1]!.split("\n```")[0]!)).toEqual(policy);
    const task = (await db.select().from(issues).where(eq(issues.id, issueId)))[0]!;
    expect(task.assigneeAdapterOverrides).toEqual({ adapterConfig: { model: "historical-model" } });
    expect((await db.select().from(agents).where(eq(agents.id, workerId)))[0]!.adapterConfig?.model).toBe("unchanged-global-model");
    const selection = await assertPmDispatch(db, await scope(), { projectId });
    expect(selection).toMatchObject({ assigneeAgentId: workerId, assigneeAdapterOverrides: { workerSelectionId: choiceId,
      adapterConfig: { model: "gpt-6.1-sol", permissionMode: "approve-reads", dangerouslyBypassApprovalsAndSandbox: false } } });
    await expect(svc.save(companyId, pmId, { policy, baseRevision: before.revision, baseHash: before.documentHash }, actor)).rejects.toThrow("changed");
  });
  it("rejects file conflicts, agent escalation and generic configuration bypass", async () => {
    const svc = pmWorkerPolicyService(db), before = await svc.read(companyId, pmId, actor);
    await fs.appendFile(path.join(root, "WORKERS.md"), "Concurrent note.\n");
    await expect(svc.save(companyId, pmId, { policy, baseRevision: before.revision, baseHash: before.documentHash }, actor)).rejects.toThrow("changed");
    await expect(svc.save(companyId, pmId, { policy, baseRevision: before.revision, baseHash: before.documentHash }, { type: "agent", agentId: pmId, companyId })).rejects.toThrow("Owner");
    await expect(agentService(db).update(pmId, { runtimeConfig: { ...(await readAgent()).runtimeConfig, pmDelegation: null } })).rejects.toThrow("worker-policy API");
    const current = await svc.read(companyId, pmId, actor);
    await expect(agentFileStore(db).write({ companyId, agentId: pmId, path: "WORKERS.md", bytes: Buffer.from("Changed authorization"), baseHash: current.documentHash }, actor)).rejects.toThrow("managed worker table");
  });
  it("rolls policy back on a projection failure and fences a partially written file", async () => {
    const svc = pmWorkerPolicyService(db), before = await svc.read(companyId, pmId, actor);
    const changed = structuredClone(policy); changed.workers[0]!.selections[0]!.thinking = "low";
    const original = instructionFiles.materializeInstructionBytes;
    const fault = vi.spyOn(instructionFiles, "materializeInstructionBytes").mockImplementationOnce(async (...args) => { await original(...args); throw new Error("Injected projection failure"); });
    try { await expect(svc.save(companyId, pmId, { policy: changed, baseRevision: before.revision, baseHash: before.documentHash }, actor)).rejects.toThrow("Injected"); }
    finally { fault.mockRestore(); }
    expect((await readAgent()).runtimeConfig?.pmDelegation).toEqual(policy);
    await expect(assertPmDispatch(db, await scope(), { projectId })).rejects.toThrow("out of sync");
    const repair = await svc.read(companyId, pmId, actor);
    expect(repair.warnings).toContainEqual(expect.stringContaining("out of sync"));
    await svc.save(companyId, pmId, { policy, baseRevision: repair.revision, baseHash: repair.documentHash }, actor);
    await expect(assertPmDispatch(db, await scope(), { projectId })).resolves.toMatchObject({ assigneeAgentId: workerId });
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
});
