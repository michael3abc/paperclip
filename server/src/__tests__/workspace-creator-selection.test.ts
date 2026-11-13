import { randomUUID } from "node:crypto";
import express from "express";
import request from "supertest";
import { eq } from "drizzle-orm";
import { beforeAll, afterAll, describe, it, expect } from "vitest";
import { agents, companies, companyMemberships, projects, projectWorkspaces, executionWorkspaces,
  issues, heartbeatRuns, issueRecoveryActions, createDb } from "@paperclipai/db";
import { MAIN_MANAGED_WORKTREE_SCHEMA } from "@paperclipai/shared";
import { startEmbeddedPostgresTestDatabase } from "./helpers/embedded-postgres.js";
import { routeWorkspaceToCreator, creatorRecovery } from "../services/recovery/workspace-creator.js";
import { issueRoutes } from "../routes/issues.js";
import { errorHandler } from "../middleware/index.js";

describe("workspace creator repair selection through the public route", () => {
  let database: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>>, db: ReturnType<typeof createDb>;
  beforeAll(async () => { database = await startEmbeddedPostgresTestDatabase("creator-selection-"); db = createDb(database.connectionString); }, 60000);
  afterAll(async () => { await db?.$client.end(); await database?.cleanup(); });
  async function fixture() {
    const companyId = randomUUID(), mainId = randomUUID(), workerId = randomUUID(), projectId = randomUUID(), owner = randomUUID();
    const conversationId = randomUUID(), originRunId = randomUUID(), taskId = randomUUID(), failedRunId = randomUUID();
    await db.insert(companies).values({ id: companyId, name: "Recovery", issuePrefix: "R" + companyId.slice(0,6) });
    await db.insert(companyMemberships).values({ companyId, principalType: "user", principalId: owner, status: "active", membershipRole: "owner" });
    await db.insert(agents).values([{ id: mainId, companyId, name: "Main", adapterType: "ccpocket_bridge",
      adapterConfig: { role: "main", provider: "codex", projectId } }, { id: workerId, companyId, name: "Worker", adapterType: "ccpocket_bridge" }]);
    await db.insert(projects).values({ id: projectId, companyId, name: "Project", leadAgentId: mainId });
    const [workspace] = await db.insert(projectWorkspaces).values({ companyId, projectId, name: "Dev", cwd: "/owned/fixture" }).returning();
    await db.insert(issues).values({ id: conversationId, companyId, projectId, title: "Original Chat", status: "in_progress",
      conversationAgentId: mainId, conversationUserId: owner, conversationState: "active", responsibleUserId: owner, assigneeAgentId: mainId });
    await db.insert(heartbeatRuns).values({ id: originRunId, companyId, agentId: mainId, issueId: conversationId,
      status: "succeeded", finishedAt: new Date(), contextSnapshot: { issueId: conversationId },
      runnerProfileJson: { adapterDispatch: { adapterType: "ccpocket_bridge", adapterConfig: { role: "main", provider: "codex" } } } });
    await db.insert(issues).values({ id: taskId, companyId, projectId, projectWorkspaceId: workspace.id, title: "Worker task", status: "blocked",
      createdByAgentId: mainId, originRunId, assigneeAgentId: workerId });
    await db.insert(heartbeatRuns).values({ id: failedRunId, companyId, agentId: workerId, issueId: taskId, status: "failed",
      errorCode: "workspace_validation_failed", finishedAt: new Date(), contextSnapshot: { issueId: taskId },
      resultJson: { executionRecovery: { kind: "bootstrap", providerWorkStarted: false },
        workspaceValidation: { reason: "shared_checkout_unsaved_changes", dirtyFiles: { paths: ["draft.txt"], count: 1, truncated: false } } } });
    const [action] = await db.insert(issueRecoveryActions).values({ companyId, sourceIssueId: taskId, kind: "environment_repair", status: "active",
      ownerType: "board", cause: "workspace_validation_failed", fingerprint: randomUUID(), nextAction: "Repair workspace",
      evidence: { latestRunId: failedRunId } }).returning();
    const read = () => db.select().from(issueRecoveryActions).where(eq(issueRecoveryActions.id, action.id)).then(r=>r[0]!);
    const route = () => db.transaction(async tx => {
      await tx.select().from(issues).where(eq(issues.id, taskId)).for("update");
      const [latest] = await tx.select().from(issueRecoveryActions).where(eq(issueRecoveryActions.id, action.id)).for("update");
      return routeWorkspaceToCreator(tx as unknown as typeof db, latest!, { requestKey: action.id });
    });
    const app = express(); app.use(express.json()); app.use((req,_res,next) => { req.actor = { type: "board", userId: owner, source: "session", companyIds: [companyId] }; next(); });
    app.use("/api", issueRoutes(db, {} as never)); app.use(errorHandler);
    return { companyId, mainId, workerId, projectId, owner, conversationId, originRunId, taskId, failedRunId, action, workspace, read, route, app };
  }

  it.each(["owner", "stale", "member"])("requires Owner and current revision for receipt recheck: %s", async kind => {
    const f = await fixture(); await f.route();
    const action = await f.read(), state = creatorRecovery(action.evidence)!;
    if (kind === "member") await db.update(companyMemberships).set({ membershipRole: "member" })
      .where(eq(companyMemberships.companyId, f.companyId));
    const body = { actionId: action.id, failedRunId: f.failedRunId, requestKey: randomUUID(), recheckDelivery: true,
      expectedActionUpdatedAt: kind === "stale" ? new Date(0).toISOString() : action.updatedAt.toISOString() };
    const response = await request(f.app).post("/api/issues/" + f.taskId + "/recovery-actions/notify-creator").send(body);
    expect(response.status).toBe(kind === "owner" ? 200 : kind === "stale" ? 409 : 403);
    const after = await f.read();
    expect(creatorRecovery(after.evidence)).toEqual(state);
    if (kind === "owner") expect(after.evidence.workspaceDeliveryRecheck).toMatchObject({
      requestKey: body.requestKey, wakeId: state.noticeWakeId, outcome: "delivery_unknown",
    });
    else expect(after.evidence).toEqual(action.evidence);
  });

  // Recovery now selects an open registered linked tree or session-only for
  // external resources; a configured source is no longer an execution tree.
  it.each(["session_only", "open", "foreign_project", "foreign_company", "converging", "unregistered", "configured_source"])(
    "enforces repair selection and atomic admission: %s", async kind => {
      const f = await fixture(); await f.route();
      let companyId = f.companyId, projectId = f.projectId;
      if (kind === "foreign_company") {
        companyId = randomUUID();
        await db.insert(companies).values({ id: companyId, name: "Foreign", issuePrefix: "F" + companyId.slice(0,6) });
      }
      if (kind === "foreign_company" || kind === "foreign_project") {
        projectId = randomUUID();
        await db.insert(projects).values({ id: projectId, companyId, name: "Foreign project" });
      }
      const [tree] = await db.insert(executionWorkspaces).values({ companyId, projectId, name: "Registered tree",
        mode: "shared_workspace", strategyType: "git_worktree", cwd: "/owned/trees/recovery",
        metadata: kind === "unregistered" ? {} : { mainManagedWorktree: { schema: MAIN_MANAGED_WORKTREE_SCHEMA,
          phase: kind === "converging" ? "converging" : "open", sourceCwd: "/owned/source", parentDir: "/owned/trees",
          branch: "michael/recovery", targetBranch: "michael/main", hostId: null, pendingOperationId: null, participants: {} } },
      }).returning();
      const selection = kind === "session_only" ? { kind: "session_only" } : kind === "configured_source"
        ? { kind: "configured_source", projectWorkspaceId: f.workspace.id, mode: "shared" }
        : { kind: "existing", workspaceId: tree.id };
      const body = { actionId: f.action.id, outcome: "restored", sourceIssueStatus: "todo", resolutionNote: "Use the selected authorized workspace.",
        workspaceRepair: { failedRunId: f.failedRunId, expectedBindingRevision: 0, selection } };
      const url = "/api/issues/" + f.taskId + "/recovery-actions/resolve";
      const response = await request(f.app).post(url).send(body);
      const [task] = await db.select().from(issues).where(eq(issues.id, f.taskId));
      const action = await f.read();
      // Liveness-first: an unregistered or converging tree is a directory like
      // any other; only foreign company/project selections still refuse.
      if (kind === "session_only" || kind === "open" || kind === "converging" || kind === "unregistered") {
        expect(response.body.error ?? response.status).toBe(200);
        expect(task).toMatchObject({ status: "todo", workspaceBindingRevision: 1,
          workspacePendingSelection: { intent: { selection } } });
        expect(creatorRecovery(action.evidence)?.repair).toMatchObject({ status: "pending", bindingRevision: 1, selection });
        expect((await request(f.app).post(url).send(body)).status).toBe(200);
        const conflicting = await request(f.app).post(url).send({ ...body,
          workspaceRepair: { ...body.workspaceRepair, expectedBindingRevision: 1 } });
        expect(conflicting.status).toBe(409);
        expect((await f.read()).evidence).toEqual(action.evidence);
      } else {
        expect(response.status).toBe(403);
        expect(task).toMatchObject({ status: "blocked", workspaceBindingRevision: 0, workspacePendingSelection: null });
        expect(action.status).toBe("active");
        expect(creatorRecovery(action.evidence)?.repair).toBeUndefined();
      }
    });
});
