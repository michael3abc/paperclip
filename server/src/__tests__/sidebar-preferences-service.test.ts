import { randomUUID } from "node:crypto";
import express from "express";
import request from "supertest";
import { and, eq, sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { activityLog, companies, companyUserSidebarPreferences, createDb } from "@paperclipai/db";
import { getEmbeddedPostgresTestSupport, startEmbeddedPostgresTestDatabase } from "./helpers/embedded-postgres.js";
import { errorHandler } from "../middleware/index.js";
import { sidebarPreferenceRoutes } from "../routes/sidebar-preferences.js";
import { sidebarPreferenceService } from "../services/sidebar-preferences.js";

const support = await getEmbeddedPostgresTestSupport();
if (!support.supported) console.warn(`Sidebar preference database tests unavailable: ${support.reason}`);

const PROJECT_A = "11111111-1111-4111-8111-111111111111";
const PROJECT_B = "22222222-2222-4222-8222-222222222222";
const AGENT_A = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const AGENT_B = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";

(support.supported ? describe : describe.skip)("company sidebar preferences (PM status exclusions)", () => {
  let db: ReturnType<typeof createDb>;
  let temp: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>>;

  beforeAll(async () => {
    temp = await startEmbeddedPostgresTestDatabase("paperclip-sidebar-preferences-");
    db = createDb(temp.connectionString);
  }, 30_000);
  afterAll(async () => {
    await temp?.cleanup();
  });

  const actor = (
    companyId: string,
    userId: string,
    membershipRole: "owner" | "viewer" = "owner",
  ): Express.Request["actor"] => ({
    type: "board",
    source: "session",
    userId,
    companyIds: [companyId],
    memberships: [{ companyId, membershipRole, status: "active" }],
  });
  const app = (identity: Express.Request["actor"]) => {
    const result = express();
    result.use(express.json());
    result.use((req, _res, next) => {
      req.actor = identity;
      next();
    });
    result.use("/api", sidebarPreferenceRoutes(db));
    result.use(errorHandler);
    return result;
  };
  async function company() {
    const id = randomUUID();
    await db.insert(companies).values({ id, name: "Sidebar preference test", issuePrefix: `S${id.slice(0, 7)}` });
    return id;
  }
  const url = (companyId: string) => `/api/companies/${companyId}/sidebar-preferences/me`;

  it("defaults to an empty exclusion list without creating a row, so every project PM keeps its status", async () => {
    const companyId = await company();
    const userId = randomUUID();

    const viaService = await sidebarPreferenceService(db).getProjectOrder(companyId, userId);
    const viaRoute = await request(app(actor(companyId, userId))).get(url(companyId)).expect(200);

    expect(viaService).toEqual({ orderedIds: [], excludedPmStatusAgentIds: [], updatedAt: null });
    expect(viaRoute.body).toEqual({ orderedIds: [], excludedPmStatusAgentIds: [], updatedAt: null });
    expect(
      await db.select().from(companyUserSidebarPreferences).where(eq(companyUserSidebarPreferences.userId, userId)),
    ).toHaveLength(0);
  });

  it("applies the additive column with a default [] to rows written before the column existed", async () => {
    const companyId = await company();
    const userId = randomUUID();
    // A previous-release insert names no exclusion column; the NOT NULL default must fill it.
    await db.execute(sql`
      INSERT INTO company_user_sidebar_preferences (company_id, user_id, project_order)
      VALUES (${companyId}, ${userId}, ${JSON.stringify([PROJECT_A])}::jsonb)
    `);

    const stored = await sidebarPreferenceService(db).getProjectOrder(companyId, userId);

    expect(stored.orderedIds).toEqual([PROJECT_A]);
    expect(stored.excludedPmStatusAgentIds).toEqual([]);
  });

  it("keeps the exclusion list when a legacy orderedIds-only PUT reorders projects", async () => {
    const companyId = await company();
    const userId = randomUUID();
    const owner = app(actor(companyId, userId));

    await request(owner).put(url(companyId)).send({ excludedPmStatusAgentIds: [AGENT_A, AGENT_B] }).expect(200);
    const reordered = await request(owner)
      .put(url(companyId))
      .send({ orderedIds: [PROJECT_B, PROJECT_A] }) // exactly what the project drag-reorder / company import send
      .expect(200);

    expect(reordered.body.orderedIds).toEqual([PROJECT_B, PROJECT_A]);
    expect(reordered.body.excludedPmStatusAgentIds).toEqual([AGENT_A, AGENT_B]);
    const reread = await request(owner).get(url(companyId)).expect(200);
    expect(reread.body).toMatchObject({
      orderedIds: [PROJECT_B, PROJECT_A],
      excludedPmStatusAgentIds: [AGENT_A, AGENT_B],
    });
  });

  it("keeps the project order when only the exclusion list is written, and can clear it", async () => {
    const companyId = await company();
    const userId = randomUUID();
    const owner = app(actor(companyId, userId));

    await request(owner).put(url(companyId)).send({ orderedIds: [PROJECT_A, PROJECT_B] }).expect(200);
    const excluded = await request(owner).put(url(companyId)).send({ excludedPmStatusAgentIds: [AGENT_A] }).expect(200);
    expect(excluded.body).toMatchObject({ orderedIds: [PROJECT_A, PROJECT_B], excludedPmStatusAgentIds: [AGENT_A] });

    const cleared = await request(owner).put(url(companyId)).send({ excludedPmStatusAgentIds: [] }).expect(200);
    expect(cleared.body).toMatchObject({ orderedIds: [PROJECT_A, PROJECT_B], excludedPmStatusAgentIds: [] });
  });

  it("normalizes duplicates and refuses malformed or empty payloads", async () => {
    const companyId = await company();
    const userId = randomUUID();
    const owner = app(actor(companyId, userId));

    const saved = await request(owner)
      .put(url(companyId))
      .send({ excludedPmStatusAgentIds: [AGENT_A, AGENT_B, AGENT_A] })
      .expect(200);
    expect(saved.body.excludedPmStatusAgentIds).toEqual([AGENT_A, AGENT_B]);

    await request(owner).put(url(companyId)).send({}).expect(400);
    await request(owner).put(url(companyId)).send({ excludedPmStatusAgentIds: ["momo"] }).expect(400);
    await request(owner).put(url(companyId)).send({ excludedPmStatusAgentIds: "all" }).expect(400);
    expect((await request(owner).get(url(companyId)).expect(200)).body.excludedPmStatusAgentIds).toEqual([
      AGENT_A,
      AGENT_B,
    ]);
  });

  it("scopes the list to the signed-in user and company and audits the write", async () => {
    const first = await company();
    const second = await company();
    const userId = randomUUID();
    const otherUser = randomUUID();

    await request(app(actor(first, userId))).put(url(first)).send({ excludedPmStatusAgentIds: [AGENT_A] }).expect(200);

    // Same company, another person: untouched default.
    expect((await request(app(actor(first, otherUser))).get(url(first)).expect(200)).body.excludedPmStatusAgentIds).toEqual(
      [],
    );
    // Same person, another company: untouched default.
    expect((await request(app(actor(second, userId))).get(url(second)).expect(200)).body.excludedPmStatusAgentIds).toEqual(
      [],
    );
    // Read-only (viewer) membership keeps the existing company write rule: may read, may not write.
    await request(app(actor(first, otherUser, "viewer"))).get(url(first)).expect(200);
    await request(app(actor(first, otherUser, "viewer")))
      .put(url(first))
      .send({ excludedPmStatusAgentIds: [AGENT_B] })
      .expect(403);
    // No membership in the target company: refused, nothing written.
    await request(app(actor(second, userId)))
      .put(url(first))
      .send({ excludedPmStatusAgentIds: [AGENT_B] })
      .expect(403);
    await request(app({ type: "agent", source: "agent_key", companyId: first, agentId: randomUUID() }))
      .put(url(first))
      .send({ excludedPmStatusAgentIds: [AGENT_B] })
      .expect(403);
    expect((await sidebarPreferenceService(db).getProjectOrder(first, userId)).excludedPmStatusAgentIds).toEqual([
      AGENT_A,
    ]);

    const events = await db
      .select()
      .from(activityLog)
      .where(
        and(
          eq(activityLog.companyId, first),
          eq(activityLog.action, "sidebar_preferences.pm_status_exclusions_updated"),
        ),
      );
    expect(events).toHaveLength(1);
    expect(events[0]?.details).toEqual({ userId, excludedPmStatusAgentIds: [AGENT_A] });
  });
});
