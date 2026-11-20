import { randomUUID } from "node:crypto";
import { sql } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { EXTERNAL_API_BILLING_CODE } from "@paperclipai/shared";
import { agents, companies, createDb, issues, projects, type Db } from "@paperclipai/db";
import { getEmbeddedPostgresTestSupport, startEmbeddedPostgresTestDatabase } from "./helpers/embedded-postgres.js";
import { costService } from "../services/costs.ts";

const support = await getEmbeddedPostgresTestSupport();

(support.supported ? describe : describe.skip)("self-reported external API cost report", () => {
  let database: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>>;
  let db: Db;
  beforeAll(async () => {
    database = await startEmbeddedPostgresTestDatabase("external-api-costs-");
    db = createDb(database.connectionString);
  }, 60_000);
  afterEach(async () => { await db.execute(sql`TRUNCATE companies CASCADE`); });
  afterAll(async () => { await database?.cleanup(); });

  async function company(name: string) {
    const id = randomUUID();
    await db.insert(companies).values({ id, name, issuePrefix: `X${id.replace(/-/g, "").slice(0, 6).toUpperCase()}` });
    return id;
  }
  async function agent(companyId: string, name: string) {
    const id = randomUUID();
    await db.insert(agents).values({ id, companyId, name, adapterType: "codex_local" });
    return id;
  }
  async function issue(companyId: string) {
    const id = randomUUID();
    await db.insert(issues).values({ id, companyId, title: "Research", status: "in_progress" });
    return id;
  }
  function report(companyId: string, agentId: string, costCents: number | string, extra: {
    provider?: string; model?: string; costStatus?: "reported" | "estimated" | "unpriced"; billingCode?: string | null;
    issueId?: string; projectId?: string; occurredAt?: Date; inputTokens?: number; outputTokens?: number;
  } = {}) {
    return costService(db).createEvent(companyId, {
      agentId, provider: "serpapi", biller: "serpapi", billingType: "metered_api", model: "search",
      costStatus: "reported", costCents, inputTokens: 0, outputTokens: 0, occurredAt: new Date("2026-11-10T12:00:00Z"),
      ...extra, billingCode: extra.billingCode === undefined ? EXTERNAL_API_BILLING_CODE : extra.billingCode ?? undefined,
    });
  }
  const allTime = { allTime: true } as const;

  it("groups self-reported spend by provider, model and agent with exact cents", async () => {
    const companyId = await company("Home");
    const scout = await agent(companyId, "Scout");
    const writer = await agent(companyId, "Writer");
    const issueId = await issue(companyId);

    await report(companyId, scout, "12.5", { issueId, inputTokens: 3, outputTokens: 4 });
    await report(companyId, scout, 7, { costStatus: "estimated", occurredAt: new Date("2026-11-12T08:30:00Z") });
    await report(companyId, writer, 3, { provider: "elevenlabs", model: "tts-v3" });
    await report(companyId, writer, 30, { model: "maps" });

    const rows = await costService(db).externalApi(companyId, allTime);
    expect(rows).toEqual([
      { provider: "elevenlabs", model: "tts-v3", agentId: writer, agentName: "Writer", costCents: 3, costCentsExact: "3.0000000",
        eventCount: 1, estimatedEventCount: 0, unpricedEventCount: 0, inputTokens: 0, outputTokens: 0,
        lastOccurredAt: "2026-11-10T12:00:00.000Z" },
      { provider: "serpapi", model: "maps", agentId: writer, agentName: "Writer", costCents: 30, costCentsExact: "30.0000000",
        eventCount: 1, estimatedEventCount: 0, unpricedEventCount: 0, inputTokens: 0, outputTokens: 0,
        lastOccurredAt: "2026-11-10T12:00:00.000Z" },
      { provider: "serpapi", model: "search", agentId: scout, agentName: "Scout", costCents: 19.5, costCentsExact: "19.5000000",
        eventCount: 2, estimatedEventCount: 1, unpricedEventCount: 0, inputTokens: 3, outputTokens: 4,
        lastOccurredAt: "2026-11-12T08:30:00.000Z" },
    ]);
  });

  it("excludes events without the external API billing code, including project spend", async () => {
    const companyId = await company("Home");
    const main = await agent(companyId, "Main");
    const [projectRow] = await db.insert(projects).values({ companyId, name: "main" }).returning();

    await report(companyId, main, 40, { billingCode: null, provider: "openai", model: "gpt" });
    await report(companyId, main, 25, { billingCode: "client-x", projectId: projectRow!.id });
    await report(companyId, main, 9);

    const rows = await costService(db).externalApi(companyId, allTime);
    expect(rows.map(row => [row.provider, row.model, row.costCents])).toEqual([["serpapi", "search", 9]]);
  });

  it("stays inside the requested company", async () => {
    const home = await company("Home");
    const other = await company("Other");
    const homeAgent = await agent(home, "Scout");
    const otherAgent = await agent(other, "Foreign");

    await report(home, homeAgent, 5);
    await report(other, otherAgent, 50);

    expect((await costService(db).externalApi(home, allTime)).map(row => [row.agentName, row.costCents])).toEqual([["Scout", 5]]);
    expect((await costService(db).externalApi(other, allTime)).map(row => [row.agentName, row.costCents])).toEqual([["Foreign", 50]]);
  });

  it("applies the inclusive date range like the other cost reports", async () => {
    const companyId = await company("Home");
    const scout = await agent(companyId, "Scout");
    await report(companyId, scout, 1, { occurredAt: new Date("2026-10-31T23:59:59Z") });
    await report(companyId, scout, 2, { occurredAt: new Date("2026-11-01T00:00:00Z") });
    await report(companyId, scout, 4, { occurredAt: new Date("2026-11-30T23:59:59Z") });
    await report(companyId, scout, 8, { occurredAt: new Date("2026-12-01T00:00:00Z") });

    const [row] = await costService(db).externalApi(companyId, {
      from: new Date("2026-11-01T00:00:00Z"), to: new Date("2026-11-30T23:59:59Z"),
    });
    expect(row).toMatchObject({ costCents: 6, eventCount: 2, lastOccurredAt: "2026-11-30T23:59:59.000Z" });
    expect((await costService(db).externalApi(companyId, allTime))[0]).toMatchObject({ costCents: 15, eventCount: 4 });
  });
});
