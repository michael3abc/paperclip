import { agents, companies, createDb, EMBEDDED_POSTGRES_TEST_TIMEOUT_MS, heartbeatRuns } from "@paperclipai/db";
import type { AdapterStopReverificationResult, AdapterUndispatchedStopInput } from "@paperclipai/adapter-utils";
import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { getEmbeddedPostgresTestSupport, startEmbeddedPostgresTestDatabase } from "../../__tests__/helpers/embedded-postgres.js";
import { bridgeSessionStopAcknowledged } from "../explicit-native-continuation.js";
import { DELIVERY_QUEUES, subscribeDeliveryWork } from "../delivery-work-notifications.js";
import { createBridgeStopReverification } from "./bridge-stop-reverification.js";
import { hasVerifiedBridgeUndispatchedStop, isUndispatchedStopCandidate, validUndispatchedStopProof } from "./bridge-undispatched-stop.js";

const ISSUE = randomUUID();
const FINISHED = new Date("2026-11-12T07:42:38.661Z");
const LAST_RUN = randomUUID();
const support = await getEmbeddedPostgresTestSupport();

const proofFor = (runId: string, patch: Record<string, unknown> = {}) => ({ verified: true as const, proof: {
  schema: "ccpocket.bridge-undispatched-stop.v1", runId, bridgeSessionId: "f70a2476", nativeSessionId: "native-1",
  recordedInputs: 3, lastRecordedRunId: LAST_RUN, checkedAt: "2026-11-12T07:55:00.000Z", background: { known: true, active: [] }, ...patch } });

describe("undispatched stop proof validation", () => {
  const id = randomUUID();
  it("accepts only exact, settled, fully accounted proof", () => {
    expect(validUndispatchedStopProof(proofFor(id), { runId: id })).toMatchObject({ runId: id, recordedInputs: 3, background: { known: true, active: [] } });
    expect(validUndispatchedStopProof(proofFor(id, { lastRecordedRunId: null }), { runId: id })).not.toBeNull();
    for (const patch of [{ runId: randomUUID() }, { schema: "other.v1" }, { bridgeSessionId: "" }, { nativeSessionId: undefined },
      { recordedInputs: -1 }, { recordedInputs: "3" }, { checkedAt: "later" }, { background: { known: false, active: [] } },
      { background: { known: true, active: ["task"] } }, { background: { known: true, active: [], extra: 1 } }, { lastRecordedRunId: "" }]) {
      expect(validUndispatchedStopProof(proofFor(id, patch), { runId: id }), JSON.stringify(patch)).toBeNull();
    }
    expect(validUndispatchedStopProof({ verified: false, reason: "state_busy" } as AdapterStopReverificationResult, { runId: id })).toBeNull();
  });
  it("selects only cancelled, finished, identity-less runs that never requested cancellation", () => {
    const base = { status: "cancelled", runtimeMode: "legacy", finishedAt: FINISHED, processPid: null, processGroupId: null, nativeSessionId: null,
      resultJson: { cancellation: { source: "queued_message" } } } as Parameters<typeof isUndispatchedStopCandidate>[0];
    expect(isUndispatchedStopCandidate(base)).toBe(true);
    for (const patch of [{ status: "failed" }, { status: "timed_out" }, { runtimeMode: "native" }, { finishedAt: null }, { processPid: 12 },
      { processGroupId: 12 }, { nativeSessionId: "x" }, { resultJson: { executionCancellation: { state: "requested" } } },
      { resultJson: { bridgeSessionId: "b" } }, { resultJson: { nativeSessionId: "n" } }, { resultJson: { executionStopVerification: {} } }]) {
      expect(isUndispatchedStopCandidate({ ...base, ...patch } as typeof base), JSON.stringify(patch)).toBe(false);
    }
  });
});

describe.skipIf(!support.supported)("bridge undispatched stop re-verification", () => {
  let database: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>>;
  let db: ReturnType<typeof createDb>;
  beforeAll(async () => {
    database = await startEmbeddedPostgresTestDatabase("paperclip-bridge-undispatched-");
    db = createDb(database.connectionString);
  }, EMBEDDED_POSTGRES_TEST_TIMEOUT_MS);
  afterAll(async () => { await db?.$client.end(); await database?.cleanup(); });

  async function seed(options: { historical?: string; resultJson?: Record<string, unknown>; status?: "cancelled" | "failed" } = {}) {
    const [company] = await db.insert(companies).values({ name: "Undispatched", issuePrefix: `U${randomUUID().slice(0, 6)}` }).returning();
    const [agent] = await db.insert(agents).values({ companyId: company.id, name: "Main", adapterType: "ccpocket_bridge" }).returning();
    const [run] = await db.insert(heartbeatRuns).values({ companyId: company.id, agentId: agent.id, status: options.status ?? "cancelled",
      runtimeMode: "legacy", startedAt: new Date("2026-11-12T07:42:28.324Z"), finishedAt: FINISHED,
      errorCode: "operator_interrupted", contextSnapshot: { issueId: ISSUE },
      runnerProfileJson: { adapterDispatch: { adapterType: options.historical ?? "ccpocket_bridge", adapterConfig: {} } },
      resultJson: options.resultJson ?? { stopReason: "cancelled", cancellation: { source: "queued_message", expected: true },
        stopSettlement: { state: "needs_attention", reason: "stop_unverified", attempts: 4 } },
    }).returning();
    return { company, agent, run };
  }
  const read = async (id: string) => (await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, id)))[0];
  function harness(hook?: (input: AdapterUndispatchedStopInput) => Promise<AdapterStopReverificationResult>, options: { active?: Set<string>; now?: () => number } = {}) {
    const reverify = vi.fn(hook ?? (async () => ({ verified: false as const, reason: "unused" })));
    const publishLiveEvent = vi.fn();
    const onUnverified = vi.fn();
    const service = createBridgeStopReverification(db, { getAdapter: () => (hook ? { reverifyUndispatchedRunStop: reverify } : {}),
      isRunActive: id => options.active?.has(id) ?? false, publishLiveEvent, onUnverified, intervalMs: 0,
      now: options.now ?? (() => Date.parse("2026-11-12T07:55:00.000Z")) });
    return { service, reverify, publishLiveEvent, onUnverified };
  }

  it("records a read-only receipt only from adapter proof bound to this run, without inventing a cancellation", async () => {
    const f = await seed();
    const h = harness(async input => proofFor(input.runId));
    expect(bridgeSessionStopAcknowledged(f.run)).toBe(false);
    expect(await h.service.reconcile(f.run.id, f.company.id)).toBe("acknowledged");
    expect(h.reverify).toHaveBeenCalledExactlyOnceWith({ runId: f.run.id, companyId: f.company.id, agentId: f.agent.id, issueId: ISSUE,
      finishedAt: FINISHED.toISOString(), signal: expect.any(AbortSignal) });
    const after = await read(f.run.id);
    expect(after.resultJson?.executionCancellation).toBeUndefined();
    expect(after.resultJson?.executionStopVerification).toMatchObject({ schema: "paperclip.bridge-undispatched-stop.v1",
      proof: "bridge_undispatched_reverified", bridgeStopProof: proofFor(f.run.id).proof, verifiedAt: "2026-11-12T07:55:00.000Z" });
    expect(after.resultJson).toMatchObject({ stopReason: "cancelled", cancellation: { source: "queued_message" }, stopSettlement: { attempts: 4 } });
    expect(after).toMatchObject({ status: "cancelled", errorCode: "operator_interrupted", finishedAt: FINISHED });
    expect(hasVerifiedBridgeUndispatchedStop(after)).toBe(true);
    expect(bridgeSessionStopAcknowledged(after)).toBe(true);
    expect(h.publishLiveEvent).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ companyId: f.company.id, type: "heartbeat.run.status" }));
    // A recorded run is no longer a candidate, so it is never inspected twice.
    expect(await harness(async input => proofFor(input.runId)).service.reconcile(f.run.id, f.company.id)).toBe("skipped");
  });

  it("wakes deferred receipts on proof and not when the adapter cannot confirm", async () => {
    const wakes: number[] = [];
    const unsubscribe = subscribeDeliveryWork(db, DELIVERY_QUEUES.deferredExecutionReceipts, () => { wakes.push(Date.now()); });
    try {
      const held = await seed();
      const refused = harness(async () => ({ verified: false as const, reason: "history_incomplete" }));
      expect(await refused.service.reconcile(held.run.id, held.company.id)).toBe("unverified");
      expect(refused.onUnverified).toHaveBeenCalledWith("history_incomplete");
      expect(wakes).toHaveLength(0);
      expect((await read(held.run.id)).resultJson).toEqual(held.run.resultJson);
      const f = await seed();
      expect(await harness(async input => proofFor(input.runId)).service.reconcile(f.run.id, f.company.id)).toBe("acknowledged");
      expect(wakes).toHaveLength(1);
    } finally { unsubscribe(); }
  });

  it.each([
    ["wrong run", { runId: randomUUID() }], ["active background work", { background: { known: true, active: ["task"] } }],
    ["unknown background work", { background: { known: false, active: [] } }], ["wrong schema", { schema: "ccpocket.bridge-stop-reverification.v1" }],
    ["missing native session", { nativeSessionId: undefined }], ["malformed check time", { checkedAt: "later" }],
  ])("rejects proof that does not bind this run: %s", async (_name, patch) => {
    const f = await seed();
    const h = harness(async input => proofFor(input.runId, patch));
    expect(await h.service.reconcile(f.run.id, f.company.id)).toBe("unverified");
    expect((await read(f.run.id)).resultJson).toEqual(f.run.resultJson);
    expect(h.publishLiveEvent).not.toHaveBeenCalled();
  });

  it("never inspects runs that are active, foreign, other adapters' or already identified, and tolerates a missing hook", async () => {
    const f = await seed();
    const active = harness(async input => proofFor(input.runId), { active: new Set([f.run.id]) });
    expect(await active.service.reconcile(f.run.id, f.company.id)).toBe("skipped");
    const other = harness(async input => proofFor(input.runId));
    expect(await other.service.reconcile(f.run.id, randomUUID())).toBe("skipped");
    const foreign = await seed({ historical: "claude_local" });
    expect(await other.service.reconcile(foreign.run.id, foreign.company.id)).toBe("skipped");
    const identified = await seed({ resultJson: { bridgeSessionId: "b", nativeSessionId: "n", cancellation: {} } });
    expect(await other.service.reconcile(identified.run.id, identified.company.id)).toBe("skipped");
    const requested = await seed({ resultJson: { executionCancellation: { state: "requested" } } });
    expect(await other.service.reconcile(requested.run.id, requested.company.id)).toBe("skipped");
    const failed = await seed({ status: "failed" });
    expect(await other.service.reconcile(failed.run.id, failed.company.id)).toBe("skipped");
    expect(other.reverify).not.toHaveBeenCalled();
    const noHook = harness();
    expect(await noHook.service.reconcile(f.run.id, f.company.id)).toBe("skipped");
    expect(noHook.onUnverified).toHaveBeenCalledWith("adapter_reverification_unavailable");
  });

  it("writes nothing when the run changed while the adapter was checking", async () => {
    const f = await seed();
    const h = harness(async input => {
      await db.update(heartbeatRuns).set({ resultJson: { ...f.run.resultJson, executionCancellation: { state: "requested" } } }).where(eq(heartbeatRuns.id, input.runId));
      return proofFor(input.runId);
    });
    expect(await h.service.reconcile(f.run.id, f.company.id)).toBe("skipped");
    expect((await read(f.run.id)).resultJson?.executionStopVerification).toBeUndefined();
    expect(h.publishLiveEvent).not.toHaveBeenCalled();
  });

  it("treats a missing issue scope, adapter errors and timeouts as unverified", async () => {
    const [company] = await db.insert(companies).values({ name: "Scope", issuePrefix: `S${randomUUID().slice(0, 6)}` }).returning();
    const [agent] = await db.insert(agents).values({ companyId: company.id, name: "Main", adapterType: "ccpocket_bridge" }).returning();
    const [noIssue] = await db.insert(heartbeatRuns).values({ companyId: company.id, agentId: agent.id, status: "cancelled", runtimeMode: "legacy",
      finishedAt: FINISHED, runnerProfileJson: { adapterDispatch: { adapterType: "ccpocket_bridge", adapterConfig: {} } }, resultJson: { cancellation: {} } }).returning();
    const h = harness(async input => proofFor(input.runId));
    expect(await h.service.reconcile(noIssue.id, company.id)).toBe("unverified");
    expect(h.onUnverified).toHaveBeenCalledWith("undispatched_scope_missing");
    expect(h.reverify).not.toHaveBeenCalled();
    const f = await seed();
    const failing = harness(async () => { throw new Error("socket closed"); });
    expect(await failing.service.reconcile(f.run.id, f.company.id)).toBe("unverified");
    expect((await read(f.run.id)).resultJson).toEqual(f.run.resultJson);
  });
});
