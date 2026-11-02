import { randomUUID } from "node:crypto";
import { execFileSync } from "node:child_process";
import { mkdir, mkdtemp, realpath, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import express from "express";
import request from "supertest";
import { and, eq, inArray } from "drizzle-orm";
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
import { issueRoutes } from "../routes/issues.js";
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

/**
 * PM v2 "continue the original worker": the existing comment wake paths a PM or
 * momo relies on, and the explicit POST /api/issues/:id/continue.
 */
suite("issue comment wakes and continue for project PM children", () => {
  let database: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>>;
  let db: ReturnType<typeof createDb>;
  let root: string;
  let heartbeat: ReturnType<typeof heartbeatService>;
  const fakeRunIds: string[] = [];

  beforeAll(async () => {
    root = await realpath(await mkdtemp(path.join(os.tmpdir(), "paperclip-issue-continue-")));
    vi.stubEnv("PAPERCLIP_HOME", path.join(root, "home"));
    vi.stubEnv("PAPERCLIP_INSTANCE_ID", "vitest");
    database = await startEmbeddedPostgresTestDatabase("issue-continue");
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
    if (fakeRunIds.length > 0) {
      await db.update(heartbeatRuns).set({ status: "succeeded", finishedAt: new Date() }).where(inArray(heartbeatRuns.id, fakeRunIds.splice(0)));
    }
    await drainHeartbeatRunsToQuiescence(db, heartbeat);
    execute.mockClear();
  });

  async function seed() {
    const companyId = randomUUID(), projectId = randomUUID(), userId = randomUUID();
    const workerRoot = path.join(root, companyId, "repo");
    await mkdir(workerRoot, { recursive: true });
    execFileSync("git", ["init", "-q", "-b", "main"], { cwd: workerRoot });
    await db.insert(authUsers).values({ id: userId, name: "Owner", email: `${userId}@example.test`, createdAt: new Date(), updatedAt: new Date() });
    await db.insert(companies).values({ id: companyId, name: "Continue", issuePrefix: `C${companyId.slice(0, 6)}`, defaultResponsibleUserId: userId });
    await db.insert(companyMemberships).values({ companyId, principalType: "user", principalId: userId, membershipRole: "owner" });
    await db.insert(projects).values({ id: projectId, companyId, name: "App", status: "in_progress" });
    await db.insert(projectWorkspaces).values({ id: randomUUID(), companyId, projectId, name: "Repo", sourceType: "local_path", cwd: workerRoot, isPrimary: true });
    const agent = async (name: string, reportsTo: string | null) => {
      const id = randomUUID();
      await db.insert(agents).values({ id, companyId, name, role: "pm", status: "idle", adapterType: "codex_local", adapterConfig: {}, runtimeConfig: {}, permissions: {}, reportsTo });
      await db.insert(companyMemberships).values({ companyId, principalType: "agent", principalId: id, membershipRole: "member" });
      return id;
    };
    const momo = await agent("Momo", null);
    const pmId = await agent("PM", momo);
    const inboxIssueId = randomUUID();
    await db.insert(issues).values({ id: inboxIssueId, companyId, projectId, title: "PM inbox", status: "backlog", assigneeAgentId: pmId });
    const binding = await resolveProjectPmBinding(db, {
      companyId, agentId: pmId, validateInbox: true,
      binding: { mode: "project_pm", projectId, workerRoot, workerIsolation: "shared", workerSlots: 2, inboxIssueId },
    });
    await db.update(agents).set({ runtimeConfig: { workspaceBinding: binding } }).where(eq(agents.id, pmId));
    let counter = 0;
    const child = async (status: string) => {
      const id = randomUUID();
      counter += 1;
      await db.insert(issues).values({ id, companyId, projectId, parentId: inboxIssueId, title: `Child ${counter}`, status, assigneeAgentId: pmId });
      return id;
    };
    const momoIssueId = randomUUID();
    await db.insert(issues).values({ id: momoIssueId, companyId, title: "Momo desk", status: "in_progress", assigneeAgentId: momo });
    /**
     * A running run row that is not executing in this process (the caller's own
     * credential). Agent writes need the run's source issue: the PM run works its
     * inbox, momo works its own desk issue.
     */
    const runFor = async (agentId: string, status = "running") => {
      const runId = randomUUID();
      const issueId = agentId === pmId ? inboxIssueId : momoIssueId;
      await db.insert(heartbeatRuns).values({
        id: runId, companyId, agentId, invocationSource: "on_demand", status, responsibleUserId: userId,
        contextSnapshot: { issueId, taskId: issueId },
      });
      fakeRunIds.push(runId);
      return runId;
    };
    return { companyId, projectId, userId, momo, pmId, inboxIssueId, workerRoot, child, runFor };
  }

  type Fixture = Awaited<ReturnType<typeof seed>>;

  function board(f: Fixture): Actor {
    return {
      type: "board", userId: f.userId, source: "session", companyIds: [f.companyId],
      memberships: [{ companyId: f.companyId, status: "active", membershipRole: "owner" }], isInstanceAdmin: false,
    } as Actor;
  }

  function agentActor(f: Fixture, agentId: string, runId: string | undefined): Actor {
    return {
      type: "agent", agentId, companyId: f.companyId, runId, source: "agent_jwt", onBehalfOfUserId: f.userId,
      onBehalfOfMemberships: [{ companyId: f.companyId, membershipRole: "owner", status: "active" }],
    } as Actor;
  }

  function appFor(actor: Actor) {
    const app = express();
    app.use(express.json());
    app.use((req, _res, next) => {
      req.actor = actor;
      next();
    });
    app.use("/api", issueRoutes(db, {} as never, {}));
    app.use(errorHandler);
    return app;
  }

  async function wakesFor(f: Fixture, issueId: string) {
    const rows = await db.select().from(agentWakeupRequests).where(eq(agentWakeupRequests.agentId, f.pmId));
    return rows.filter((row) => (row.payload as Record<string, unknown> | null)?.issueId === issueId);
  }

  async function waitForWake(f: Fixture, issueId: string, reason: string) {
    let found: Awaited<ReturnType<typeof wakesFor>>[number] | undefined;
    await vi.waitFor(async () => {
      found = (await wakesFor(f, issueId)).find((row) => row.reason === reason);
      expect(found).toBeDefined();
    }, { timeout: 15_000 });
    return found!;
  }

  async function settle() {
    // Comment wakes are fire-and-forget after the response.
    await new Promise((resolve) => setTimeout(resolve, 300));
    await drainHeartbeatRunsToQuiescence(db, heartbeat);
  }

  const comment = (app: express.Express, issueId: string, body: Record<string, unknown>) =>
    request(app).post(`/api/issues/${issueId}/comments`).send(body);
  const continueIssue = (app: express.Express, issueId: string, body: Record<string, unknown> = {}) =>
    request(app).post(`/api/issues/${issueId}/continue`).send(body);

  describe("existing comment wakes", () => {
    it("wakes the assignee for a PM self-comment only with resume: true", async () => {
      const f = await seed();
      const pmApp = appFor(agentActor(f, f.pmId, await f.runFor(f.pmId)));

      const quiet = await f.child("todo");
      expect((await comment(pmApp, quiet, { body: "Status note from the PM" })).status).toBe(201);
      await settle();
      expect(await wakesFor(f, quiet)).toEqual([]);

      const resumed = await f.child("todo");
      const res = await comment(pmApp, resumed, { body: "Please continue with the tests", resume: true });
      expect(res.status).toBe(201);
      const wake = await waitForWake(f, resumed, "issue_commented");
      expect(wake.payload).toMatchObject({ issueId: resumed, commentId: res.body.id });
      await settle();
    }, 60_000);

    it("wakes the assignee for momo's comment on an open child, as an agent or through a board user", async () => {
      const f = await seed();
      const momoApp = appFor(agentActor(f, f.momo, await f.runFor(f.momo)));
      const byAgent = await f.child("in_progress");
      const agentComment = await comment(momoApp, byAgent, { body: "Momo: the owner wants dark mode too" });
      expect(agentComment.status).toBe(201);
      expect((await waitForWake(f, byAgent, "issue_commented")).payload).toMatchObject({ commentId: agentComment.body.id });
      await settle();

      const byBoard = await f.child("todo");
      const boardComment = await comment(appFor(board(f)), byBoard, { body: "From the console" });
      expect(boardComment.status).toBe(201);
      expect((await waitForWake(f, byBoard, "issue_commented")).payload).toMatchObject({ commentId: boardComment.body.id });
      await settle();
    }, 60_000);

    it("reopens a done child to todo and wakes its assignee: board comment implicitly, PM only with resume: true", async () => {
      const f = await seed();
      const doneForBoard = await f.child("done");
      expect((await comment(appFor(board(f)), doneForBoard, { body: "One more change please" })).status).toBe(201);
      await waitForWake(f, doneForBoard, "issue_reopened_via_comment");
      await settle();
      const [afterBoard] = await db.select().from(issues).where(eq(issues.id, doneForBoard));
      expect(afterBoard!.status).not.toBe("done");

      const pmApp = appFor(agentActor(f, f.pmId, await f.runFor(f.pmId)));
      const doneQuiet = await f.child("done");
      expect((await comment(pmApp, doneQuiet, { body: "Closing note" })).status).toBe(201);
      await settle();
      expect(await wakesFor(f, doneQuiet)).toEqual([]);
      expect((await db.select().from(issues).where(eq(issues.id, doneQuiet)))[0]!.status).toBe("done");

      const doneResume = await f.child("done");
      const res = await comment(pmApp, doneResume, { body: "Reopen: the build broke", resume: true });
      expect(res.status).toBe(201);
      const wake = await waitForWake(f, doneResume, "issue_reopened_via_comment");
      expect(wake.payload).toMatchObject({ issueId: doneResume, commentId: res.body.id });
      await settle();
      const reopened = await db.select().from(activityLog).where(and(eq(activityLog.entityId, doneResume), eq(activityLog.action, "issue.updated")));
      expect(reopened.map((row) => row.details)).toEqual(expect.arrayContaining([expect.objectContaining({ status: "todo", reopenedFrom: "done", source: "comment" })]));
    }, 60_000);
  });

  describe("POST /api/issues/:id/continue", () => {
    it("wakes the assignee of an open child with pm_continue from its own run credential", async () => {
      const f = await seed();
      const pmApp = appFor(agentActor(f, f.pmId, await f.runFor(f.pmId)));
      const childId = await f.child("todo");
      // Inserted directly: a comment through the route would wake its own run first.
      const note = { body: { id: randomUUID() } };
      await db.insert(issueComments).values({ id: note.body.id, companyId: f.companyId, issueId: childId, authorUserId: f.userId, body: "Context for the worker" });

      const res = await continueIssue(pmApp, childId, { commentId: note.body.id, reason: "owner replied" });
      expect(res.status).toBe(202);
      expect(res.body.status).toBe("todo");
      expect(res.body.runId).toEqual(expect.any(String));
      const wake = (await wakesFor(f, childId)).find((row) => row.reason === "pm_continue");
      expect(wake?.payload).toMatchObject({ issueId: childId, commentId: note.body.id, mutation: "continue" });

      await vi.waitFor(async () => {
        expect(["succeeded", "failed", "cancelled", "timed_out"]).toContain((await heartbeat.getRun(res.body.runId))?.status);
      }, { timeout: 15_000 });
      await drainHeartbeatRunsToQuiescence(db, heartbeat);
      const run = (await heartbeat.getRun(res.body.runId))!;
      expect(run.contextSnapshot).toMatchObject({ issueId: childId, wakeCommentId: note.body.id, wakeReason: "pm_continue", source: "issue.continue" });
      expect((run.contextSnapshot as Record<string, any>).paperclipPmWorkspace).toMatchObject({ role: "worker", cwd: f.workerRoot });

      const [logged] = await db.select().from(activityLog).where(and(eq(activityLog.entityId, childId), eq(activityLog.action, "issue.continued")));
      expect(logged).toMatchObject({ actorType: "agent", actorId: f.pmId });
      expect(logged!.details).toMatchObject({ wakeRunId: res.body.runId, reopened: false, commentId: note.body.id, reason: "owner replied" });
    }, 60_000);

    it("reopens done and cancelled children to todo, logs the reopen and accepts board users", async () => {
      const f = await seed();
      const pmApp = appFor(agentActor(f, f.pmId, await f.runFor(f.pmId)));
      for (const status of ["done", "cancelled"]) {
        const childId = await f.child(status);
        const res = await continueIssue(pmApp, childId);
        expect({ status, code: res.status, issueStatus: res.body.status }).toEqual({ status, code: 202, issueStatus: "todo" });
        const updates = await db.select().from(activityLog).where(and(eq(activityLog.entityId, childId), eq(activityLog.action, "issue.updated")));
        expect(updates.map((row) => row.details)).toEqual([expect.objectContaining({ status: "todo", reopened: true, reopenedFrom: status, source: "continue" })]);
        expect((await wakesFor(f, childId)).map((row) => row.reason)).toContain("pm_continue");
        await drainHeartbeatRunsToQuiescence(db, heartbeat);
      }

      const boardChild = await f.child("done");
      const byBoard = await continueIssue(appFor(board(f)), boardChild, { reason: "owner asked" });
      expect(byBoard.status).toBe(202);
      expect(byBoard.body.status).toBe("todo");
      const [logged] = await db.select().from(activityLog).where(and(eq(activityLog.entityId, boardChild), eq(activityLog.action, "issue.continued")));
      expect(logged).toMatchObject({ actorType: "user", actorId: f.userId });
    }, 60_000);

    it("refuses other agents, missing or foreign run credentials, bad comments and non-resumable issues", async () => {
      const f = await seed();
      const childId = await f.child("done");
      const pmRun = await f.runFor(f.pmId);
      const momoRun = await f.runFor(f.momo);

      expect((await continueIssue(appFor(agentActor(f, f.momo, momoRun)), childId)).status).toBe(403);
      expect((await continueIssue(appFor(agentActor(f, f.pmId, undefined)), childId)).status).toBe(401);
      expect((await continueIssue(appFor(agentActor(f, f.pmId, momoRun)), childId)).status).toBe(403);
      const finishedRun = await f.runFor(f.pmId, "succeeded");
      expect((await continueIssue(appFor(agentActor(f, f.pmId, finishedRun)), childId)).status).toBe(403);

      const pmApp = appFor(agentActor(f, f.pmId, pmRun));
      expect((await continueIssue(pmApp, childId, { commentId: "not-a-uuid" })).status).toBe(400);
      expect((await continueIssue(pmApp, childId, { reason: "x".repeat(501) })).status).toBe(400);
      expect((await continueIssue(pmApp, childId, { commentId: randomUUID() })).status).toBe(422);
      const elsewhere = await f.child("todo");
      const foreignComment = await comment(appFor(board(f)), elsewhere, { body: "Another issue" });
      await settle();
      expect((await continueIssue(pmApp, childId, { commentId: foreignComment.body.id })).status).toBe(422);

      const backlog = await f.child("backlog");
      expect((await continueIssue(pmApp, backlog)).status).toBe(409);
      const unassigned = randomUUID();
      await db.insert(issues).values({ id: unassigned, companyId: f.companyId, projectId: f.projectId, title: "Nobody", status: "done" });
      expect((await continueIssue(appFor(board(f)), unassigned)).status).toBe(409);

      const other = await seed();
      expect((await continueIssue(appFor(board(other)), childId)).status).toBe(404);

      expect((await db.select().from(issues).where(eq(issues.id, childId)))[0]!.status).toBe("done");
      expect((await wakesFor(f, childId)).filter((row) => row.reason === "pm_continue")).toEqual([]);
      expect(await db.select().from(activityLog).where(and(eq(activityLog.entityId, childId), eq(activityLog.action, "issue.continued")))).toEqual([]);
      expect(await db.select().from(issueComments).where(eq(issueComments.issueId, childId))).toEqual([]);
    }, 60_000);
  });
});
