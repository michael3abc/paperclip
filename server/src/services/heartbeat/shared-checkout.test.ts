import { execFile as execFileCallback } from "node:child_process";
import { promisify } from "node:util";
import { mkdtemp, mkdir, symlink, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { beforeAll, afterAll, it, expect } from "vitest";
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

async function fixture() {
  const companyId = randomUUID(), agentId = randomUUID(), projectId = randomUUID(), projectWorkspaceId = randomUUID();
  const cwd = join(root, projectId); await mkdir(cwd); await execFile("git", ["init", "--initial-branch=main", cwd]);
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

it("admits one simultaneous writer across aliased paths and different tasks", async () => {
  const [a,b] = await fixture(); const alias = `${a.cwd}-alias`; await symlink(a.cwd, alias); b.cwd = alias;
  await mkdir(join(a.cwd, "sub")); expect(await sharedCheckoutPath(join(alias,"sub"))).toBe(a.cwd);
  const results = await Promise.allSettled([claimSharedCheckout(db,a), claimSharedCheckout(db,b)]);
  for (const result of results) if (result.status === "rejected" && result.reason?.code !== "workspace_busy") throw result.reason;
  expect(results.filter(r=>r.status === "fulfilled")).toHaveLength(1);
  expect((results.find(r=>r.status === "rejected") as PromiseRejectedResult).reason).toMatchObject({ code: "workspace_busy" });
});

it("keeps a silent writer and a terminal provider with unknown stop evidence fenced", async () => {
  const [a,b] = await fixture(); await claimSharedCheckout(db,a);
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

it("requires a retained process-stop receipt before another writer starts", async () => {
  const [a,b] = await fixture(); await claimSharedCheckout(db,a);
  await db.update(heartbeatRuns).set({ status: "succeeded", finishedAt: new Date(), processPid:12345 }).where(eq(heartbeatRuns.id,a.runId));
  await db.insert(agentInstructionWorkingCopies).values({ runId:a.runId, companyId:a.companyId, agentId:a.agentId,
    responsibleUserId:"test-owner", entryFile:"AGENTS.md", baseHash:"a".repeat(64), localRoot:a.cwd, executionRoot:a.cwd,
    location:"local", state:"captured", receipt:{}, processStoppedAt:new Date() });
  await expect(claimSharedCheckout(db,b)).resolves.toMatchObject({ path:a.cwd });
});
