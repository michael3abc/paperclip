import { agents, agentTaskSessions, companies, createDb, EMBEDDED_POSTGRES_TEST_TIMEOUT_MS, heartbeatRuns } from "@paperclipai/db";
import type { AdapterStopReverificationInput, AdapterStopReverificationResult } from "@paperclipai/adapter-utils";
import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { getEmbeddedPostgresTestSupport, startEmbeddedPostgresTestDatabase } from "../../__tests__/helpers/embedded-postgres.js";
import { bridgeSessionStopAcknowledged } from "../explicit-native-continuation.js";
import { DELIVERY_QUEUES, subscribeDeliveryWork } from "../delivery-work-notifications.js";
import { createBridgeStopReverification, validBridgeStopProof } from "./bridge-stop-reverification.js";

const BRIDGE = "bridge-session-1", NATIVE = "native-session-1", KEY = "a".repeat(64);
const support = await getEmbeddedPostgresTestSupport();

describe.skipIf(!support.supported)("bridge stop re-verification", () => {
  let database: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>>;
  let db: ReturnType<typeof createDb>;
  beforeAll(async () => {
    database = await startEmbeddedPostgresTestDatabase("paperclip-bridge-stop-reverify-");
    db = createDb(database.connectionString);
  }, EMBEDDED_POSTGRES_TEST_TIMEOUT_MS);
  afterAll(async () => { await db?.$client.end(); await database?.cleanup(); });

  async function seed(options: { forced?: boolean; status?: "cancelled" | "failed"; historical?: string; state?: string; sessionBridge?: string } = {}) {
    const [company] = await db.insert(companies).values({ name: "Bridge stop", issuePrefix: `B${randomUUID().slice(0, 6)}` }).returning();
    const [agent] = await db.insert(agents).values({ companyId: company.id, name: "Main", adapterType: "ccpocket_bridge" }).returning();
    const executionCancellation = { state: options.state ?? "requested", requestedAt: "2026-11-09T08:39:14.766Z",
      ...(options.forced !== undefined ? { forced: options.forced } : {}) };
    const [run] = await db.insert(heartbeatRuns).values({ companyId: company.id, agentId: agent.id, status: options.status ?? "cancelled",
      runtimeMode: "legacy", startedAt: new Date("2026-11-09T08:30:00Z"), finishedAt: new Date("2026-11-09T08:39:20Z"),
      runnerProfileJson: { adapterDispatch: { adapterType: options.historical ?? "ccpocket_bridge", adapterConfig: {} } },
      resultJson: { status: "needs_attention", bridgeSessionId: BRIDGE, nativeSessionId: NATIVE, replayAllowed: false, executionCancellation },
    }).returning();
    await db.insert(agentTaskSessions).values({ companyId: company.id, agentId: agent.id, adapterType: "ccpocket_bridge",
      taskKey: `main:${company.id}`, lastRunId: run.id,
      sessionParamsJson: { key: KEY, bridgeSessionId: options.sessionBridge ?? BRIDGE, nativeSessionId: NATIVE } });
    return { company, agent, run, executionCancellation };
  }
  const read = async (id: string) => (await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, id)))[0];
  const proofFor = (runId: string, patch: Record<string, unknown> = {}) => ({ verified: true as const, proof: {
    schema: "ccpocket.bridge-stop-reverification.v1", bridgeSessionId: BRIDGE, nativeSessionId: NATIVE, runId,
    acceptedSeq: 41, resultSeq: 44, checkedAt: "2026-11-09T09:00:00.000Z", background: { known: true, active: [] }, ...patch } });
  function harness(hook?: (input: AdapterStopReverificationInput) => Promise<AdapterStopReverificationResult>, options: { active?: Set<string>; now?: () => number; timeoutMs?: number } = {}) {
    const reverify = vi.fn(hook ?? (async () => ({ verified: false as const, reason: "unused" })));
    const publishLiveEvent = vi.fn();
    const getAdapter = vi.fn(() => (hook ? { reverifyCancelledRunStop: reverify } : {}));
    const service = createBridgeStopReverification(db, { getAdapter, isRunActive: id => options.active?.has(id) ?? false,
      publishLiveEvent, now: options.now ?? (() => Date.parse("2026-11-09T09:00:01.000Z")), timeoutMs: options.timeoutMs });
    return { service, reverify, publishLiveEvent, getAdapter };
  }

  it("acknowledges a requested bridge stop only from verified bridge proof, then publishes", async () => {
    const f = await seed();
    const h = harness(async input => proofFor(input.runId));
    expect(bridgeSessionStopAcknowledged(f.run)).toBe(false);
    expect(await h.service.reconcile(f.run.id, f.company.id)).toBe("acknowledged");
    expect(h.reverify).toHaveBeenCalledExactlyOnceWith({ runId: f.run.id, companyId: f.company.id, agentId: f.agent.id,
      sessionParams: { key: KEY, bridgeSessionId: BRIDGE, nativeSessionId: NATIVE } });
    const after = await read(f.run.id);
    expect(after.resultJson?.executionCancellation).toEqual({ ...f.executionCancellation, state: "acknowledged", forced: false,
      acknowledgedAt: "2026-11-09T09:00:01.000Z", proof: "bridge_session_reverified", bridgeStopProof: proofFor(f.run.id).proof });
    expect(after).toMatchObject({ status: "cancelled", runtimeMode: "legacy", finishedAt: f.run.finishedAt });
    expect(after.resultJson).toMatchObject({ bridgeSessionId: BRIDGE, nativeSessionId: NATIVE, replayAllowed: false });
    expect(bridgeSessionStopAcknowledged(after)).toBe(true);
    expect(h.publishLiveEvent).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ companyId: f.company.id,
      type: "heartbeat.run.status", payload: expect.objectContaining({ runId: f.run.id, status: "cancelled" }) }));
    // An acknowledged run is no longer a candidate.
    expect(await harness(async input => proofFor(input.runId)).service.reconcile(f.run.id, f.company.id)).toBe("skipped");
  });

  it("wakes deferred interrupt receipts when a stop is acknowledged, and not when it stays unverified", async () => {
    const wakes: number[] = [];
    const unsubscribe = subscribeDeliveryWork(db, DELIVERY_QUEUES.deferredExecutionReceipts, () => { wakes.push(Date.now()); });
    try {
      const held = await seed();
      expect(await harness(async () => ({ verified: false as const, reason: "busy" })).service.reconcile(held.run.id, held.company.id)).toBe("unverified");
      expect(wakes).toHaveLength(0);
      const f = await seed();
      expect(await harness(async input => proofFor(input.runId)).service.reconcile(f.run.id, f.company.id)).toBe("acknowledged");
      expect(wakes).toHaveLength(1);
    } finally { unsubscribe(); }
  });

  it("keeps the hold when the bridge cannot confirm the stop and bounds attempts per interval", async () => {
    const f = await seed();
    let clock = Date.parse("2026-11-09T09:00:00.000Z");
    const h = harness(async () => ({ verified: false, reason: "background_active" }), { now: () => clock });
    expect(await h.service.reconcile(f.run.id, f.company.id)).toBe("unverified");
    expect(await h.service.reconcile(f.run.id, f.company.id)).toBe("skipped");
    expect(h.reverify).toHaveBeenCalledTimes(1);
    clock += 60_000;
    expect(await h.service.reconcile(f.run.id, f.company.id)).toBe("unverified");
    expect(h.reverify).toHaveBeenCalledTimes(2);
    expect((await read(f.run.id)).resultJson).toEqual(f.run.resultJson);
    expect(bridgeSessionStopAcknowledged(await read(f.run.id))).toBe(false);
    expect(h.publishLiveEvent).not.toHaveBeenCalled();
  });

  it.each([
    ["wrong run", { runId: randomUUID() }], ["wrong bridge session", { bridgeSessionId: "bridge-other" }],
    ["wrong native session", { nativeSessionId: "native-other" }], ["active background work", { background: { known: true, active: ["task"] } }],
    ["unknown background work", { background: { known: false, active: [] } }], ["extra background state", { background: { known: true, active: [], pending: 1 } }],
    ["wrong schema", { schema: "other.v1" }], ["missing accepted input", { acceptedSeq: undefined }],
    ["malformed result sequence", { resultSeq: "44" }], ["malformed check time", { checkedAt: "later" }],
  ])("rejects proof that does not bind this run: %s", async (_name, patch) => {
    const f = await seed();
    const h = harness(async input => proofFor(input.runId, patch));
    expect(await h.service.reconcile(f.run.id, f.company.id)).toBe("unverified");
    expect((await read(f.run.id)).resultJson).toEqual(f.run.resultJson);
    expect(h.publishLiveEvent).not.toHaveBeenCalled();
  });

  it.each([
    ["a forced stop", { forced: true }], ["a failed run", { status: "failed" as const }],
    ["a local adapter run", { historical: "claude_local" }], ["an already acknowledged stop", { state: "acknowledged" }],
  ])("never re-verifies %s", async (_name, options) => {
    const f = await seed(options);
    const h = harness(async input => proofFor(input.runId));
    expect(await h.service.reconcile(f.run.id, f.company.id)).toBe("skipped");
    expect(h.reverify).not.toHaveBeenCalled();
    expect((await read(f.run.id)).resultJson).toEqual(f.run.resultJson);
  });

  it("skips runs still owned in this process, other companies, and adapters without the hook", async () => {
    const f = await seed();
    const active = harness(async input => proofFor(input.runId), { active: new Set([f.run.id]) });
    expect(await active.service.reconcile(f.run.id, f.company.id)).toBe("skipped");
    expect(active.reverify).not.toHaveBeenCalled();
    const other = harness(async input => proofFor(input.runId));
    expect(await other.service.reconcile(f.run.id, randomUUID())).toBe("skipped");
    const noHook = harness();
    expect(await noHook.service.reconcile(f.run.id, f.company.id)).toBe("skipped");
    expect(noHook.getAdapter).toHaveBeenCalledWith("ccpocket_bridge");
    expect((await read(f.run.id)).resultJson).toEqual(f.run.resultJson);
  });

  it("does not acknowledge when the cancellation changed during the bridge check", async () => {
    const f = await seed();
    const h = harness(async input => {
      await db.update(heartbeatRuns).set({ resultJson: { ...f.run.resultJson,
        executionCancellation: { ...f.executionCancellation, forced: true } } }).where(eq(heartbeatRuns.id, f.run.id));
      return proofFor(input.runId);
    });
    expect(await h.service.reconcile(f.run.id, f.company.id)).toBe("skipped");
    expect((await read(f.run.id)).resultJson?.executionCancellation).toEqual({ ...f.executionCancellation, forced: true });
    expect(h.publishLiveEvent).not.toHaveBeenCalled();
  });

  it("treats timeouts and adapter failures as unverified and shares concurrent attempts", async () => {
    const f = await seed();
    const hung = harness(() => new Promise(() => {}), { timeoutMs: 20 });
    expect(await hung.service.reconcile(f.run.id, f.company.id)).toBe("unverified");
    const thrown = harness(async () => { throw new Error("bridge offline"); });
    expect(await thrown.service.reconcile(f.run.id, f.company.id)).toBe("unverified");
    expect((await read(f.run.id)).resultJson).toEqual(f.run.resultJson);
    let release!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    const shared = harness(async input => { await gate; return proofFor(input.runId); });
    const first = shared.service.reconcile(f.run.id, f.company.id), second = shared.service.reconcile(f.run.id, f.company.id);
    await vi.waitFor(() => expect(shared.reverify).toHaveBeenCalledTimes(1));
    release();
    expect(await Promise.all([first, second])).toEqual(["acknowledged", "acknowledged"]);
    expect(shared.publishLiveEvent).toHaveBeenCalledTimes(1);
  });

  it("passes a stored state key only for the same bridge session", async () => {
    const f = await seed({ sessionBridge: "bridge-replaced" });
    const h = harness(async () => ({ verified: false, reason: "state_not_found" }));
    expect(await h.service.reconcile(f.run.id, f.company.id)).toBe("unverified");
    expect(h.reverify.mock.calls[0][0].sessionParams).toEqual({ bridgeSessionId: BRIDGE, nativeSessionId: NATIVE });
  });

  it("validates proof independently of adapter-supplied extra fields", () => {
    const expected = { runId: "run-1", bridgeSessionId: BRIDGE, nativeSessionId: NATIVE };
    expect(validBridgeStopProof({ ...proofFor("run-1"), proof: { ...proofFor("run-1").proof, token: "x" } }, expected))
      .toEqual(proofFor("run-1").proof);
    expect(validBridgeStopProof({ verified: false, reason: "x" }, expected)).toBeNull();
  });
});
