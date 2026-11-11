import { execFile as execFileCallback } from "node:child_process";
import { promisify } from "node:util";
import { mkdtemp, mkdir, symlink, rm, writeFile, readFile, access } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { beforeAll, afterAll, it, expect, vi } from "vitest";
import { companies, agents, projects, projectWorkspaces, issues, heartbeatRuns, agentInstructionWorkingCopies,
  createDb, startEmbeddedPostgresTestDatabase } from "@paperclipai/db";
import { claimSharedCheckout, sharedCheckoutPath } from "./shared-checkout.js";

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
  await db.insert(companies).values({ id: companyId, name: "Exclusive checkout", issuePrefix: `C${companyId.slice(0,8)}` });
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

it("admits a non-Git document directory and serializes aliased writers without initializing Git", async () => {
  const [a,b] = await fixture(false); await writeFile(join(a.cwd, "slides.pptx"), "existing presentation");
  const alias = `${a.cwd}-alias`; await symlink(a.cwd, alias); b.cwd = alias;
  const results = await Promise.allSettled([claimSharedCheckout(db,a), claimSharedCheckout(db,b)]);
  expect(results.filter(r=>r.status === "fulfilled")).toHaveLength(1);
  expect((results.find(r=>r.status === "rejected") as PromiseRejectedResult).reason).toMatchObject({ code: "workspace_busy" });
  expect(await readFile(join(a.cwd, "slides.pptx"), "utf8")).toBe("existing presentation");
  await expect(access(join(a.cwd, ".git"))).rejects.toMatchObject({ code: "ENOENT" });
});

it.each([false,true])("serializes overlapping document directories (parent first: %s)", async parentFirst => {
  const [a,b] = await fixture(false); const child = join(a.cwd, "reports"); await mkdir(child);
  if (parentFirst) b.cwd = child; else a.cwd = child;
  await claimSharedCheckout(db,a);
  await expect(claimSharedCheckout(db,b)).rejects.toMatchObject({ code: "workspace_busy" });
});

it("admits only one racing parent/child writer while independent directories remain available", async () => {
  const [a,b] = await fixture(false); b.cwd = join(a.cwd,"reports"); await mkdir(b.cwd);
  const results = await Promise.allSettled([claimSharedCheckout(db,a),claimSharedCheckout(db,b)]);
  expect(results.filter(r=>r.status==="fulfilled")).toHaveLength(1);
  expect((results.find(r=>r.status==="rejected") as PromiseRejectedResult).reason).toMatchObject({ code:"workspace_busy" });
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
    .rejects.toMatchObject({ code: "workspace_busy" });
  await db.update(heartbeatRuns).set({ status: "succeeded", finishedAt: new Date() })
    .where(eq(heartbeatRuns.id, a.runId));
  await expect(claimSharedCheckout(db, { ...b, remoteHostId: remote ? "test-remote" : null }))
    .resolves.toMatchObject({ path: b.cwd });
});

it("does not reinterpret broken Git metadata as an ordinary directory", async () => {
  const [a] = await fixture(false); await mkdir(join(a.cwd,".git"));
  await expect(claimSharedCheckout(db,a)).rejects.toThrow();
  expect((await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id,a.runId)))[0]?.contextSnapshot?.sharedCheckoutClaim).toBeUndefined();
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

it("still rejects damaged ancestor repository metadata", async () => {
  const [a] = await fixture(false), parent = a.cwd;
  await mkdir(join(parent,".git")); await writeFile(join(parent,".git","HEAD"),"broken\n");
  a.cwd = join(parent,"documents"); await mkdir(a.cwd);
  await expect(claimSharedCheckout(db,a)).rejects.toThrow();
});

it("admits a resident root with only .git/info/exclude without Git and keeps overlapping writers fenced", async () => {
  const [a,b] = await fixture(false);
  await mkdir(join(a.cwd,".git","info"),{ recursive:true });
  await writeFile(join(a.cwd,".git","info","exclude"),"private-files\n");
  b.cwd = join(a.cwd,"documents"); await mkdir(b.cwd);
  vi.stubEnv("PATH",join(root,"no-executables"));
  try {
    await expect(claimSharedCheckout(db,{ ...a, checkSourceHandoff:false })).resolves.toMatchObject({ path:a.cwd, kind:"directory" });
    await expect(claimSharedCheckout(db,b)).rejects.toMatchObject({ code:"workspace_busy" });
    await expect(claimSharedCheckout(db,{ ...a, requireGit:true })).rejects.toMatchObject({ resultJson:{ workspaceValidation:{ reason:"shared_workspace_git_required" } } });
  } finally { vi.unstubAllEnvs(); }
  expect(await readFile(join(a.cwd,".git","info","exclude"),"utf8")).toBe("private-files\n");
});

it.each(["HEAD","config","objects","refs","unexpected"])("does not classify local ignore metadata plus %s as an ignore-only directory", async marker => {
  const [a] = await fixture(false);
  await mkdir(join(a.cwd,".git","info"),{ recursive:true });
  await writeFile(join(a.cwd,".git","info","exclude"),"private-files\n");
  await writeFile(join(a.cwd,".git",marker),"broken\n");
  await expect(claimSharedCheckout(db,a)).rejects.toThrow();
});

it("does not require a Git executable for ordinary directories", async () => {
  const [a] = await fixture(false); vi.stubEnv("PATH", join(root,"no-executables"));
  try { await expect(claimSharedCheckout(db,a)).resolves.toMatchObject({ path:a.cwd, kind:"directory" }); }
  finally { vi.unstubAllEnvs(); }
});

it("retains an explicit Git source requirement", async () => {
  const [a] = await fixture(false);
  await expect(claimSharedCheckout(db,{ ...a, requireGit:true })).rejects.toMatchObject({ resultJson:{ workspaceValidation:{ reason:"shared_workspace_git_required" } } });
});

it("retains unsaved Git changes until the same task owns them", async () => {
  const [a,b] = await fixture(); await claimSharedCheckout(db,a);
  await writeFile(join(a.cwd,"draft.txt"),"uncommitted");
  await db.update(heartbeatRuns).set({ status:"succeeded", finishedAt:new Date() }).where(eq(heartbeatRuns.id,a.runId));
  await expect(claimSharedCheckout(db,b)).rejects.toMatchObject({ resultJson:{ workspaceValidation:{ reason:"shared_checkout_unsaved_changes", dirtyFiles:{ paths:["draft.txt"], count:1, truncated:false }, previousIssueId:a.issueId } } });
  await expect(claimSharedCheckout(db,{ ...b, issueId:a.issueId })).resolves.toMatchObject({ path:a.cwd });
});

it("admits one simultaneous writer across aliased paths and different tasks", async () => {
  const [a,b] = await fixture(); const alias = `${a.cwd}-alias`; await symlink(a.cwd, alias); b.cwd = alias;
  await mkdir(join(a.cwd, "sub")); expect(await sharedCheckoutPath(join(alias,"sub"))).toBe(a.cwd);
  const results = await Promise.allSettled([claimSharedCheckout(db,a), claimSharedCheckout(db,b)]);
  for (const result of results) if (result.status === "rejected" && result.reason?.code !== "workspace_busy") throw result.reason;
  expect(results.filter(r=>r.status === "fulfilled")).toHaveLength(1);
  expect((results.find(r=>r.status === "rejected") as PromiseRejectedResult).reason).toMatchObject({ code: "workspace_busy" });
});

it.each([false,true])("keeps a silent writer and a terminal provider with unknown stop evidence fenced (Git: %s)", async git => {
  const [a,b] = await fixture(git); await claimSharedCheckout(db,a);
  await db.update(heartbeatRuns).set({ startedAt: new Date(0), lastOutputAt: new Date(0), processPid: 12345 }).where(eq(heartbeatRuns.id,a.runId));
  await expect(claimSharedCheckout(db,b)).rejects.toMatchObject({ code: "workspace_busy" });
  await db.update(heartbeatRuns).set({ status: "failed", finishedAt: new Date() }).where(eq(heartbeatRuns.id,a.runId));
  await expect(claimSharedCheckout(db,b)).rejects.toMatchObject({ code: "workspace_busy" });
});

it("releases a terminal pre-provider admission without replaying the old task", async () => {
  const [a,b] = await fixture(); await claimSharedCheckout(db,a);
  await db.update(heartbeatRuns).set({ status: "failed", finishedAt: new Date() }).where(eq(heartbeatRuns.id,a.runId));
  await expect(claimSharedCheckout(db,b)).resolves.toMatchObject({ path:a.cwd, issueId:b.issueId });
  expect((await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id,a.runId)))[0]?.status).toBe("failed");
});

it.each(["cancelled", "timed_out"])("does not treat missing historical adapter metadata as stop proof for %s", async status => {
  const [a, b] = await fixture(false);
  await claimSharedCheckout(db, a);
  await db.update(heartbeatRuns).set({ status, finishedAt: new Date(), processPid: 12345,
    runnerProfileJson: null, resultJson: null }).where(eq(heartbeatRuns.id, a.runId));
  await expect(claimSharedCheckout(db, b)).rejects.toMatchObject({ code: "workspace_busy" });
});

it("does not infer pre-provider safety from missing events when Bridge identity was recorded", async () => {
  const [a,b] = await fixture(); await claimSharedCheckout(db,a);
  await db.update(heartbeatRuns).set({ status: "failed", finishedAt: new Date(),
    resultJson: { nativeSessionId: "original-native-thread", bridgeSessionId: "original-card" },
  }).where(eq(heartbeatRuns.id,a.runId));
  await expect(claimSharedCheckout(db,b)).rejects.toMatchObject({ code: "workspace_busy" });
});

it.each([false,true])("requires a retained process-stop receipt before another writer starts (Git: %s)", async git => {
  const [a,b] = await fixture(git); await claimSharedCheckout(db,a);
  await db.update(heartbeatRuns).set({ status: "succeeded", finishedAt: new Date(), processPid:12345 }).where(eq(heartbeatRuns.id,a.runId));
  await db.insert(agentInstructionWorkingCopies).values({ runId:a.runId, companyId:a.companyId, agentId:a.agentId,
    responsibleUserId:"test-owner", entryFile:"AGENTS.md", baseHash:"a".repeat(64), localRoot:a.cwd, executionRoot:a.cwd,
    location:"local", state:"captured", receipt:{}, processStoppedAt:new Date() });
  await expect(claimSharedCheckout(db,b)).resolves.toMatchObject({ path:a.cwd });
});

it("keys a remote Bridge worker's claim on its host and registered path without touching the controller filesystem", async () => {
  const [a,b] = await fixture(false);
  const remotePath = "/home/yoyo/Projects/Remote_Only";
  a.cwd = remotePath; b.cwd = remotePath;
  const first = await claimSharedCheckout(db, { ...a, remoteHostId: "shopee-e", requireGit: false });
  expect(first).toMatchObject({ host: "ccpocket:shopee-e", path: remotePath, issueId: a.issueId });
  expect(first.kind).toBeUndefined();
  await expect(access(remotePath)).rejects.toMatchObject({ code: "ENOENT" });
  // A second writer on the same host and path queues; the same path on another host is an independent checkout.
  await expect(claimSharedCheckout(db, { ...b, remoteHostId: "shopee-e" })).rejects.toMatchObject({ code: "workspace_busy" });
  await expect(claimSharedCheckout(db, { ...b, remoteHostId: "shopee-d" })).resolves.toMatchObject({ host: "ccpocket:shopee-d", path: remotePath });
});

it.each(["relative/path", "/home/yoyo/../etc", "/home/yoyo/Projects/"])("rejects a non-canonical remote path %s", async remotePath => {
  const [a] = await fixture(false);
  await expect(claimSharedCheckout(db, { ...a, cwd: remotePath, remoteHostId: "shopee-e" }))
    .rejects.toMatchObject({ resultJson: { workspaceValidation: { reason: "remote_worker_path_invalid" } } });
});


it.each(["requested", "forced", "acknowledged", "live_controller"])("retains or releases a Bridge claim from stop evidence: %s", async evidence => {
  const [a,b] = await fixture(false);
  await claimSharedCheckout(db,a);
  await db.update(heartbeatRuns).set({ status: "cancelled", finishedAt: new Date(), sessionIdAfter: "native-session",
    runnerProfileJson: { adapterDispatch: { adapterType: "ccpocket_bridge" } },
    controllerLeaseExpiresAt: evidence === "live_controller" ? new Date(Date.now()+60_000) : null,
    resultJson: { executionCancellation: { state: evidence === "requested" ? "requested" : "acknowledged",
      forced: evidence === "forced", acknowledgedAt: new Date().toISOString() } },
  }).where(eq(heartbeatRuns.id,a.runId));
  if (evidence === "acknowledged") await expect(claimSharedCheckout(db,b)).resolves.toMatchObject({ path:a.cwd });
  else await expect(claimSharedCheckout(db,b)).rejects.toMatchObject({ code:"workspace_busy" });
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
    .rejects.toMatchObject({code:"workspace_busy"});
});

it("serializes separate project registrations of one physical directory", async () => {
  const [a,b] = await fixture(false);
  const [project] = await db.insert(projects).values({companyId:a.companyId,name:"Other project"}).returning();
  const [source] = await db.insert(projectWorkspaces).values({companyId:a.companyId,projectId:project.id,name:"Alias registration",cwd:a.cwd}).returning();
  b.projectWorkspaceId = source.id as typeof b.projectWorkspaceId;
  await claimSharedCheckout(db,a);
  await expect(claimSharedCheckout(db,b)).rejects.toMatchObject({code:"workspace_busy"});
});

it("queues a foreign company's overlapping writer without disclosing holder identity", async () => {
  const [a] = await fixture(false), [b] = await fixture(false);
  b.cwd = a.cwd;
  await claimSharedCheckout(db, a);
  const error = await claimSharedCheckout(db, b).catch(error => error);
  expect(error).toMatchObject({ code: "workspace_busy", discloseHolder: false });
  expect(error.message).not.toContain(a.runId);
  expect(error.message).not.toContain(a.issueId);
  expect(error.message).not.toContain(a.companyId);
});

it("keys managed workspaces by storage namespace and identity rather than guest cwd", async () => {
  const [a,b] = await fixture(false);
  const storageIdentity = {namespace:randomUUID(),workspaceRef:"workspace-one"};
  const claim = await claimSharedCheckout(db,{...a,cwd:"/workspace",storageIdentity});
  expect(claim.kind).toBe("storage");
  await expect(claimSharedCheckout(db,{...b,cwd:"/workspace",storageIdentity}))
    .rejects.toMatchObject({code:"workspace_busy"});
  await expect(claimSharedCheckout(db,{...b,cwd:"/workspace",storageIdentity:{...storageIdentity,workspaceRef:"workspace-two"}}))
    .resolves.toMatchObject({kind:"storage"});
});
