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

it("does not require a Git executable for ordinary directories", async () => {
  const [a] = await fixture(false); vi.stubEnv("PATH", join(root,"no-executables"));
  try { await expect(claimSharedCheckout(db,a)).resolves.toMatchObject({ path:a.cwd, kind:"directory" }); }
  finally { vi.unstubAllEnvs(); }
});

it("retains an explicit Git source requirement", async () => {
  const [a] = await fixture(false);
  await expect(claimSharedCheckout(db,{ ...a, requireGit:true })).rejects.toMatchObject({ resultJson:{ reason:"shared_workspace_git_required" } });
});

it("retains unsaved Git changes until the same task owns them", async () => {
  const [a,b] = await fixture(); await claimSharedCheckout(db,a);
  await writeFile(join(a.cwd,"draft.txt"),"uncommitted");
  await db.update(heartbeatRuns).set({ status:"succeeded", finishedAt:new Date() }).where(eq(heartbeatRuns.id,a.runId));
  await expect(claimSharedCheckout(db,b)).rejects.toMatchObject({ resultJson:{ reason:"shared_checkout_unsaved_changes" } });
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

it.each([false,true])("requires a retained process-stop receipt before another writer starts (Git: %s)", async git => {
  const [a,b] = await fixture(git); await claimSharedCheckout(db,a);
  await db.update(heartbeatRuns).set({ status: "succeeded", finishedAt: new Date(), processPid:12345 }).where(eq(heartbeatRuns.id,a.runId));
  await db.insert(agentInstructionWorkingCopies).values({ runId:a.runId, companyId:a.companyId, agentId:a.agentId,
    responsibleUserId:"test-owner", entryFile:"AGENTS.md", baseHash:"a".repeat(64), localRoot:a.cwd, executionRoot:a.cwd,
    location:"local", state:"captured", receipt:{}, processStoppedAt:new Date() });
  await expect(claimSharedCheckout(db,b)).resolves.toMatchObject({ path:a.cwd });
});
