import { randomUUID } from "node:crypto";
import { eq, sql } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { EXTERNAL_API_BILLING_CODE } from "@paperclipai/shared";
import {
  agents, budgetEvaluationWork, budgetPolicies, companies, createDb, heartbeatRuns, issues, projects, type Db,
} from "@paperclipai/db";
import { getEmbeddedPostgresTestSupport, startEmbeddedPostgresTestDatabase } from "./helpers/embedded-postgres.js";
import { costService } from "../services/costs.ts";
import { budgetService, computeObservedSpend } from "../services/budgets.ts";
import { resolveLedgerScopeForRun } from "../services/heartbeat.ts";

const support = await getEmbeddedPostgresTestSupport();

(support.supported ? describe : describe.skip)("project attribution of a main agent's Chat spend", () => {
  let database: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>>;
  let db: Db;
  beforeAll(async () => {
    database = await startEmbeddedPostgresTestDatabase("project-cost-attribution-");
    db = createDb(database.connectionString);
  }, 60_000);
  afterEach(async () => { await db.execute(sql`TRUNCATE companies CASCADE`); });
  afterAll(async () => { await database?.cleanup(); });

  async function company(name: string) {
    const id = randomUUID();
    await db.insert(companies).values({ id, name, issuePrefix: `P${id.replace(/-/g, "").slice(0, 6).toUpperCase()}` });
    return id;
  }
  async function agent(companyId: string, name = "Main") {
    const id = randomUUID();
    await db.insert(agents).values({ id, companyId, name, adapterType: "codex_local" });
    return id;
  }
  async function project(companyId: string, leadAgentId: string | null, extra: Partial<typeof projects.$inferInsert> = {}) {
    const id = randomUUID();
    await db.insert(projects).values({ id, companyId, name: "main", leadAgentId, ...extra });
    return id;
  }
  async function chat(companyId: string, agentId: string) {
    const id = randomUUID();
    await db.insert(issues).values({ id, companyId, title: "Chat", status: "in_progress", assigneeAgentId: agentId,
      conversationAgentId: agentId, conversationUserId: `user-${randomUUID()}`, conversationState: "waiting" });
    return id;
  }
  function spend(companyId: string, agentId: string, costCents: number, extra: { issueId?: string; projectId?: string; billingCode?: string } = {}) {
    return costService(db).createEvent(companyId, { agentId, provider: "openai", biller: "openai", billingType: "metered_api",
      model: "gpt", costStatus: "reported", costCents, inputTokens: 1, outputTokens: 1, occurredAt: new Date(), ...extra });
  }
  async function projectPolicy(companyId: string, projectId: string, amount = 1_000) {
    const [policy] = await db.insert(budgetPolicies).values({ companyId, scopeType: "project", scopeId: projectId,
      metric: "billed_cents", windowKind: "lifetime", amount, notifyEnabled: false }).returning();
    return policy;
  }
  const byProject = async (companyId: string) =>
    Object.fromEntries((await costService(db).byProject(companyId)).map(row => [row.projectId ?? "none", row.costCents]));

  it("attributes Chat spend to the single project the conversation agent leads", async () => {
    const companyId = await company("Home");
    const main = await agent(companyId);
    const projectId = await project(companyId, main);
    await project(companyId, main, { archivedAt: new Date() });
    const chatId = await chat(companyId, main);
    const policy = await projectPolicy(companyId, projectId);

    await spend(companyId, main, 150, { issueId: chatId });

    expect(await byProject(companyId)).toEqual({ [projectId]: 150 });
    expect(await computeObservedSpend(db, policy)).toMatchObject({ ledgerCents: "150.0000000" });
    // Budget evaluation is queued for the derived project.
    const work = await db.select().from(budgetEvaluationWork).where(eq(budgetEvaluationWork.companyId, companyId));
    expect(work.map(row => row.projectId)).toContain(projectId);
    // A run of the Chat issue carries the project in its ledger scope.
    const [run] = await db.insert(heartbeatRuns).values({ companyId, agentId: main, status: "queued",
      contextSnapshot: { issueId: chatId } }).returning();
    expect(await resolveLedgerScopeForRun(db, companyId, run)).toMatchObject({ issueId: chatId, projectId });
  });

  it("defers Chat runs behind the lead project's reached hard stop", async () => {
    const companyId = await company("Home");
    const main = await agent(companyId);
    const projectId = await project(companyId, main);
    const chatId = await chat(companyId, main);
    await projectPolicy(companyId, projectId, 100);
    expect(await budgetService(db).getInvocationBlock(companyId, main, { issueId: chatId })).toBeNull();

    await spend(companyId, main, 150, { issueId: chatId });

    expect(await budgetService(db).getInvocationBlock(companyId, main, { issueId: chatId }))
      .toMatchObject({ scopeType: "project", scopeId: projectId });
  });

  it("leaves Chat spend unattributed when the agent leads several projects", async () => {
    const companyId = await company("Home");
    const main = await agent(companyId);
    const first = await project(companyId, main);
    const second = await project(companyId, main);
    const chatId = await chat(companyId, main);
    const policies = [await projectPolicy(companyId, first), await projectPolicy(companyId, second)];

    await spend(companyId, main, 150, { issueId: chatId });

    expect(await byProject(companyId)).toEqual({ none: 150 });
    for (const policy of policies) expect(await computeObservedSpend(db, policy)).toMatchObject({ ledgerCents: "0.0000000" });
    const [run] = await db.insert(heartbeatRuns).values({ companyId, agentId: main, status: "queued",
      contextSnapshot: { issueId: chatId } }).returning();
    expect((await resolveLedgerScopeForRun(db, companyId, run)).projectId).toBeNull();
  });

  it("keeps attribution inside the company of the Chat issue", async () => {
    const home = await company("Home");
    const other = await company("Other");
    const main = await agent(home);
    const homeProject = await project(home, main);
    // A foreign project naming the same lead neither counts as a second
    // project nor receives the spend.
    const foreignProject = await project(other, main);
    const foreignPolicy = await projectPolicy(other, foreignProject);
    const chatId = await chat(home, main);

    await spend(home, main, 150, { issueId: chatId });

    expect(await byProject(home)).toEqual({ [homeProject]: 150 });
    expect(await byProject(other)).toEqual({});
    expect(await computeObservedSpend(db, foreignPolicy)).toMatchObject({ ledgerCents: "0.0000000" });
  });

  it("keeps an explicit event project and excludes external API spend from every project", async () => {
    const companyId = await company("Home");
    const main = await agent(companyId);
    const led = await project(companyId, main);
    const explicit = await project(companyId, null);
    const chatId = await chat(companyId, main);
    const [ledPolicy, explicitPolicy] = [await projectPolicy(companyId, led), await projectPolicy(companyId, explicit)];

    await spend(companyId, main, 40, { issueId: chatId, projectId: explicit });
    await spend(companyId, main, 7, { issueId: chatId, projectId: explicit, billingCode: EXTERNAL_API_BILLING_CODE });
    await spend(companyId, main, 9, { issueId: chatId, billingCode: EXTERNAL_API_BILLING_CODE });

    // External API spend has its own report and never appears under Unattributed.
    expect(await byProject(companyId)).toEqual({ [explicit]: 40 });
    expect(await computeObservedSpend(db, explicitPolicy)).toMatchObject({ ledgerCents: "40.0000000" });
    expect(await computeObservedSpend(db, ledPolicy)).toMatchObject({ ledgerCents: "0.0000000" });
    expect(await costService(db).summary(companyId)).toMatchObject({ spendCents: 56 });
    expect((await costService(db).byAgent(companyId))[0]).toMatchObject({ agentId: main, costCents: 56 });
    const work = await db.select().from(budgetEvaluationWork).where(eq(budgetEvaluationWork.companyId, companyId));
    expect(work.filter(row => row.projectId === led)).toHaveLength(0);
  });
});
