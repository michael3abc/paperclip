import { execFile as execFileCallback } from "node:child_process";
import { promisify } from "node:util";
import { mkdtemp, mkdir, symlink, rm, writeFile, readFile, access } from "node:fs/promises";
import { tmpdir, hostname } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { and, eq } from "drizzle-orm";
import { beforeAll, afterAll, it, expect, vi } from "vitest";
import { companies, agents, projects, projectWorkspaces, issues, heartbeatRuns, agentInstructionWorkingCopies,
  heartbeatRunEvents, nativeRunFinalizations, createDb, startEmbeddedPostgresTestDatabase } from "@paperclipai/db";
import { claimSharedCheckout, sharedCheckoutHolderSettled, sharedCheckoutPath, unsettledWorkspaceHolders } from "./shared-checkout.js";
import { runChildProcess } from "../../adapters/utils.js";
import { persistHeartbeatRunProcessMetadata } from "./run-lifecycle.js";
import { recordLegacyLocalProcessStop } from "./process-settlement.js";

const execFile = promisify(execFileCallback);
let database: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>>;
let db: ReturnType<typeof createDb>, root: string;
beforeAll(async () => {
  database = await startEmbeddedPostgresTestDatabase("shared-checkout-"); db = createDb(database.connectionString);
  root = await mkdtemp(join(tmpdir(), "shared-checkout-"));
}, 60_000);
afterAll(async () => { await db?.$client.end({ timeout: 1 }); await database?.cleanup(); if(root) await rm(root, { recursive: true, force: true }); });

async function fixture(git = true) {
  const companyId = randomUUID(), agentId = randomUUID(), projectId = randomUUID(), projectWorkspaceId = randomUUID();
  const cwd = join(root, projectId); await mkdir(cwd); if (git) await execFile("git", ["init", "--initial-branch=main", cwd]);
  await db.insert(companies).values({ id: companyId, name: "Cooperative checkout", issuePrefix: `C${companyId.slice(0,8)}` });
  await db.insert(agents).values({ id: agentId, companyId, name: "Writer", adapterType: "process" });
  await db.insert(projects).values({ id: projectId, companyId, name: "Project" });
  await db.insert(projectWorkspaces).values({ id: projectWorkspaceId, companyId, projectId, cwd, name: "Development" });
  const inputs = [];
  for (let i = 0; i < 2; i++) {
    const issueId = randomUUID(), runId = randomUUID();
    await db.insert(issues).values({ id: issueId, companyId, projectId, projectWorkspaceId, title: `Writer ${i}` });
    await db.insert(heartbeatRuns).values({ id: runId, companyId, agentId, issueId, status: "running", runtimeMode: "legacy" });
    inputs.push({ companyId, agentId, projectWorkspaceId, issueId, runId, cwd, context: {} as Record<string, unknown>, deferralAttempt: 0 });
  }
  return inputs as [typeof inputs[number], typeof inputs[number]];
}

// Liveness-first: only non-terminal runs hold a directory for retirement.
async function retirementEligible(input: { cwd: string; runId: string }) {
  return (await unsettledWorkspaceHolders(db, { host: hostname(), path: await sharedCheckoutPath(input.cwd),
    remote: false, excludeRunId: input.runId })).length === 0;
}

it("admits a non-Git document directory and admits aliased participants without initializing Git", async () => {
  const [a,b] = await fixture(false); await writeFile(join(a.cwd, "slides.pptx"), "existing presentation");
  const alias = `${a.cwd}-alias`; await symlink(a.cwd, alias); b.cwd = alias;
  const results = await Promise.allSettled([claimSharedCheckout(db,a), claimSharedCheckout(db,b)]);
  expect(results.filter(r=>r.status === "fulfilled")).toHaveLength(2);
  expect(await readFile(join(a.cwd, "slides.pptx"), "utf8")).toBe("existing presentation");
  await expect(access(join(a.cwd, ".git"))).rejects.toMatchObject({ code: "ENOENT" });
});

it.each([false,true])("admits overlapping external-resource directories (parent first: %s)", async parentFirst => {
  const [a,b] = await fixture(false); const child = join(a.cwd, "reports"); await mkdir(child);
  if (parentFirst) b.cwd = child; else a.cwd = child;
  await claimSharedCheckout(db,a);
  await expect(claimSharedCheckout(db,b)).resolves.toBeDefined();
});

it("admits racing parent/child participants while independent directories remain available", async () => {
  const [a,b] = await fixture(false); b.cwd = join(a.cwd,"reports"); await mkdir(b.cwd);
  const results = await Promise.allSettled([claimSharedCheckout(db,a),claimSharedCheckout(db,b)]);
  expect(results.filter(r=>r.status==="fulfilled")).toHaveLength(2);
  const [independent] = await fixture(false);
  await expect(claimSharedCheckout(db,independent)).resolves.toMatchObject({ path:independent.cwd });
});

it("allows settled document ownership to pass without deleting prior output", async () => {
  const [a,b] = await fixture(false); await claimSharedCheckout(db,a);
  await writeFile(join(a.cwd,"draft.txt"), "preserved draft");
  await db.update(heartbeatRuns).set({ status: "succeeded", finishedAt: new Date() }).where(eq(heartbeatRuns.id,a.runId));
  await expect(claimSharedCheckout(db,b)).resolves.toMatchObject({ path:a.cwd });
  expect(await readFile(join(a.cwd,"draft.txt"),"utf8")).toBe("preserved draft");
});

it.each([false, true])("preserves an admitted run without a claim during upgrade (remote: %s)", async remote => {
  const [a, b] = await fixture(false);
  const alias = a.cwd + "-legacy";
  if (!remote) await symlink(a.cwd, alias);
  const workspace = { cwd: remote ? a.cwd : alias, workspaceId: a.projectWorkspaceId,
    ...(remote ? { remoteHostId: "test-remote" } : {}) };
  await db.update(heartbeatRuns).set({ contextSnapshot: { paperclipWorkspace: workspace } })
    .where(eq(heartbeatRuns.id, a.runId));
  await expect(claimSharedCheckout(db, { ...b, remoteHostId: remote ? "test-remote" : null }))
    .resolves.toBeDefined();
  await db.update(heartbeatRuns).set({ status: "succeeded", finishedAt: new Date() })
    .where(eq(heartbeatRuns.id, a.runId));
  await expect(claimSharedCheckout(db, { ...b, remoteHostId: remote ? "test-remote" : null }))
    .resolves.toMatchObject({ path: b.cwd });
});

it("grants a directory with broken Git metadata, recording the mismatch without repairing Git", async () => {
  const [a] = await fixture(false); await mkdir(join(a.cwd,".git"));
  await expect(claimSharedCheckout(db,a)).resolves.toMatchObject({ path:a.cwd, kind:"directory", mismatches:[expect.any(String)] });
  expect((await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id,a.runId)))[0]?.contextSnapshot?.sharedCheckoutClaim)
    .toMatchObject({ path:a.cwd, executionCwd:a.cwd });
  await expect(access(join(a.cwd,".git","HEAD"))).rejects.toMatchObject({ code: "ENOENT" });
});

it.each([false, true])("retains a damaged historical checkout's scope without breaking independent admissions (alias: %s)", async alias => {
  const [a] = await fixture(false), [b] = await fixture(false), [independent] = await fixture(false);
  await mkdir(join(a.cwd, ".git"));
  const oldCwd = alias ? a.cwd + "-alias" : a.cwd;
  if (alias) await symlink(a.cwd, oldCwd);
  await db.update(heartbeatRuns).set({ status: "failed", finishedAt: new Date(), processPid: 12345,
    contextSnapshot: { paperclipWorkspace: { cwd: oldCwd, workspaceId: a.projectWorkspaceId } },
  }).where(eq(heartbeatRuns.id, a.runId));
  b.cwd = join(a.cwd, "independent-repository"); await mkdir(b.cwd);
  await execFile("git", ["init", "--initial-branch=main", b.cwd]);
  await expect(claimSharedCheckout(db,b)).resolves.toBeDefined();
  await expect(claimSharedCheckout(db, independent)).resolves.toMatchObject({ path: independent.cwd });
  await expect(access(join(a.cwd, ".git"))).resolves.toBeUndefined();
  expect((await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, a.runId)))[0]?.contextSnapshot)
    .toEqual({ paperclipWorkspace: { cwd: oldCwd, workspaceId: a.projectWorkspaceId } });
});

it("ignores ancestor ignore-only .git directories without requiring Git", async () => {
  const [a] = await fixture(false), parent = a.cwd;
  await mkdir(join(parent,".git","info"),{ recursive:true });
  await writeFile(join(parent,".git","info","exclude"),"private-files\n");
  a.cwd = join(parent,"documents"); await mkdir(a.cwd);
  vi.stubEnv("PATH",join(root,"no-executables"));
  try { await expect(claimSharedCheckout(db,a)).resolves.toMatchObject({ path:a.cwd, kind:"directory" }); }
  finally { vi.unstubAllEnvs(); }
  expect(await readFile(join(parent,".git","info","exclude"),"utf8")).toBe("private-files\n");
});

it("grants below damaged ancestor repository metadata and only logs the mismatch", async () => {
  const [a] = await fixture(false), parent = a.cwd;
  await mkdir(join(parent,".git")); await writeFile(join(parent,".git","HEAD"),"broken\n");
  a.cwd = join(parent,"documents"); await mkdir(a.cwd);
  await expect(claimSharedCheckout(db,a)).resolves.toMatchObject({ path:a.cwd, kind:"directory", mismatches:[expect.any(String)] });
  expect(await readFile(join(parent,".git","HEAD"),"utf8")).toBe("broken\n");
});

it("admits a resident root with only .git/info/exclude without Git and does not turn it into recursive ownership", async () => {
  const [a,b] = await fixture(false);
  await mkdir(join(a.cwd,".git","info"),{ recursive:true });
  await writeFile(join(a.cwd,".git","info","exclude"),"private-files\n");
  b.cwd = join(a.cwd,"documents"); await mkdir(b.cwd);
  vi.stubEnv("PATH",join(root,"no-executables"));
  try {
    await expect(claimSharedCheckout(db,{ ...a, checkSourceHandoff:false })).resolves.toMatchObject({ path:a.cwd, kind:"directory" });
    await expect(claimSharedCheckout(db,b)).resolves.toBeDefined();
    await expect(claimSharedCheckout(db,{ ...a, requireGit:true })).resolves.toMatchObject({ kind:"directory", mismatches:["shared_workspace_git_required"] });
  } finally { vi.unstubAllEnvs(); }
  expect(await readFile(join(a.cwd,".git","info","exclude"),"utf8")).toBe("private-files\n");
});

it.each(["HEAD","config","objects","refs","unexpected"])("does not classify local ignore metadata plus %s as ignore-only, yet still grants the directory", async marker => {
  const [a] = await fixture(false);
  await mkdir(join(a.cwd,".git","info"),{ recursive:true });
  await writeFile(join(a.cwd,".git","info","exclude"),"private-files\n");
  await writeFile(join(a.cwd,".git",marker),"broken\n");
  await expect(claimSharedCheckout(db,a)).resolves.toMatchObject({ path:a.cwd, kind:"directory", mismatches:[expect.any(String)] });
  expect(await readFile(join(a.cwd,".git",marker),"utf8")).toBe("broken\n");
});

it("does not require a Git executable for ordinary directories", async () => {
  const [a] = await fixture(false); vi.stubEnv("PATH", join(root,"no-executables"));
  try { await expect(claimSharedCheckout(db,a)).resolves.toMatchObject({ path:a.cwd, kind:"directory" }); }
  finally { vi.unstubAllEnvs(); }
});

it("logs an unmet Git source expectation instead of refusing the directory", async () => {
  const [a,b] = await fixture(false);
  await expect(claimSharedCheckout(db,{ ...a, requireGit:true })).resolves.toMatchObject({ path:a.cwd, kind:"directory",
    mismatches:["shared_workspace_git_required"] });
  await expect(access(join(a.cwd,".git"))).rejects.toMatchObject({ code: "ENOENT" });
  const [git] = await fixture(true);
  await expect(claimSharedCheckout(db,{ ...git, requireGit:true })).resolves.not.toHaveProperty("mismatches");
  // A missing directory is recorded too; workspace preparation creates it (mkdir -p).
  await expect(claimSharedCheckout(db,{ ...b, cwd:join(b.cwd,"not-created-yet") })).resolves.toMatchObject({
    path:join(b.cwd,"not-created-yet"), kind:"directory" });
});

it("never refuses when the run already left running; the display record is simply not written", async () => {
  const [a] = await fixture(false);
  await db.update(heartbeatRuns).set({ status: "cancelled", finishedAt: new Date() }).where(eq(heartbeatRuns.id,a.runId));
  await expect(claimSharedCheckout(db,a)).resolves.toMatchObject({ path:a.cwd });
  expect((await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id,a.runId)))[0]?.contextSnapshot?.sharedCheckoutClaim).toBeUndefined();
});

it("preserves collaborator changes while admitting a different task", async () => {
  const [a,b] = await fixture(); await claimSharedCheckout(db,a);
  await writeFile(join(a.cwd,"draft.txt"),"uncommitted");
  await db.update(heartbeatRuns).set({ status:"succeeded", finishedAt:new Date() }).where(eq(heartbeatRuns.id,a.runId));
  await expect(claimSharedCheckout(db,b)).resolves.toMatchObject({ path:a.cwd });
  expect(await readFile(join(a.cwd,"draft.txt"),"utf8")).toBe("uncommitted");
  await expect(claimSharedCheckout(db,{ ...b, issueId:a.issueId })).resolves.toMatchObject({ path:a.cwd });
});

it("admits simultaneous participants across aliases and tasks", async () => {
  const [a,b] = await fixture(); const alias = `${a.cwd}-alias`; await symlink(a.cwd, alias); b.cwd = alias;
  await mkdir(join(a.cwd, "sub")); expect(await sharedCheckoutPath(join(alias,"sub"))).toBe(a.cwd);
  const results = await Promise.allSettled([claimSharedCheckout(db,a), claimSharedCheckout(db,b)]);
  expect(results.filter(r=>r.status === "fulfilled")).toHaveLength(2);
});

it.each([false,true])("keeps a live run as a holder and releases it at its terminal status, without stop evidence (Git: %s)", async git => {
  const [a,b] = await fixture(git); await claimSharedCheckout(db,a); await claimSharedCheckout(db,b);
  await db.update(heartbeatRuns).set({ startedAt: new Date(0), lastOutputAt: new Date(0), processPid: 12345 }).where(eq(heartbeatRuns.id,a.runId));
  await expect(retirementEligible(b)).resolves.toBe(false);
  await db.update(heartbeatRuns).set({ status: "failed", finishedAt: new Date() }).where(eq(heartbeatRuns.id,a.runId));
  await expect(retirementEligible(b)).resolves.toBe(true);
  expect(await sharedCheckoutHolderSettled(db, a.companyId, a.runId)).toBe(true);
});

it("releases a terminal pre-provider admission without replaying the old task", async () => {
  const [a,b] = await fixture(); await claimSharedCheckout(db,a); await claimSharedCheckout(db,b);
  await db.update(heartbeatRuns).set({ status: "failed", finishedAt: new Date() }).where(eq(heartbeatRuns.id,a.runId));
  await expect(retirementEligible(b)).resolves.toBe(true);
  expect((await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id,a.runId)))[0]?.status).toBe("failed");
});

it.each(["cancelled", "timed_out"])("releases a %s holder without historical adapter metadata or stop proof", async status => {
  const [a, b] = await fixture(false);
  await claimSharedCheckout(db, a); await claimSharedCheckout(db, b);
  await db.update(heartbeatRuns).set({ status, finishedAt: new Date(), processPid: 12345,
    runnerProfileJson: null, resultJson: null }).where(eq(heartbeatRuns.id, a.runId));
  await expect(retirementEligible(b)).resolves.toBe(true);
});

it("releases a terminal Bridge holder whose identity was recorded, without a stop receipt", async () => {
  const [a,b] = await fixture(); await claimSharedCheckout(db,a); await claimSharedCheckout(db,b);
  await db.update(heartbeatRuns).set({ status: "failed", finishedAt: new Date(),
    resultJson: { nativeSessionId: "original-native-thread", bridgeSessionId: "original-card" },
  }).where(eq(heartbeatRuns.id,a.runId));
  await expect(retirementEligible(b)).resolves.toBe(true);
});

it.each([false,true])("does not wait for instruction cleanup receipts before retirement (Git: %s)", async git => {
  const [a,b] = await fixture(git); await claimSharedCheckout(db,a); await claimSharedCheckout(db,b);
  await db.update(heartbeatRuns).set({ status: "succeeded", finishedAt: new Date(), processPid:12345 }).where(eq(heartbeatRuns.id,a.runId));
  await db.insert(agentInstructionWorkingCopies).values({ runId:a.runId, companyId:a.companyId, agentId:a.agentId,
    responsibleUserId:"test-owner", entryFile:"AGENTS.md", baseHash:"a".repeat(64), localRoot:a.cwd, executionRoot:a.cwd,
    location:"local", state:"captured", receipt:{}, processStoppedAt:new Date() });
  await expect(retirementEligible(b)).resolves.toBe(true);
  // The pending copy is retained untouched for its own background collector.
  expect((await db.select().from(agentInstructionWorkingCopies).where(eq(agentInstructionWorkingCopies.runId, a.runId)))[0])
    .toMatchObject({ state: "captured" });
});

it("releases a terminal local-process holder at once and still records its bound stop receipt in the background", async () => {
  const [a, b] = await fixture(false); await claimSharedCheckout(db, a); await claimSharedCheckout(db, b);
  await runChildProcess(a.runId, process.execPath, ["-e", "console.log('settled-process')"], {
    cwd: a.cwd, env: {}, timeoutSec: 5, graceSec: 1, onLog: async () => {},
    onSpawn: async meta => { await persistHeartbeatRunProcessMetadata(db, a.runId, meta); },
  });
  await db.update(heartbeatRuns).set({ status: "succeeded", finishedAt: new Date() }).where(eq(heartbeatRuns.id, a.runId));
  await expect(retirementEligible(b)).resolves.toBe(true);
  expect(await recordLegacyLocalProcessStop(db, a.runId, a.companyId)).toBe(true);
  expect(await recordLegacyLocalProcessStop(db, a.runId, a.companyId)).toBe(false);
  expect(await db.select().from(agentInstructionWorkingCopies).where(eq(agentInstructionWorkingCopies.runId, a.runId))).toEqual([]);
  expect(await db.select().from(heartbeatRunEvents).where(and(eq(heartbeatRunEvents.runId, a.runId),
    eq(heartbeatRunEvents.eventType, "execution.local_process_stopped")))).toHaveLength(1);
  await expect(retirementEligible(b)).resolves.toBe(true);
});

it.each(["settled", "unknown_stop", "pending_files", "cleanup_pending", "retained_copy",
  "finalizer_owner", "retry_pending", "resuming_session", "restore_failure", "restore_recovery"])(
  "a terminal holder releases retirement while its own stop and file records are kept: %s", async state => {
    const [a, b] = await fixture(false); await claimSharedCheckout(db, a); await claimSharedCheckout(db, b);
    await writeFile(join(a.cwd, "original.txt"), "preserved result");
    await db.update(heartbeatRuns).set({ status: "failed", finishedAt: new Date(), runtimeMode: "native",
      nativeIssueId: a.issueId, processPid: 12345,
      ...(state === "restore_failure" ? { resultJson: { workspaceRestoreFailure: "restore_failed" } } : {}),
      ...(state === "restore_recovery" ? { resultJson: { workspaceRestoreRecovery: { schema: "paperclip.workspace-restore-recovery.v1" } } } : {}),
    }).where(eq(heartbeatRuns.id, a.runId));
    await db.insert(nativeRunFinalizations).values({ runId: a.runId, companyId: a.companyId, issueId: a.issueId,
      phase: "terminal_failure", failureCode: "native_session_interrupted",
      recoveryState: state === "resuming_session" ? "resuming_session" : "blocked",
      leaseOwner: state === "finalizer_owner" ? "original-finalizer" : null,
      nextAttemptAt: state === "retry_pending" ? new Date() : null,
    });
    await db.insert(agentInstructionWorkingCopies).values({ runId: a.runId, companyId: a.companyId, agentId: a.agentId,
      responsibleUserId: "test-owner", entryFile: "AGENTS.md", baseHash: "a".repeat(64),
      localRoot: a.cwd, executionRoot: a.cwd, location: "local",
      state: state === "pending_files" ? "pending_collection" : "unchanged",
      processStoppedAt: state === "unknown_stop" ? null : new Date(),
      receipt: { cleanupPending: state === "cleanup_pending",
        ...(state === "retained_copy" ? { retainedByRunId: b.runId } : {}) },
    });
    await expect(retirementEligible(b)).resolves.toBe(true);
    expect((await db.select().from(nativeRunFinalizations).where(eq(nativeRunFinalizations.runId, a.runId)))[0])
      .toMatchObject({ phase: "terminal_failure", failureCode: "native_session_interrupted" });
    expect(await readFile(join(a.cwd, "original.txt"), "utf8")).toBe("preserved result");
  },
);

it("keys a remote Bridge worker's claim on its host and registered path without touching the controller filesystem", async () => {
  const [a,b] = await fixture(false);
  const remotePath = "/home/yoyo/Projects/Remote_Only";
  a.cwd = remotePath; b.cwd = remotePath;
  const first = await claimSharedCheckout(db, { ...a, remoteHostId: "shopee-e", requireGit: false });
  expect(first).toMatchObject({ host: "ccpocket:shopee-e", path: remotePath, issueId: a.issueId });
  expect(first.kind).toBeUndefined();
  await expect(access(remotePath)).rejects.toMatchObject({ code: "ENOENT" });
  // Both same-host and other-host participants are admitted; host identity is retained.
  await expect(claimSharedCheckout(db, { ...b, remoteHostId: "shopee-e" })).resolves.toBeDefined();
  await expect(claimSharedCheckout(db, { ...b, remoteHostId: "shopee-d" })).resolves.toMatchObject({ host: "ccpocket:shopee-d", path: remotePath });
});

it.each(["relative/path", "/home/yoyo/../etc", "/home/yoyo/Projects/"])("records a non-canonical remote path %s as a mismatch only", async remotePath => {
  const [a] = await fixture(false);
  await expect(claimSharedCheckout(db, { ...a, cwd: remotePath, remoteHostId: "shopee-e" }))
    .resolves.toMatchObject({ host: "ccpocket:shopee-e", path: remotePath, mismatches: ["remote_worker_path_invalid"] });
});


it.each(["requested", "forced", "acknowledged", "live_controller"])("admits a successor and releases retirement immediately after cancellation: %s", async evidence => {
  const [a,b] = await fixture(false);
  await claimSharedCheckout(db,a);
  await db.update(heartbeatRuns).set({ status: "cancelled", finishedAt: new Date(), sessionIdAfter: "native-session",
    runnerProfileJson: { adapterDispatch: { adapterType: "ccpocket_bridge" } },
    controllerLeaseExpiresAt: evidence === "live_controller" ? new Date(Date.now()+60_000) : null,
    resultJson: { executionCancellation: { state: evidence === "requested" ? "requested" : "acknowledged",
      forced: evidence === "forced", acknowledgedAt: new Date().toISOString() } },
  }).where(eq(heartbeatRuns.id,a.runId));
  await expect(claimSharedCheckout(db,b)).resolves.toMatchObject({ path:a.cwd });
  await expect(retirementEligible(b)).resolves.toBe(true);
});

it("admits sibling worktrees of the same Git repository concurrently", async () => {
  const [a,b] = await fixture();
  await execFile("git", ["-C",a.cwd,"-c","user.name=Test","-c","user.email=test@example.com","commit","--allow-empty","-m","base"]);
  const source = a.cwd;
  a.cwd = source + "-one"; b.cwd = source + "-two";
  await execFile("git", ["-C",source,"worktree","add","-b","one",a.cwd]);
  await execFile("git", ["-C",source,"worktree","add","-b","two",b.cwd]);
  const claims = await Promise.all([claimSharedCheckout(db,a),claimSharedCheckout(db,b)]);
  expect(claims.map(c=>c.path)).toEqual([a.cwd,b.cwd]);
  expect((await execFile("git",["-C",a.cwd,"rev-parse","--git-common-dir"])).stdout)
    .toBe((await execFile("git",["-C",b.cwd,"rev-parse","--git-common-dir"])).stdout);
});

it("reserves a new worktree target without claiming its source or hiding a parent writer", async () => {
  const [a,b] = await fixture(false);
  const source = a.cwd;
  a.cwd = source + "-new";
  await expect(claimSharedCheckout(db,{...a,preparingWorktree:true})).resolves.toMatchObject({path:a.cwd});
  await expect(claimSharedCheckout(db,b)).resolves.toMatchObject({path:source});
  await expect(claimSharedCheckout(db,{...a,cwd:join(source,"child"),preparingWorktree:true}))
    .resolves.toBeDefined();
});

it("records independent participants for authorized registrations of one physical directory", async () => {
  const [a,b] = await fixture(false);
  const [project] = await db.insert(projects).values({companyId:a.companyId,name:"Other project"}).returning();
  const [source] = await db.insert(projectWorkspaces).values({companyId:a.companyId,projectId:project.id,name:"Alias registration",cwd:a.cwd}).returning();
  b.projectWorkspaceId = source.id as typeof b.projectWorkspaceId;
  await claimSharedCheckout(db,a);
  await expect(claimSharedCheckout(db,b)).resolves.toBeDefined();
});

it("does not disclose another company through a physical-path receipt", async () => {
  const [a] = await fixture(false), [b] = await fixture(false);
  b.cwd = a.cwd;
  await claimSharedCheckout(db, a);
  const receipt = await claimSharedCheckout(db, b);
  expect(JSON.stringify(receipt)).not.toContain(a.runId);
  expect(JSON.stringify(receipt)).not.toContain(a.issueId);
  expect(JSON.stringify(receipt)).not.toContain(a.companyId);
});

it("keys managed workspaces by storage namespace and identity rather than guest cwd", async () => {
  const [a,b] = await fixture(false);
  const storageIdentity = {namespace:randomUUID(),workspaceRef:"workspace-one"};
  const claim = await claimSharedCheckout(db,{...a,cwd:"/workspace",storageIdentity});
  expect(claim.kind).toBe("storage");
  await expect(claimSharedCheckout(db,{...b,cwd:"/workspace",storageIdentity}))
    .resolves.toBeDefined();
  await expect(claimSharedCheckout(db,{...b,cwd:"/workspace",storageIdentity:{...storageIdentity,workspaceRef:"workspace-two"}}))
    .resolves.toMatchObject({kind:"storage"});
});
