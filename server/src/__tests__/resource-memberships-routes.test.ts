import { randomUUID } from "node:crypto";
import express from "express";
import { eq } from "drizzle-orm";
import request from "supertest";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import {
  activityLog,
  agentMemberships,
  agents,
  companies,
  createDb,
  documentMemberships,
  documents,
  projectMemberships,
  userCompanyPreferences,
  projects,
} from "@paperclipai/db";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";
import { resourceMembershipRoutes } from "../routes/resource-memberships.js";
import { errorHandler } from "../middleware/index.js";
import { resourceMembershipService } from "../services/resource-memberships.js";

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

if (!embeddedPostgresSupport.supported) {
  console.warn(
    `Skipping embedded Postgres resource membership tests on this host: ${embeddedPostgresSupport.reason ?? "unsupported environment"}`,
  );
}

function boardActor(companyId: string, role: "admin" | "operator" | "viewer" = "viewer") {
  return {
    type: "board" as const,
    userId: "user-1",
    source: "session" as const,
    isInstanceAdmin: false,
    companyIds: [companyId],
    memberships: [{ companyId, membershipRole: role, status: "active" }],
  };
}

function createApp(db: ReturnType<typeof createDb>, actor: Express.Request["actor"]) {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    req.actor = actor;
    next();
  });
  app.use("/api", resourceMembershipRoutes(db));
  app.use(errorHandler);
  return app;
}

describeEmbeddedPostgres("resource membership routes", () => {
  let db!: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-resource-memberships-");
    db = createDb(tempDb.connectionString);
  }, 20_000);

  afterEach(async () => {
    await db.delete(activityLog);
    await db.delete(documentMemberships);
    await db.delete(projectMemberships);
    await db.delete(agentMemberships);
    await db.delete(documents);
    await db.delete(projects);
    await db.delete(agents);
    await db.delete(companies);
  });

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  async function seed() {
    const companyId = randomUUID();
    const otherCompanyId = randomUUID();
    const projectId = randomUUID();
    const otherProjectId = randomUUID();
    const archivedProjectId = randomUUID();
    const agentId = randomUUID();
    const otherAgentId = randomUUID();
    const terminatedAgentId = randomUUID();
    const documentId = randomUUID();
    const otherDocumentId = randomUUID();
    await db.insert(companies).values([
      {
        id: companyId,
        name: "Paperclip",
        issuePrefix: `T${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
        requireBoardApprovalForNewAgents: false,
      },
      {
        id: otherCompanyId,
        name: "Other",
        issuePrefix: `T${otherCompanyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
        requireBoardApprovalForNewAgents: false,
      },
    ]);
    await db.insert(documents).values([
      { id: documentId, companyId, title: "Plan", latestBody: "Plan body", createdByUserId: "user-1" },
      { id: otherDocumentId, companyId: otherCompanyId, title: "Other", latestBody: "Other body" },
    ]);
    await db.insert(projects).values([
      { id: projectId, companyId, name: "Growth", status: "in_progress" },
      { id: archivedProjectId, companyId, name: "Archived", status: "completed", archivedAt: new Date() },
      { id: otherProjectId, companyId: otherCompanyId, name: "Other", status: "in_progress" },
    ]);
    await db.insert(agents).values([
      {
        id: agentId,
        companyId,
        name: "CodexCoder",
        role: "engineer",
        status: "active",
        adapterType: "codex_local",
        adapterConfig: {},
        runtimeConfig: {},
        permissions: {},
      },
      {
        id: otherAgentId,
        companyId: otherCompanyId,
        name: "OtherAgent",
        role: "engineer",
        status: "active",
        adapterType: "codex_local",
        adapterConfig: {},
        runtimeConfig: {},
        permissions: {},
      },
      {
        id: terminatedAgentId,
        companyId,
        name: "Terminated",
        role: "engineer",
        status: "terminated",
        adapterType: "codex_local",
        adapterConfig: {},
        runtimeConfig: {},
        permissions: {},
      },
    ]);
    return {
      archivedProjectId,
      companyId,
      documentId,
      otherAgentId,
      otherDocumentId,
      otherProjectId,
      projectId,
      agentId,
      terminatedAgentId,
    };
  }

  it("defaults missing membership rows to joined", async () => {
    const { companyId } = await seed();
    const app = createApp(db, boardActor(companyId));

    const res = await request(app).get(`/api/companies/${companyId}/resource-memberships/me`);

    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      projectMemberships: {},
      agentMemberships: {},
      agentChatPins: {},
      starredProjectIds: [],
      starredAgentIds: [],
      starredDocumentIds: [],
      projectStarredAt: {},
      agentStarredAt: {},
      documentStarredAt: {},
      updatedAt: null,
    });
  });

  it("allows viewer self-service mutations, logs changes, and keeps repeats idempotent", async () => {
    const { companyId, projectId } = await seed();
    const app = createApp(db, boardActor(companyId, "viewer"));

    const first = await request(app)
      .put(`/api/companies/${companyId}/resource-memberships/me/projects/${projectId}`)
      .send({ state: "left" });
    const second = await request(app)
      .put(`/api/companies/${companyId}/resource-memberships/me/projects/${projectId}`)
      .send({ state: "left" });

    expect(first.status).toBe(200);
    expect(first.body).toMatchObject({ resourceType: "project", resourceId: projectId, state: "left", starredAt: null });
    expect(second.status).toBe(200);

    const rows = await db.select().from(projectMemberships);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ companyId, projectId, userId: "user-1", state: "left" });

    const activity = await db.select().from(activityLog);
    expect(activity).toHaveLength(1);
    expect(activity[0]).toMatchObject({
      companyId,
      actorType: "user",
      actorId: "user-1",
      action: "resource_membership.left",
      entityType: "project",
      entityId: projectId,
    });
  });

  it("stars projects idempotently and exposes starred project contract data", async () => {
    const { companyId, projectId } = await seed();
    const app = createApp(db, boardActor(companyId, "viewer"));

    const first = await request(app)
      .put(`/api/companies/${companyId}/resource-memberships/me/projects/${projectId}`)
      .send({ starred: true });
    const second = await request(app)
      .put(`/api/companies/${companyId}/resource-memberships/me/projects/${projectId}`)
      .send({ starred: true });
    const list = await request(app).get(`/api/companies/${companyId}/resource-memberships/me`);

    expect(first.status).toBe(200);
    expect(first.body).toMatchObject({ resourceType: "project", resourceId: projectId, state: "joined" });
    expect(first.body.starredAt).toEqual(expect.any(String));
    expect(second.status).toBe(200);
    expect(second.body.starredAt).toBe(first.body.starredAt);
    expect(list.body.starredProjectIds).toEqual([projectId]);
    expect(list.body.projectStarredAt[projectId]).toEqual(first.body.starredAt);

    const rows = await db.select().from(projectMemberships);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ companyId, projectId, userId: "user-1", state: "joined" });
    expect(rows[0]?.starredAt).toBeInstanceOf(Date);

    const activity = await db.select().from(activityLog);
    expect(activity).toHaveLength(1);
    expect(activity[0]).toMatchObject({
      action: "resource_membership.starred",
      entityType: "project",
      entityId: projectId,
    });
    expect(activity[0]?.details).toMatchObject({
      userId: "user-1",
      resourceType: "project",
      resourceId: projectId,
      state: "joined",
      starred: true,
    });
  });

  it("clears starred_at when leaving a starred resource", async () => {
    const { companyId, projectId } = await seed();
    const app = createApp(db, boardActor(companyId));

    await request(app)
      .put(`/api/companies/${companyId}/resource-memberships/me/projects/${projectId}`)
      .send({ starred: true })
      .expect(200);
    const leave = await request(app)
      .put(`/api/companies/${companyId}/resource-memberships/me/projects/${projectId}`)
      .send({ state: "left" });

    expect(leave.status).toBe(200);
    expect(leave.body).toMatchObject({ state: "left", starredAt: null });
    const [row] = await db.select().from(projectMemberships);
    expect(row).toMatchObject({ state: "left", starredAt: null });

    const activity = await db.select().from(activityLog);
    expect(activity.map((entry) => entry.action)).toEqual([
      "resource_membership.starred",
      "resource_membership.left",
    ]);
    expect(activity[1]?.details).toMatchObject({ state: "left", starred: false, starredAt: null });
  });

  it("starring a left resource rejoins it", async () => {
    const { companyId, agentId } = await seed();
    const app = createApp(db, boardActor(companyId));

    await request(app)
      .put(`/api/companies/${companyId}/resource-memberships/me/agents/${agentId}`)
      .send({ state: "left" })
      .expect(200);
    const star = await request(app)
      .put(`/api/companies/${companyId}/resource-memberships/me/agents/${agentId}`)
      .send({ starred: true });

    expect(star.status).toBe(200);
    expect(star.body).toMatchObject({ resourceType: "agent", resourceId: agentId, state: "joined" });
    expect(star.body.starredAt).toEqual(expect.any(String));

    const [row] = await db.select().from(agentMemberships);
    expect(row).toMatchObject({ state: "joined" });
    expect(row?.starredAt).toBeInstanceOf(Date);

    const activity = await db.select().from(activityLog);
    expect(activity.map((entry) => entry.action)).toEqual([
      "resource_membership.left",
      "resource_membership.starred",
    ]);
  });

  it("hides and pins a primary chat independently of its star and membership, with idempotent audit", async () => {
    const { companyId, agentId } = await seed();
    const app = createApp(db, boardActor(companyId));
    const url = `/api/companies/${companyId}/resource-memberships/me/agents/${agentId}`;
    const starredAt = new Date("2026-01-01T00:00:00Z");
    await db.insert(agentMemberships).values({ companyId, agentId, userId: "user-1", state: "joined", starredAt });
    await db.insert(userCompanyPreferences).values({ companyId, userId: "user-1", primaryAgentId: agentId, primaryAgentInitialized: true });

    const hidden = await request(app).put(url).send({ chatPinned: false }).expect(200);
    expect(hidden.body).toMatchObject({ resourceId: agentId, state: "joined", starredAt: starredAt.toISOString(), chatPinned: false });
    const repeated = await request(app).put(url).send({ chatPinned: false }).expect(200);
    expect(repeated.body.chatPinned).toBe(false);
    const list = await request(app).get(`/api/companies/${companyId}/resource-memberships/me`).expect(200);
    expect(list.body.agentChatPins).toEqual({ [agentId]: false });
    expect(list.body.starredAgentIds).toEqual([agentId]);
    expect((await db.select().from(userCompanyPreferences).where(eq(userCompanyPreferences.companyId, companyId)))[0].primaryAgentId).toBe(agentId);
    expect((await db.select().from(agentMemberships))[0]).toMatchObject({ state: "joined", starredAt, chatPinned: false });

    const activity = await db.select().from(activityLog);
    expect(activity).toHaveLength(1);
    expect(activity[0]).toMatchObject({ action: "resource_membership.chat_unpinned", entityType: "agent", entityId: agentId });
    expect(activity[0].details).toMatchObject({ chatPinned: false, starred: true, state: "joined" });

    await request(app).put(url).send({ chatPinned: true }).expect(200);
    expect((await db.select().from(userCompanyPreferences).where(eq(userCompanyPreferences.companyId, companyId)))[0].primaryAgentId).toBe(agentId);
    expect((await db.select().from(agentMemberships))[0]).toMatchObject({ state: "joined", starredAt, chatPinned: true });
    // Joining/starring through older clients must not overwrite an explicit chat override.
    await request(app).put(url).send({ starred: false }).expect(200);
    expect((await db.select().from(agentMemberships))[0]).toMatchObject({ chatPinned: true, starredAt: null });
  });

  it("persists an unpin for an unstarred primary while ordinary leave still clears primary", async () => {
    const { companyId, agentId } = await seed();
    const app = createApp(db, boardActor(companyId));
    const url = `/api/companies/${companyId}/resource-memberships/me/agents/${agentId}`;
    await db.insert(userCompanyPreferences).values({ companyId, userId: "user-1", primaryAgentId: agentId, primaryAgentInitialized: true });
    await request(app).put(url).send({ chatPinned: false }).expect(200);
    expect((await db.select().from(agentMemberships))[0]).toMatchObject({ chatPinned: false, state: "joined", starredAt: null });
    expect((await db.select().from(userCompanyPreferences).where(eq(userCompanyPreferences.companyId, companyId)))[0].primaryAgentId).toBe(agentId);
    await request(app).put(url).send({ state: "left" }).expect(200);
    expect((await db.select().from(userCompanyPreferences).where(eq(userCompanyPreferences.companyId, companyId)))[0].primaryAgentId).toBeNull();
    expect((await db.select().from(agentMemberships))[0]).toMatchObject({ chatPinned: false, state: "left", starredAt: null });
  });

  it("pinning rejoins a left agent without starring it or selecting it as primary", async () => {
    const { companyId, agentId } = await seed();
    const app = createApp(db, boardActor(companyId));
    const url = `/api/companies/${companyId}/resource-memberships/me/agents/${agentId}`;
    await request(app).put(url).send({ state: "left" }).expect(200);
    const response = await request(app).put(url).send({ chatPinned: true }).expect(200);
    expect(response.body).toMatchObject({ state: "joined", starredAt: null, chatPinned: true });
    expect((await db.select().from(agentMemberships))[0]).toMatchObject({ state: "joined", starredAt: null, chatPinned: true });
    expect(await db.select().from(userCompanyPreferences).where(eq(userCompanyPreferences.companyId, companyId))).toEqual([]);
    const list = await request(app).get(`/api/companies/${companyId}/resource-memberships/me`).expect(200);
    expect(list.body.agentChatPins).toEqual({ [agentId]: true });
    expect(list.body.starredAgentIds).toEqual([]);
  });

  it("keeps chat visibility personal and defaults legacy rows to automatic selection", async () => {
    const { companyId, agentId } = await seed();
    const app = createApp(db, boardActor(companyId));
    const second = createApp(db, { ...boardActor(companyId), userId: "user-2" });
    const url = `/api/companies/${companyId}/resource-memberships/me/agents/${agentId}`;
    await request(app).put(url).send({ starred: true }).expect(200);
    const auto = await request(app).get(`/api/companies/${companyId}/resource-memberships/me`).expect(200);
    expect(auto.body.agentChatPins).toEqual({});
    expect((await db.select().from(agentMemberships))[0].chatPinned).toBeNull();
    await request(app).put(url).send({ chatPinned: false }).expect(200);
    await request(second).put(url).send({ chatPinned: true }).expect(200);
    const firstList = await request(app).get(`/api/companies/${companyId}/resource-memberships/me`).expect(200);
    const secondList = await request(second).get(`/api/companies/${companyId}/resource-memberships/me`).expect(200);
    expect(firstList.body.agentChatPins).toEqual({ [agentId]: false });
    expect(secondList.body.agentChatPins).toEqual({ [agentId]: true });
  });

  it("keeps chat-pin writes within board-self company scope and rejects contradictory leave", async () => {
    const { companyId, agentId, otherAgentId, terminatedAgentId } = await seed();
    const app = createApp(db, boardActor(companyId));
    const path = (id: string) => `/api/companies/${companyId}/resource-memberships/me/agents/${id}`;
    await request(app).put(path(agentId)).send({ state: "left", chatPinned: true }).expect(400);
    await request(app).put(path(agentId)).send({ chatPinned: false, userId: "other-user" }).expect(400);
    await request(app).put(path(otherAgentId)).send({ chatPinned: true }).expect(404);
    await request(app).put(path(terminatedAgentId)).send({ chatPinned: true }).expect(404);
    const agentApp = createApp(db, { type: "agent", agentId, companyId, source: "agent_key" });
    await request(agentApp).put(path(agentId)).send({ chatPinned: false }).expect(403);
    const outsider = createApp(db, { ...boardActor(companyId), memberships: [], companyIds: [] });
    await request(outsider).put(path(agentId)).send({ chatPinned: true }).expect(403);
    await expect(resourceMembershipService(db).updateAgent({ companyId, agentId, userId: "other-user", chatPinned: true, actor: boardActor(companyId) })).rejects.toMatchObject({ status: 403 });
    expect(await db.select().from(agentMemberships)).toEqual([]);
  });

  it("unstars agents idempotently without requiring a state change", async () => {
    const { companyId, agentId } = await seed();
    const app = createApp(db, boardActor(companyId));

    await request(app)
      .put(`/api/companies/${companyId}/resource-memberships/me/agents/${agentId}`)
      .send({ starred: true })
      .expect(200);
    const first = await request(app)
      .put(`/api/companies/${companyId}/resource-memberships/me/agents/${agentId}`)
      .send({ starred: false });
    const second = await request(app)
      .put(`/api/companies/${companyId}/resource-memberships/me/agents/${agentId}`)
      .send({ starred: false });

    expect(first.status).toBe(200);
    expect(first.body).toMatchObject({ state: "joined", starredAt: null });
    expect(second.status).toBe(200);
    expect(second.body).toMatchObject({ state: "joined", starredAt: null });

    const [row] = await db.select().from(agentMemberships);
    expect(row).toMatchObject({ state: "joined", starredAt: null });

    const activity = await db.select().from(activityLog);
    expect(activity.map((entry) => entry.action)).toEqual([
      "resource_membership.starred",
      "resource_membership.unstarred",
    ]);
  });

  it("omits archived projects and terminated agents from starred sidebar data", async () => {
    const { archivedProjectId, companyId, terminatedAgentId } = await seed();
    const starredAt = new Date();
    await db.insert(projectMemberships).values({
      companyId,
      projectId: archivedProjectId,
      userId: "user-1",
      state: "joined",
      starredAt,
    });
    await db.insert(agentMemberships).values({
      companyId,
      agentId: terminatedAgentId,
      chatPinned: true,
      userId: "user-1",
      state: "joined",
      starredAt,
    });
    const app = createApp(db, boardActor(companyId));

    const res = await request(app).get(`/api/companies/${companyId}/resource-memberships/me`);

    expect(res.status).toBe(200);
    expect(res.body.projectMemberships[archivedProjectId]).toBe("joined");
    expect(res.body.agentMemberships[terminatedAgentId]).toBe("joined");
    expect(res.body.starredProjectIds).toEqual([]);
    expect(res.body.starredAgentIds).toEqual([]);
    expect(res.body.agentChatPins).toEqual({});
    expect(res.body.projectStarredAt).toEqual({});
    expect(res.body.agentStarredAt).toEqual({});
  });

  it("rejects starring archived projects and terminated agents", async () => {
    const { archivedProjectId, companyId, terminatedAgentId } = await seed();
    const app = createApp(db, boardActor(companyId));

    const projectRes = await request(app)
      .put(`/api/companies/${companyId}/resource-memberships/me/projects/${archivedProjectId}`)
      .send({ starred: true });
    const agentRes = await request(app)
      .put(`/api/companies/${companyId}/resource-memberships/me/agents/${terminatedAgentId}`)
      .send({ starred: true });

    expect(projectRes.status).toBe(404);
    expect(agentRes.status).toBe(404);
  });

  it("rejects agent API key actors", async () => {
    const { companyId, agentId } = await seed();
    const app = createApp(db, {
      type: "agent",
      agentId,
      companyId,
      source: "agent_key",
    });

    const res = await request(app).get(`/api/companies/${companyId}/resource-memberships/me`);

    expect(res.status).toBe(403);
  });

  it("rejects cross-company target resources", async () => {
    const { companyId, otherAgentId, otherProjectId } = await seed();
    const app = createApp(db, boardActor(companyId));

    const projectRes = await request(app)
      .put(`/api/companies/${companyId}/resource-memberships/me/projects/${otherProjectId}`)
      .send({ state: "left" });
    const agentRes = await request(app)
      .put(`/api/companies/${companyId}/resource-memberships/me/agents/${otherAgentId}`)
      .send({ state: "left" });

    expect(projectRes.status).toBe(404);
    expect(agentRes.status).toBe(404);
    await expect(db.select().from(projectMemberships)).resolves.toHaveLength(0);
    await expect(db.select().from(agentMemberships)).resolves.toHaveLength(0);
  });

  it("denies direct service calls that try to mutate another user's membership", async () => {
    const { companyId, projectId } = await seed();
    const svc = resourceMembershipService(db);

    await expect(
      svc.updateProject({
        companyId,
        projectId,
        userId: "other-user",
        state: "left",
        actor: boardActor(companyId),
      }),
    ).rejects.toMatchObject({ status: 403 });
  });

  it("stars and unstars documents idempotently and cascades on document deletion", async () => {
    const { companyId, documentId } = await seed();
    const app = createApp(db, boardActor(companyId));

    const [first, second] = await Promise.all([
      request(app)
        .put(`/api/companies/${companyId}/resource-memberships/me/documents/${documentId}`)
        .send({ starred: true }),
      request(app)
        .put(`/api/companies/${companyId}/resource-memberships/me/documents/${documentId}`)
        .send({ starred: true }),
    ]);
    const list = await request(app).get(`/api/companies/${companyId}/resource-memberships/me`);

    expect(first.status).toBe(200);
    expect(first.body).toMatchObject({ resourceType: "document", resourceId: documentId, starredAt: expect.any(String) });
    expect(second.status).toBe(200);
    expect(second.body.starredAt).toBe(first.body.starredAt);
    expect(list.body.starredDocumentIds).toEqual([documentId]);
    expect(list.body.documentStarredAt[documentId]).toBe(first.body.starredAt);
    await expect(db.select().from(documentMemberships)).resolves.toHaveLength(1);

    const unstars = await Promise.all([
      request(app)
        .put(`/api/companies/${companyId}/resource-memberships/me/documents/${documentId}`)
        .send({ starred: false }),
      request(app)
        .put(`/api/companies/${companyId}/resource-memberships/me/documents/${documentId}`)
        .send({ starred: false }),
    ]);
    expect(unstars.map((response) => response.status)).toEqual([200, 200]);
    await expect(db.select().from(documentMemberships)).resolves.toHaveLength(0);

    await request(app)
      .put(`/api/companies/${companyId}/resource-memberships/me/documents/${documentId}`)
      .send({ starred: true })
      .expect(200);
    await db.delete(documents).where(eq(documents.id, documentId));
    await expect(db.select().from(documentMemberships)).resolves.toHaveLength(0);

    const activity = await db.select().from(activityLog);
    expect(activity.map((entry) => entry.action)).toEqual([
      "resource_membership.starred",
      "resource_membership.unstarred",
      "resource_membership.starred",
    ]);
    expect(activity[0]).toMatchObject({ entityType: "document", entityId: documentId });
  });

  it("returns identical 404s for cross-company documents", async () => {
    const { companyId, otherDocumentId } = await seed();
    const app = createApp(db, boardActor(companyId));

    const response = await request(app)
      .put(`/api/companies/${companyId}/resource-memberships/me/documents/${otherDocumentId}`)
      .send({ starred: true });

    expect(response.status).toBe(404);
    expect(response.body.error).toBe("Document not found");
    await expect(db.select().from(documentMemberships)).resolves.toHaveLength(0);
  });
});
