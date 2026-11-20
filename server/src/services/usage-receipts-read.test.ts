import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { randomBytes, randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { agents, companies, createDb, heartbeatRuns, runUsageReceipts, type Db } from "@paperclipai/db";
import { getEmbeddedPostgresTestSupport, startEmbeddedPostgresTestDatabase } from "../__tests__/helpers/embedded-postgres.js";
import { withOperationAccountingTransaction } from "./accounting-transaction.js";
import { appendHeartbeatRunEvent } from "./heartbeat-run-events.js";
import { createRunUsageRecorder, persistUsageReceipt, type UsageReceiptEnvelope } from "./usage-receipts.js";

const support = await getEmbeddedPostgresTestSupport();
describe.skipIf(!support.supported)("usage receipt PostgreSQL reads", () => {
  let database: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>>;
  let db: Db;
  beforeAll(async () => {
    database = await startEmbeddedPostgresTestDatabase("usage-receipt-read-");
    db = createDb(database.connectionString);
  }, 60_000);
  afterAll(async () => { await db?.$client.end(); await database?.cleanup(); });

  async function fixture() {
    const companyId = randomUUID(), agentId = randomUUID(), runId = randomUUID(), sourceId = randomUUID();
    await db.insert(companies).values({ id: companyId, name: "Receipt fixture", issuePrefix: companyId.slice(0, 8) });
    await db.insert(agents).values({ id: agentId, companyId, name: "Receipt agent", adapterType: "process", status: "active" });
    const payload = randomBytes(128 * 1024).toString("base64");
    const evidence = { contextSnapshot: { prompt: payload }, runnerProfileJson: { instructions: payload },
      resultJson: { stdout: payload }, stdoutExcerpt: payload, stderrExcerpt: payload };
    await db.insert(heartbeatRuns).values({ id: runId, companyId, agentId, status: "running", ...evidence,
      usageJson: { accountingReceiptSourceId: sourceId, accountingReceiptSequence: 0, preserved: "receipt metadata" } });
    const receipt = (sequence: number): UsageReceiptEnvelope => ({ schema: "paperclip/accounting-receipt/v1",
      id: randomUUID(), companyId, runId, sourceId, sequence, receivedAt: new Date().toISOString(), adapterType: "process",
      receipt: { complete: false, usageBasis: "per_run", costUsd: sequence / 100, billingType: "metered_api" } });
    return { companyId, agentId, runId, evidence, receipt };
  }

  it.each([
    ["split", [100000, 200000], 300000, "5.450000000"],
    ["unknown", [undefined, undefined], undefined, "8.000000000"],
    ["mixed", [0, undefined], 1000000, "6.500000000"],
  ] as const)("preserves and sums %s TTL evidence through the recorder and immutable journal", async (_label, subsets, total, cost) => {
    const f = await fixture();
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), "ttl-receipts-"));
    try {
      const recorder = await createRunUsageRecorder(db, { companyId: f.companyId, runId: f.runId, adapterType: "ccpocket" }, directory);
      let captured;
      for (const oneHour of subsets) captured = await recorder.capture({ attemptId: randomUUID(), complete: true,
        usageBasis: "per_run", provider: "claude", biller: "compass", billingType: "metered_api", model: "compass-sonnet5.5",
        usage: { inputTokens: 1000000, outputTokens: 0, cachedInputTokens: 0, cacheWriteTokens: 1000000,
          ...(oneHour === undefined ? {} : { cacheWrite1hTokens: oneHour }) } });
      expect(captured?.usage?.cacheWriteTokens).toBe(2000000);
      expect(captured?.usage?.cacheWrite1hTokens).toBe(total);
      expect(captured?.costUsdExact).toBe(cost);
      const [stored] = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, f.runId));
      expect(stored.usageJson?.cacheWrite1hTokens).toBe(total ?? null);
      const [journal] = await db.select().from(runUsageReceipts).where(eq(runUsageReceipts.id, stored.usageJson!.accountingReceiptId as string));
      expect((journal.receiptJson as UsageReceiptEnvelope).receipt.usage?.cacheWrite1hTokens).toBe(total);
    } finally { await fs.rm(directory, { recursive: true }); }
  });

  it("clears old TTL evidence when a newer receipt no longer reports a split", async () => {
    const f = await fixture();
    const first = f.receipt(1);
    first.receipt.usage = { inputTokens: 10, outputTokens: 0, cacheWriteTokens: 10, cacheWrite1hTokens: 0 };
    await persistUsageReceipt(db, first);
    const next = f.receipt(2);
    next.receipt.usage = { inputTokens: 20, outputTokens: 0, cacheWriteTokens: 20 };
    await persistUsageReceipt(db, next);
    const [stored] = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, f.runId));
    expect(stored.usageJson?.cacheWrite1hTokens).toBeNull();
  });

  it.each([10, undefined])("retains an impossible TTL subset with total %s as incomplete", async total => {
    const f = await fixture();
    const envelope = f.receipt(1);
    envelope.receipt = { complete: true, usageBasis: "per_run", biller: "compass", model: "compass-sonnet5.5",
      usage: { inputTokens: 10, outputTokens: 1, cacheWriteTokens: total, cacheWrite1hTokens: 11 } };
    await persistUsageReceipt(db, envelope);
    const [saved] = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, f.runId));
    expect(saved.usageJson).toMatchObject({ cacheWrite1hTokens: 11, accountingReceiptReady: false });
    const [journal] = await db.select().from(runUsageReceipts).where(eq(runUsageReceipts.id, envelope.id));
    expect((journal.receiptJson as UsageReceiptEnvelope).receipt.complete).toBe(false);
  });

  it("updates live usage with a small locked read and preserves all execution evidence", async () => {
    const f = await fixture(), reads: unknown[][] = [];
    const observed = new Proxy(db, { get(target, key) {
      if (key !== "transaction") return Reflect.get(target, key);
      return (callback: Parameters<Db["transaction"]>[0], options: Parameters<Db["transaction"]>[1]) => target.transaction(tx => callback(new Proxy(tx, {
        get(transaction, property) {
          if (property !== "select") return Reflect.get(transaction, property);
          return (...fields: Parameters<Db["select"]>) => {
            const builder = transaction.select(...fields), from = builder.from.bind(builder);
            builder.from = ((...args: Parameters<typeof from>) => {
              const query = from(...args);
              if (args[0] === heartbeatRuns) {
                const execute = query.execute.bind(query);
                query.execute = async (...executeArgs: Parameters<typeof execute>) => {
                  expect(query.toSQL().sql).toContain("for update");
                  const rows = await execute(...executeArgs); reads.push(rows); return rows;
                };
              }
              return query;
            }) as typeof builder.from;
            return builder;
          };
        },
      })), options);
    } });
    await persistUsageReceipt(observed, f.receipt(1));
    expect(reads).toHaveLength(1);
    expect(reads[0]).toHaveLength(1);
    expect(Buffer.byteLength(JSON.stringify(reads))).toBeLessThan(2048);
    const [stored] = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, f.runId));
    expect(stored).toMatchObject(f.evidence);
    expect(stored.usageJson).toMatchObject({ preserved: "receipt metadata", accountingReceiptSequence: 1,
      budgetExposure: { costCents: "1.0000000" } });
    expect(Buffer.byteLength(JSON.stringify(stored))).toBeGreaterThan(512 * 1024);
  });

  it.each(["run event", "finalization"])("commits a usage receipt after concurrent %s between company validation and the run lock", async mode => {
    const f = await fixture();
    let interleavings = 0;
    const observed = new Proxy(db, { get(target, key) {
      if (key !== "transaction") return Reflect.get(target, key);
      return (callback: Parameters<Db["transaction"]>[0], options: Parameters<Db["transaction"]>[1]) =>
        target.transaction(tx => callback(new Proxy(tx, { get(transaction, property) {
          if (property !== "select") return Reflect.get(transaction, property);
          return (...fields: Parameters<Db["select"]>) => {
            const builder = transaction.select(...fields), from = builder.from.bind(builder);
            builder.from = ((...args: Parameters<typeof from>) => {
              const query = from(...args);
              if (args[0] === companies) {
                const execute = query.execute.bind(query);
                query.execute = async (...executeArgs: Parameters<typeof execute>) => {
                  const rows = await execute(...executeArgs);
                  // Commit the other writer after the snapshot starts, before
                  // the receipt can acquire the run row next.
                  if (mode === "run event") {
                    await appendHeartbeatRunEvent(db, { companyId: f.companyId, runId: f.runId,
                      agentId: f.agentId, eventType: "lifecycle", message: "stream advanced" });
                  } else {
                    await db.update(heartbeatRuns).set({ costAccountedAt: new Date(),
                      status: "succeeded", finishedAt: new Date() }).where(eq(heartbeatRuns.id, f.runId));
                  }
                  interleavings++;
                  return rows;
                };
              }
              return query;
            }) as typeof builder.from;
            return builder;
          };
        } })), options);
    } });
    const receipt = f.receipt(1);
    await expect(persistUsageReceipt(observed, receipt)).resolves.toBeUndefined();
    expect(interleavings).toBe(1);
    await persistUsageReceipt(db, receipt);
    expect(await db.select().from(runUsageReceipts).where(eq(runUsageReceipts.runId, f.runId))).toHaveLength(1);
    const [run] = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, f.runId));
    expect(run.usageJson).toMatchObject({ preserved: "receipt metadata",
      accountingReceiptSequence: mode === "run event" ? 1 : 0 });
    if (mode === "finalization") {
      expect(run.costAccountedAt).not.toBeNull();
      expect(run.status).toBe("succeeded");
      expect(run.usageJson?.accountingLateReceiptPending).toBe(true);
      expect(Object.keys(run.usageJson?.accountingLateReceiptDebts as object)).toEqual([receipt.id]);
    }
    expect(run.nextEventSeq).toBe(mode === "run event" ? 2 : 1);
    expect(run).toMatchObject(f.evidence);
  });

  it("retains the consistent snapshot for other accounting operations", async () => {
    const f = await fixture();
    const seen = await withOperationAccountingTransaction(db, f.companyId, async tx => {
      const [before] = await tx.select({ seq: heartbeatRuns.nextEventSeq }).from(heartbeatRuns).where(eq(heartbeatRuns.id, f.runId));
      await appendHeartbeatRunEvent(db, { companyId: f.companyId, runId: f.runId,
        agentId: f.agentId, eventType: "lifecycle", message: "concurrent event" });
      const [after] = await tx.select({ seq: heartbeatRuns.nextEventSeq }).from(heartbeatRuns).where(eq(heartbeatRuns.id, f.runId));
      return [before.seq, after.seq];
    });
    expect(seen).toEqual([1, 1]);
    const [current] = await db.select({ seq: heartbeatRuns.nextEventSeq }).from(heartbeatRuns).where(eq(heartbeatRuns.id, f.runId));
    expect(current.seq).toBe(2);
  });

  it("serializes competing checkpoints and retains replay conflicts and company isolation", async () => {
    const f = await fixture(), first = f.receipt(1), second = f.receipt(2);
    await Promise.all([persistUsageReceipt(db, first), persistUsageReceipt(db, second)]);
    await persistUsageReceipt(db, first);
    const [stored] = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, f.runId));
    expect(stored.usageJson).toMatchObject({ accountingReceiptSequence: 2, budgetExposure: { costCents: "2.0000000" } });
    expect(await db.select().from(runUsageReceipts).where(eq(runUsageReceipts.runId, f.runId))).toHaveLength(2);
    await expect(persistUsageReceipt(db, { ...first, receipt: { ...first.receipt, costUsd: 10 } })).rejects.toThrow("Conflicting");
    const foreign = await fixture();
    await expect(persistUsageReceipt(db, { ...f.receipt(3), companyId: foreign.companyId })).rejects.toThrow("not found");
    expect((await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, f.runId)))[0]).toEqual(stored);
  });
});
