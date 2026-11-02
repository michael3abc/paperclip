import { randomUUID } from "node:crypto";
import { execFileSync } from "node:child_process";
import { mkdir, mkdtemp, realpath, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import express from "express";
import request from "supertest";
import { and, eq } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import {
  activityLog,
  agents,
  agentWakeupRequests,
  authUsers,
  companies,
  companyMemberships,
  createDb,
  heartbeatRuns,
  issueComments,
  issues,
  projects,
  projectWorkspaces,
} from "@paperclipai/db";
import { getEmbeddedPostgresTestSupport, startEmbeddedPostgresTestDatabase } from "./helpers/embedded-postgres.js";
import { drainHeartbeatRunsToQuiescence } from "./helpers/drain-heartbeat-runs.js";
import { errorHandler } from "../middleware/index.js";
import { projectPmRoutes } from "../routes/project-pm.js";
import { heartbeatService } from "../services/heartbeat.ts";
import { resolveProjectPmBinding } from "../services/agent-workspace-binding.js";

const execute = vi.hoisted(() => vi.fn(async (_input: any) => ({ exitCode: 0, signal: null, timedOut: false })));
vi.mock("../adapters/index.js", () => ({
  getServerAdapter: () => ({ type: "codex_local", execute, supportsLocalAgentJwt: false }),
  findActiveServerAdapter: () => ({ type: "codex_local", execute, supportsLocalAgentJwt: false }),
  runningProcesses: new Map(),
}));

const support = await getEmbeddedPostgresTestSupport();
const suite = support.supported ? describe : describe.skip;

type Actor = Express.Request["actor"];

suite("project PM intake and pm-workspaces routes", () => {
  let database: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>>;
  let db: ReturnType<typeof createDb>;
  let root: string;
  let heartbeat: ReturnType<typeof heartbeatService>;

  beforeAll(async () => {
    root = await realpath(await mkdtemp(path.join(os.tmpdir(), "paperclip-pm-intake-")));
    vi.stubEnv("PAPERCLIP_HOME", path.join(root, "home"));
    vi.stubEnv("PAPERCLIP_INSTANCE_ID", "vitest");
    database = await startEmbeddedPostgresTestDatabase("project-pm-intake");
    db = createDb(database.connectionString);
    heartbeat = heartbeatService(db);
  }, 30_000);

  afterAll(async () => {
    if (db && heartbeat) await drainHeartbeatRunsToQuiescence(db, heartbeat);
    await db?.$client.end({ timeout: 5 });
    await database?.cleanup();
    vi.unstubAllEnvs();
    await rm(root, { recursive: true, force: true });
  }, 60_000);

  afterEach(async () => {
    await drainHeartbeatRunsToQuiescence(db, heartbeat);
    execute.mockClear();
  });

  async function seed() {
    const companyId = randomUUID(), projectId = randomUUID(), userId = randomUUID();
    const workerRoot = path.join(root, companyId, "repo");
    await mkdir(workerRoot, { recursive: true });
    execFileSync("git", ["init", "-q", "-b", "main"], { cwd: workerRoot });
    await db.insert(authUsers).values({ id: userId, name: "Owner", email: `${userId}@example.test`, createdAt: new Date(), updatedAt: new Date() });
    await db.insert(companies).values({ id: companyId, name: "Intake", issuePrefix: `I${companyId.slice(0, 6)}`, defaultResponsibleUserId: userId });
    await db.insert(companyMemberships).values({ companyId, principalType: "user", principalId: userId, membershipRole: "owner" });
    await db.insert(projects).values({ id: projectId, companyId, name: "App", status: "in_progress" });
    await db.insert(projectWorkspaces).values({ id: randomUUID(), companyId, projectId, name: "Repo", sourceType: "local_path", cwd: workerRoot, isPrimary: true });
    const agent = async (name: string, reportsTo: string | null, extra: Record<string, unknown> = {}) => {
      const id = randomUUID();
      await db.insert(agents).values({
        id, companyId, name, role: "pm", status: "idle", adapterType: "codex_local",
        adapterConfig: { apiKey: "should-not-leak" }, runtimeConfig: {}, permissions: {}, reportsTo, ...extra,
      });
      await db.insert(companyMemberships).values({ companyId, principalType: "agent", principalId: id, membershipRole: "member" });
      return id;
    };
    const dot = await agent("Dot", null);
    const momo = await agent("Momo", dot);
    const pmId = await agent("PM", momo);
    const peer = await agent("Peer", momo);
    const inboxIssueId = randomUUID();
    await db.insert(issues).values({ id: inboxIssueId, companyId, projectId, title: "PM inbox", status: "backlog", assigneeAgentId: pmId });
    const binding = await resolveProjectPmBinding(db, {
      companyId, agentId: pmId, validateInbox: true,
      binding: { mode: "project_pm", projectId, workerRoot, workerIsolation: "shared", workerSlots: 2, inboxIssueId },
    });
    await db.update(agents).set({ runtimeConfig: { workspaceBinding: binding } }).where(eq(agents.id, pmId));
    const runFor = async (agentId: string) => {
      const runId = randomUUID();
      await db.insert(heartbeatRuns).values({ id: runId, companyId, agentId, invocationSource: "on_demand", status: "running", responsibleUserId: userId });
      return runId;
    };
    return { companyId, projectId, userId, dot, momo, pmId, peer, inboxIssueId, workerRoot, agentHome: binding.agentHome!, runFor };
  }

  type Fixture = Awaited<ReturnType<typeof seed>>;

  function board(f: Fixture, role = "owner"): Actor {
    return {
      type: "board", userId: f.userId, source: "session", companyIds: [f.companyId],
      memberships: [{ companyId: f.companyId, status: "active", membershipRole: role }], isInstanceAdmin: false,
    } as Actor;
  }

  function agentActor(f: Fixture, agentId: string, runId: string, companyId = f.companyId): Actor {
    return {
      type: "agent", agentId, companyId, runId, source: "agent_jwt", onBehalfOfUserId: f.userId,
      onBehalfOfMemberships: [{ companyId, membershipRole: "owner", status: "active" }],
    } as Actor;
  }

  function appFor(actor: Actor) {
    const app = express();
    app.use(express.json());
    app.use((req, _res, next) => {
      req.actor = actor;
      next();
    });
    app.use("/api", projectPmRoutes(db));
    app.use(errorHandler);
    return app;
  }

  async function waitForRun(runId: string) {
    await vi.waitFor(async () => {
      const run = await heartbeat.getRun(runId);
      expect(["succeeded", "failed", "cancelled", "timed_out"]).toContain(run?.status);
    }, { timeout: 15_000 });
    await drainHeartbeatRunsToQuiescence(db, heartbeat);
    return (await heartbeat.getRun(runId))!;
  }

  it("creates one marked inbox comment, wakes the PM in its PM role and dedupes retries", async () => {
    const f = await seed();
    const app = appFor(board(f));
    const body = { dedupeId: "console:receipt-0001", source: "console", text: "Ship the login page", sourceRef: "console/msg/42" };

    const created = await request(app).post(`/api/agents/${f.pmId}/pm-intake`).send(body);
    expect(created.status).toBe(201);
    expect(created.body).toMatchObject({ status: "created", issueId: f.inboxIssueId, dedupeId: body.dedupeId });
    expect(created.body.commentId).toEqual(expect.any(String));
    expect(created.body.runId).toEqual(expect.any(String));

    const [comment] = await db.select().from(issueComments).where(eq(issueComments.id, created.body.commentId));
    expect(comment!.body).toBe("Ship the login page\n\n<!-- ccpocket-intake dedupe=console:receipt-0001 source=console ref=console/msg/42 -->");
    expect({ issueId: comment!.issueId, authorUserId: comment!.authorUserId, authorAgentId: comment!.authorAgentId })
      .toEqual({ issueId: f.inboxIssueId, authorUserId: f.userId, authorAgentId: null });

    const wakes = await db.select().from(agentWakeupRequests).where(eq(agentWakeupRequests.agentId, f.pmId));
    expect(wakes.map((wake) => ({ reason: wake.reason, idempotencyKey: wake.idempotencyKey })))
      .toEqual([{ reason: "pm_intake", idempotencyKey: `pm-intake:${f.pmId}:${body.dedupeId}` }]);

    const run = await waitForRun(created.body.runId);
    expect({ status: run.status, error: run.error }).toEqual({ status: "succeeded", error: null });
    const context = run.contextSnapshot as Record<string, any>;
    expect(context).toMatchObject({
      issueId: f.inboxIssueId,
      commentId: created.body.commentId,
      wakeCommentId: created.body.commentId,
      wakeReason: "pm_intake",
      pmIntake: { dedupeId: body.dedupeId, source: "console", sourceRef: "console/msg/42" },
    });
    expect(context.paperclipPmWorkspace).toMatchObject({ role: "pm", cwd: f.agentHome, issueId: f.inboxIssueId });
    const [inbox] = await db.select().from(issues).where(eq(issues.id, f.inboxIssueId));
    expect(inbox!.status).toBe("backlog");

    const activity = await db.select().from(activityLog).where(and(eq(activityLog.entityId, f.inboxIssueId), eq(activityLog.action, "issue.comment_added")));
    expect(activity).toHaveLength(1);
    expect(activity[0]!.details).toMatchObject({ commentId: created.body.commentId, pmAgentId: f.pmId, pmIntake: { dedupeId: body.dedupeId, source: "console" } });

    const again = await request(app).post(`/api/agents/${f.pmId}/pm-intake`).send({ ...body, text: "different text" });
    expect(again.status).toBe(200);
    expect(again.body).toEqual({ status: "duplicate", commentId: created.body.commentId, issueId: f.inboxIssueId, dedupeId: body.dedupeId });
    expect(await db.select().from(issueComments).where(eq(issueComments.issueId, f.inboxIssueId))).toHaveLength(1);
    expect(await db.select().from(agentWakeupRequests).where(eq(agentWakeupRequests.agentId, f.pmId))).toHaveLength(1);

    const found = await request(app).get(`/api/agents/${f.pmId}/pm-intake/${body.dedupeId}`);
    expect(found.status).toBe(200);
    expect(found.body).toEqual({ status: "found", commentId: created.body.commentId, issueId: f.inboxIssueId, createdAt: new Date(comment!.createdAt).toISOString() });
    const missing = await request(app).get(`/api/agents/${f.pmId}/pm-intake/console:receipt-9999`);
    expect(missing.status).toBe(404);
    expect(missing.body).toEqual({ status: "not_found" });
    // A dedupeId that is a prefix of a stored one does not match it.
    expect((await request(app).get(`/api/agents/${f.pmId}/pm-intake/console:receipt-000`)).status).toBe(404);
  }, 60_000);

  it("serializes concurrent receipts with the same dedupeId into one comment", async () => {
    const f = await seed();
    const app = appFor(board(f));
    const body = { dedupeId: "momo-concurrent-1", source: "momo", text: "Same receipt" };
    const results = await Promise.all(Array.from({ length: 5 }, () => request(app).post(`/api/agents/${f.pmId}/pm-intake`).send(body)));
    expect(results.map((res) => res.status).sort()).toEqual([200, 200, 200, 200, 201]);
    expect(new Set(results.map((res) => res.body.commentId)).size).toBe(1);
    expect(await db.select().from(issueComments).where(eq(issueComments.issueId, f.inboxIssueId))).toHaveLength(1);
  }, 60_000);

  it("allows managers in the reportsTo chain and refuses other agents, viewers and other companies", async () => {
    const f = await seed();
    const body = (dedupeId: string) => ({ dedupeId, source: "momo", text: "From momo" });

    const momoRun = await f.runFor(f.momo);
    const fromMomo = await request(appFor(agentActor(f, f.momo, momoRun))).post(`/api/agents/${f.pmId}/pm-intake`).send(body("momo-receipt-1"));
    expect(fromMomo.status).toBe(201);
    const [comment] = await db.select().from(issueComments).where(eq(issueComments.id, fromMomo.body.commentId));
    expect({ authorAgentId: comment!.authorAgentId, createdByRunId: comment!.createdByRunId }).toEqual({ authorAgentId: f.momo, createdByRunId: momoRun });

    const dotRun = await f.runFor(f.dot);
    expect((await request(appFor(agentActor(f, f.dot, dotRun))).post(`/api/agents/${f.pmId}/pm-intake`).send(body("dot-receipt-1"))).status).toBe(201);

    const peerRun = await f.runFor(f.peer);
    const peerApp = appFor(agentActor(f, f.peer, peerRun));
    expect((await request(peerApp).post(`/api/agents/${f.pmId}/pm-intake`).send(body("peer-receipt-1"))).status).toBe(403);
    expect((await request(peerApp).get(`/api/agents/${f.pmId}/pm-intake/momo-receipt-1`)).status).toBe(403);
    const pmRun = await f.runFor(f.pmId);
    expect((await request(appFor(agentActor(f, f.pmId, pmRun))).post(`/api/agents/${f.pmId}/pm-intake`).send(body("self-receipt-1"))).status).toBe(403);

    expect((await request(appFor(board(f, "viewer"))).post(`/api/agents/${f.pmId}/pm-intake`).send(body("viewer-receipt"))).status).toBe(403);

    const other = await seed();
    const otherRun = await other.runFor(other.momo);
    const foreign = await request(appFor(agentActor(other, other.momo, otherRun))).post(`/api/agents/${f.pmId}/pm-intake`).send(body("foreign-receipt"));
    expect(foreign.status).toBe(404);
    expect((await request(appFor(board(other))).get(`/api/agents/${f.pmId}/pm-intake/momo-receipt-1`)).status).toBe(404);
    expect((await request(appFor(board(f))).post(`/api/agents/not-a-uuid/pm-intake`).send(body("bad-agent-id"))).status).toBe(404);
  }, 60_000);

  it("rejects bad bodies, receipt markers in text and a PM without an inbox", async () => {
    const f = await seed();
    const app = appFor(board(f));
    const post = (body: Record<string, unknown>) => request(app).post(`/api/agents/${f.pmId}/pm-intake`).send(body);
    expect((await post({ dedupeId: "short", source: "console", text: "x" })).status).toBe(400);
    expect((await post({ dedupeId: "has spaces in it", source: "console", text: "x" })).status).toBe(400);
    expect((await post({ dedupeId: "valid-id-1", source: "slack", text: "x" })).status).toBe(400);
    expect((await post({ dedupeId: "valid-id-1", source: "console", text: "" })).status).toBe(400);
    expect((await post({ dedupeId: "valid-id-1", source: "console", text: "x", sourceRef: "a b" })).status).toBe(400);
    expect((await post({ dedupeId: "valid-id-1", source: "console", text: "x", extra: true })).status).toBe(400);
    const marker = await post({ dedupeId: "valid-id-1", source: "console", text: "<!-- ccpocket-intake dedupe=other-id-1 source=console ref=- -->" });
    expect(marker.status).toBe(422);
    expect(marker.body.code).toBe("pm_intake_marker_in_text");
    expect((await request(app).get(`/api/agents/${f.pmId}/pm-intake/bad id`)).status).toBe(422);

    const [pm] = await db.select().from(agents).where(eq(agents.id, f.pmId));
    const binding = (pm!.runtimeConfig as Record<string, any>).workspaceBinding;
    await db.update(agents).set({ runtimeConfig: { workspaceBinding: { ...binding, inboxIssueId: null } } }).where(eq(agents.id, f.pmId));
    const noInbox = await post({ dedupeId: "valid-id-2", source: "console", text: "x" });
    expect(noInbox.status).toBe(409);
    expect(noInbox.body.code).toBe("pm_inbox_missing");
    const plain = await request(app).post(`/api/agents/${f.momo}/pm-intake`).send({ dedupeId: "valid-id-3", source: "console", text: "x" });
    expect({ status: plain.status, code: plain.body.code }).toEqual({ status: 409, code: "pm_inbox_missing" });
    expect(await db.select().from(issueComments).where(eq(issueComments.issueId, f.inboxIssueId))).toHaveLength(0);
  }, 60_000);

  it("lists the company's project PMs without adapter config", async () => {
    const f = await seed();
    await db.update(agents).set({ status: "terminated", runtimeConfig: (await db.select().from(agents).where(eq(agents.id, f.pmId)))[0]!.runtimeConfig })
      .where(eq(agents.id, f.peer));
    const other = await seed();

    const listed = await request(appFor(board(f))).get(`/api/companies/${f.companyId}/pm-workspaces`);
    expect(listed.status).toBe(200);
    expect(listed.body).toEqual([{
      agentId: f.pmId, agentName: "PM", status: "idle", projectId: f.projectId, projectName: "App",
      agentHome: f.agentHome, workerRoot: f.workerRoot, workerIsolation: "shared", workerSlots: 2, inboxIssueId: f.inboxIssueId,
    }]);
    expect(JSON.stringify(listed.body)).not.toContain("should-not-leak");

    const momoRun = await f.runFor(f.momo);
    const byAgent = await request(appFor(agentActor(f, f.momo, momoRun))).get(`/api/companies/${f.companyId}/pm-workspaces`);
    expect(byAgent.status).toBe(200);
    expect(byAgent.body.map((row: { agentId: string }) => row.agentId)).toEqual([f.pmId]);

    const otherRun = await other.runFor(other.momo);
    expect((await request(appFor(agentActor(other, other.momo, otherRun))).get(`/api/companies/${f.companyId}/pm-workspaces`)).status).toBe(403);
    expect((await request(appFor(board(other))).get(`/api/companies/${f.companyId}/pm-workspaces`)).status).toBe(403);
  }, 60_000);
});
