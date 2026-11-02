import { randomUUID } from "node:crypto";
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import express from "express";
import request from "supertest";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { and, eq } from "drizzle-orm";
import { activityLog, agents, authUsers, companies, companyMemberships, createDb, heartbeatRuns } from "@paperclipai/db";
import { getEmbeddedPostgresTestSupport, startEmbeddedPostgresTestDatabase } from "./helpers/embedded-postgres.js";
import { errorHandler } from "../middleware/index.js";
import { agentRoutes } from "../routes/agents.js";
import { resolveManagedInstructionsRoot } from "../services/agent-instructions.js";

const support = await getEmbeddedPostgresTestSupport();
const suite = support.supported ? describe : describe.skip;

type Db = ReturnType<typeof createDb>;

suite("agent memory files through the agent's own run credential", () => {
  let database: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>>;
  let db: Db;
  let home: string;

  beforeAll(async () => {
    home = await realpath(await mkdtemp(path.join(os.tmpdir(), "paperclip-agent-memory-")));
    vi.stubEnv("PAPERCLIP_HOME", home);
    vi.stubEnv("PAPERCLIP_INSTANCE_ID", "vitest");
    database = await startEmbeddedPostgresTestDatabase("agent-memory-routes");
    db = createDb(database.connectionString);
  }, 60_000);

  afterAll(async () => {
    await db?.$client.end({ timeout: 5 });
    await database?.cleanup();
    vi.unstubAllEnvs();
    await rm(home, { recursive: true, force: true });
  });

  async function seed() {
    const companyId = randomUUID(), userId = randomUUID();
    await db.insert(companies).values({ id: companyId, name: "Memory", issuePrefix: `Q${companyId.slice(0, 6)}`, defaultResponsibleUserId: userId });
    await db.insert(authUsers).values({ id: userId, name: "Owner", email: `${userId}@example.test`, createdAt: new Date(), updatedAt: new Date() });
    await db.insert(companyMemberships).values({ companyId, principalType: "user", principalId: userId, membershipRole: "owner" });
    const agent = async (name: string) => {
      const id = randomUUID();
      const root = resolveManagedInstructionsRoot({ id, companyId, name, adapterConfig: {} });
      await db.insert(agents).values({
        id, companyId, name, role: "pm", status: "idle", adapterType: "codex_local",
        adapterConfig: { instructionsBundleMode: "managed", instructionsRootPath: root, instructionsEntryFile: "AGENTS.md" },
      });
      await db.insert(companyMemberships).values({ companyId, principalType: "agent", principalId: id, membershipRole: "member" });
      await mkdir(root, { recursive: true });
      await writeFile(path.join(root, "AGENTS.md"), "# PM\n");
      const runId = randomUUID();
      await db.insert(heartbeatRuns).values({ id: runId, companyId, agentId: id, invocationSource: "on_demand", status: "running", responsibleUserId: userId });
      return { id, root, runId };
    };
    return { companyId, userId, pm: await agent("PM"), other: await agent("Other") };
  }

  function appFor(actor: Express.Request["actor"]) {
    const app = express();
    app.use(express.json());
    app.use((req, _res, next) => {
      req.actor = actor;
      next();
    });
    app.use("/api", agentRoutes(db));
    app.use(errorHandler);
    return app;
  }

  function runActor(f: Awaited<ReturnType<typeof seed>>, agent: { id: string; runId: string }): Express.Request["actor"] {
    return {
      type: "agent", agentId: agent.id, companyId: f.companyId, runId: agent.runId, source: "agent_jwt",
      onBehalfOfUserId: f.userId,
      onBehalfOfMemberships: [{ companyId: f.companyId, membershipRole: "owner", status: "active" }],
    } as Express.Request["actor"];
  }

  const put = (app: express.Express, agentId: string, body: Record<string, unknown>) =>
    request(app).put(`/api/agents/${agentId}/instructions-bundle/file`).send(body);
  const get = (app: express.Express, agentId: string, filePath: string) =>
    request(app).get(`/api/agents/${agentId}/instructions-bundle/file`).query({ path: filePath });

  it("lets the agent's own run write and read back its memory/ files with contentHash", async () => {
    const f = await seed();
    const app = appFor(runActor(f, f.pm));
    expect((await get(app, f.pm.id, "memory/INDEX.md")).status).toBe(404);

    const created = await put(app, f.pm.id, { path: "memory/INDEX.md", content: "# Index\n", baseHash: null });
    expect(created.status).toBe(200);
    expect(created.body.contentHash).toMatch(/^[a-f0-9]{64}$/);
    const readBack = await get(app, f.pm.id, "memory/INDEX.md");
    expect(readBack.status).toBe(200);
    expect({ content: readBack.body.content, contentHash: readBack.body.contentHash }).toEqual({ content: "# Index\n", contentHash: created.body.contentHash });

    const updated = await put(app, f.pm.id, { path: "memory/INDEX.md", content: "# Index\n- project.md\n", baseHash: created.body.contentHash });
    expect(updated.status).toBe(200);
    expect(updated.body.contentHash).not.toBe(created.body.contentHash);
    expect(await readFile(path.join(f.pm.root, "memory/INDEX.md"), "utf8")).toBe("# Index\n- project.md\n");

    const audit = await db.select().from(activityLog).where(and(eq(activityLog.entityId, f.pm.id), eq(activityLog.action, "agent.files_updated")));
    expect(audit.map((row) => ({ actorId: row.actorId, runId: row.runId, path: (row.details as Record<string, unknown>).path })))
      .toEqual(expect.arrayContaining([{ actorId: f.pm.id, runId: f.pm.runId, path: "memory/INDEX.md" }]));
  });

  it("rejects a stale baseHash with 409 AGENT_FILE_CONFLICT and keeps the stored file", async () => {
    const f = await seed();
    const app = appFor(runActor(f, f.pm));
    const first = await put(app, f.pm.id, { path: "memory/decisions.md", content: "v1\n", baseHash: null });
    expect(first.status).toBe(200);
    await put(app, f.pm.id, { path: "memory/decisions.md", content: "v2\n", baseHash: first.body.contentHash });
    const stale = await put(app, f.pm.id, { path: "memory/decisions.md", content: "v3\n", baseHash: first.body.contentHash });
    expect(stale.status).toBe(409);
    expect(stale.body.details).toMatchObject({ code: "AGENT_FILE_CONFLICT", path: "memory/decisions.md" });
    expect(await readFile(path.join(f.pm.root, "memory/decisions.md"), "utf8")).toBe("v2\n");
  });

  it("forbids another agent's files, the entry file and paths outside memory/", async () => {
    const f = await seed();
    const pmApp = appFor(runActor(f, f.pm));
    const otherApp = appFor(runActor(f, f.other));

    const peer = await put(pmApp, f.other.id, { path: "memory/INDEX.md", content: "x", baseHash: null });
    expect(peer.status).toBe(403);
    const intruder = await put(otherApp, f.pm.id, { path: "memory/INDEX.md", content: "x", baseHash: null });
    expect(intruder.status).toBe(403);

    const entry = await put(pmApp, f.pm.id, { path: "AGENTS.md", content: "# replaced\n", baseRevisionId: null });
    expect(entry.status).toBe(403);
    expect(await readFile(path.join(f.pm.root, "AGENTS.md"), "utf8")).toBe("# PM\n");

    for (const outside of ["notes.md", "memoryx/INDEX.md", "skills/memory/INDEX.md"]) {
      const res = await put(pmApp, f.pm.id, { path: outside, content: "x", baseHash: null });
      expect({ outside, status: res.status }).toEqual({ outside, status: 403 });
    }
    // Traversal is rejected before any authorization decision.
    expect((await put(pmApp, f.pm.id, { path: "memory/../AGENTS.md", content: "x", baseHash: null })).status).toBe(422);
    await expect(readFile(path.join(f.other.root, "memory/INDEX.md"), "utf8")).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("requires a per-run credential bound to the agent", async () => {
    const f = await seed();
    const keyActor = { ...runActor(f, f.pm), runId: undefined } as Express.Request["actor"];
    expect((await put(appFor(keyActor), f.pm.id, { path: "memory/INDEX.md", content: "x", baseHash: null })).status).toBe(403);
    // The other agent's run id does not bind to the PM agent.
    const foreignRun = { ...runActor(f, f.pm), runId: f.other.runId } as Express.Request["actor"];
    expect((await put(appFor(foreignRun), f.pm.id, { path: "memory/INDEX.md", content: "x", baseHash: null })).status).toBe(403);
  });
});
