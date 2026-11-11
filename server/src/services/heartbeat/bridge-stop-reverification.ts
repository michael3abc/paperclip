import { agentTaskSessions, heartbeatRuns, type Db } from "@paperclipai/db";
import type { AdapterStopReverificationResult, ServerAdapterModule } from "@paperclipai/adapter-utils";
import { and, desc, eq, sql } from "drizzle-orm";
import { logger } from "../../middleware/logger.js";
import { parseObject } from "../../adapters/utils.js";
import { historicalAdapterType } from "../conversation-continuation.js";
import { BRIDGE_SESSION_ADAPTER } from "../explicit-native-continuation.js";
import { buildHeartbeatRunStatusLiveEventPayload } from "../heartbeat-run-status-payload.js";
import { publishLiveEvent as publishLiveEventDefault } from "../live-events.js";
import { notifyDeferredExecutionWork } from "../deferred-execution-notifications.js";
import { DELIVERY_QUEUES, notifyDeliveryWork } from "../delivery-work-notifications.js";
import { notifyRunStopSettlement } from "../run-stop-settlement-notifications.js";

export const BRIDGE_STOP_REVERIFICATION_PROOF = "bridge_session_reverified";
export const BRIDGE_STOP_REVERIFICATION_SCHEMA = "ccpocket.bridge-stop-reverification.v1";

/** At most one adapter re-check per run per interval. An acknowledged stop notifies deferred receipts. */
const DEFAULT_INTERVAL_MS = 60_000;
const DEFAULT_TIMEOUT_MS = 120_000;

export type BridgeStopReconciliation = "acknowledged" | "unverified" | "skipped";

export interface BridgeStopReverificationDependencies {
  getAdapter: (type: string) => Pick<ServerAdapterModule, "reverifyCancelledRunStop"> | null | undefined;
  /** A run still owned by a live controller in this process is never reconciled. */
  isRunActive: (runId: string) => boolean;
  publishLiveEvent?: typeof publishLiveEventDefault;
  now?: () => number;
  intervalMs?: number;
  timeoutMs?: number;
  signal?: AbortSignal;
  onUnverified?: (reason: string) => void;
}

type Run = typeof heartbeatRuns.$inferSelect;
type BridgeStopProof = {
  schema: typeof BRIDGE_STOP_REVERIFICATION_SCHEMA;
  bridgeSessionId: string;
  nativeSessionId: string;
  runId: string;
  acceptedSeq: number;
  resultSeq?: number;
  checkedAt: string;
  background: { known: true; active: [] };
  observation?: { kind: "later_input" | "restored_card"; bridgeSessionId: string; runId: string; acceptedSeq: number; resultSeq?: number };
};

const nonEmpty = (value: unknown): value is string => typeof value === "string" && value.length > 0;

/** Accept only proof that names exactly this run and its recorded bridge/native sessions. */
export function validBridgeStopProof(
  result: AdapterStopReverificationResult | null | undefined,
  expected: { runId: string; bridgeSessionId: string; nativeSessionId: string },
): BridgeStopProof | null {
  if (!result || result.verified !== true) return null;
  const proof = parseObject(result.proof);
  const background = parseObject(proof.background);
  if (proof.schema !== BRIDGE_STOP_REVERIFICATION_SCHEMA || proof.runId !== expected.runId ||
      proof.bridgeSessionId !== expected.bridgeSessionId || proof.nativeSessionId !== expected.nativeSessionId ||
      !Number.isSafeInteger(proof.acceptedSeq) || !nonEmpty(proof.checkedAt) || Number.isNaN(Date.parse(proof.checkedAt)) ||
      (proof.resultSeq !== undefined && !Number.isSafeInteger(proof.resultSeq)) ||
      background.known !== true || !Array.isArray(background.active) || background.active.length !== 0 ||
      Object.keys(background).some(key => key !== "known" && key !== "active")) return null;
  const observation = parseObject(proof.observation);
  if (proof.observation !== undefined && (
      !["later_input", "restored_card"].includes(String(observation.kind)) ||
      !nonEmpty(observation.bridgeSessionId) || !nonEmpty(observation.runId) ||
      !Number.isSafeInteger(observation.acceptedSeq) || Number(observation.acceptedSeq) < 0 ||
      (observation.kind === "later_input" && (!Number.isSafeInteger(observation.resultSeq) || Number(observation.resultSeq) < 0)) ||
      (observation.kind === "restored_card" && observation.runId !== expected.runId))) return null;
  return {
    ...(proof.observation !== undefined ? { observation: {
      kind: observation.kind as "later_input" | "restored_card", bridgeSessionId: observation.bridgeSessionId as string,
      runId: observation.runId as string, acceptedSeq: observation.acceptedSeq as number,
      ...(Number.isSafeInteger(observation.resultSeq) ? { resultSeq: observation.resultSeq as number } : {}),
    } } : {}),
    schema: BRIDGE_STOP_REVERIFICATION_SCHEMA,
    bridgeSessionId: expected.bridgeSessionId,
    nativeSessionId: expected.nativeSessionId,
    runId: expected.runId,
    acceptedSeq: proof.acceptedSeq as number,
    ...(proof.resultSeq !== undefined ? { resultSeq: proof.resultSeq as number } : {}),
    checkedAt: proof.checkedAt,
    background: { known: true, active: [] },
  };
}

export function hasVerifiedBridgeTerminalStop(run: Pick<Run, "id" | "status" | "resultJson">) {
  const receipt = parseObject(run.resultJson?.executionStopVerification);
  return ["failed", "interrupted"].includes(run.status) && run.resultJson?.executionCancellation == null &&
    receipt.schema === "paperclip.bridge-terminal-stop.v1" &&
    nonEmpty(run.resultJson?.bridgeSessionId) && nonEmpty(run.resultJson?.nativeSessionId) &&
    validBridgeStopProof({ verified: true, proof: parseObject(receipt.bridgeStopProof) }, {
      runId: run.id, bridgeSessionId: run.resultJson.bridgeSessionId as string,
      nativeSessionId: run.resultJson.nativeSessionId as string,
    }) !== null;
}

/**
 * Compare-and-set validated stop evidence without changing a failed outcome or inventing cancellation.
 * The exact existing cancellation and both recorded session IDs must still match; otherwise nothing is written.
 */
async function acknowledgeBridgeStop(
  db: Db,
  run: Run,
  proof: BridgeStopProof,
  options: { proofKind: string; at: Date; publishLiveEvent: typeof publishLiveEventDefault; extra?: Record<string, unknown> },
): Promise<Run | null> {
  const existing = parseObject(run.resultJson?.executionCancellation);
  const failedWithoutCancellation = ["failed", "interrupted"].includes(run.status) && run.resultJson?.executionCancellation == null;
  const patch = failedWithoutCancellation
    ? { executionStopVerification: { schema: "paperclip.bridge-terminal-stop.v1",
        verifiedAt: options.at.toISOString(), proof: options.proofKind, bridgeStopProof: proof } }
    : { executionCancellation: { ...existing, state: "acknowledged", forced: false,
        acknowledgedAt: options.at.toISOString(), proof: options.proofKind, bridgeStopProof: proof, ...(options.extra ?? {}) } };
  // Opening this gate must wake the deferred interrupt receipts in the same
  // commit; a stop acknowledged without a signal used to strand them.
  const acknowledged = await db.transaction(async tx => {
    await notifyRunStopSettlement(tx, { companyId: run.companyId, runId: run.id });
    await notifyDeferredExecutionWork(tx, { companyId: run.companyId });
    if (typeof run.resultJson?.workspaceRecoveryActionId === "string")
      await notifyDeliveryWork(tx, DELIVERY_QUEUES.workspaceCreatorRecovery, run.resultJson.workspaceRecoveryActionId);
    return tx.update(heartbeatRuns).set({
      resultJson: sql`coalesce(${heartbeatRuns.resultJson}, '{}'::jsonb) || ${JSON.stringify(patch)}::jsonb`,
      updatedAt: options.at,
    }).where(and(eq(heartbeatRuns.id, run.id), eq(heartbeatRuns.companyId, run.companyId),
      eq(heartbeatRuns.agentId, run.agentId), eq(heartbeatRuns.status, run.status), eq(heartbeatRuns.runtimeMode, "legacy"),
      failedWithoutCancellation ? sql`coalesce(${heartbeatRuns.resultJson}->'executionCancellation', 'null'::jsonb) = 'null'::jsonb`
        : and(sql`${heartbeatRuns.resultJson}->'executionCancellation'->>'state' = 'requested'`,
          sql`coalesce(${heartbeatRuns.resultJson}->'executionCancellation'->>'forced', 'false') <> 'true'`,
          sql`${heartbeatRuns.resultJson}->'executionCancellation' = ${JSON.stringify(existing)}::jsonb`),
      sql`${heartbeatRuns.resultJson}->>'bridgeSessionId' = ${proof.bridgeSessionId}`,
      sql`${heartbeatRuns.resultJson}->>'nativeSessionId' = ${proof.nativeSessionId}`))
      .returning();
  });
  const stopped = acknowledged[0] ?? null;
  if (stopped) {
    options.publishLiveEvent({
      companyId: stopped.companyId,
      type: "heartbeat.run.status",
      payload: buildHeartbeatRunStatusLiveEventPayload(stopped),
    });
  }
  return stopped;
}

export const BRIDGE_HANDOFF_SETTLED_PROOF = "bridge_handoff_settled";
export type BridgeHandoffSettlement = "acknowledged" | "unverified" | "skipped";

/**
 * After a successor run that took over a busy bridge session ends, record the stop of the interrupted
 * predecessor only from the adapter's own observation (`resultJson.bridgeHandoff.proof`). The successor must
 * have been admitted with that exact handoff; the predecessor must still be the requested, unforced bridge
 * cancellation it named. Without valid proof the predecessor is left unchanged. Never throws.
 */
export async function settleBridgeHandoff(
  db: Db,
  successor: Pick<Run, "id" | "companyId" | "agentId" | "contextSnapshot" | "resultJson">,
  options: { now?: () => number; publishLiveEvent?: typeof publishLiveEventDefault } = {},
): Promise<BridgeHandoffSettlement> {
  try {
    const admitted = parseObject(parseObject(parseObject(successor.contextSnapshot).explicitUserContinuation).bridgeSessionHandoff);
    const reported = parseObject(successor.resultJson?.bridgeHandoff);
    if (!nonEmpty(admitted.fromRunId) || reported.fromRunId !== admitted.fromRunId || admitted.fromRunId === successor.id) return "skipped";
    if (!nonEmpty(admitted.bridgeSessionId) || !nonEmpty(admitted.nativeSessionId)) return "skipped";
    const [predecessor] = await db.select().from(heartbeatRuns)
      .where(and(eq(heartbeatRuns.id, admitted.fromRunId), eq(heartbeatRuns.companyId, successor.companyId),
        eq(heartbeatRuns.agentId, successor.agentId))).limit(1);
    if (!predecessor || !["cancelled", "timed_out"].includes(predecessor.status) || predecessor.runtimeMode !== "legacy") return "skipped";
    const cancellation = parseObject(predecessor.resultJson?.executionCancellation);
    if (cancellation.state !== "requested" || cancellation.forced === true) return "skipped";
    if (predecessor.resultJson?.bridgeSessionId !== admitted.bridgeSessionId ||
        predecessor.resultJson?.nativeSessionId !== admitted.nativeSessionId) return "skipped";
    if (await historicalAdapterType(db, predecessor) !== BRIDGE_SESSION_ADAPTER) return "skipped";
    const proof = validBridgeStopProof({ verified: true, proof: reported.proof } as AdapterStopReverificationResult, {
      runId: predecessor.id, bridgeSessionId: admitted.bridgeSessionId, nativeSessionId: admitted.nativeSessionId,
    });
    if (!proof) {
      logger.info({ runId: predecessor.id, successorRunId: successor.id, outcome: reported.outcome ?? null },
        "bridge handoff carried no stop proof; the interrupted run keeps its requested cancellation");
      return "unverified";
    }
    const stopped = await acknowledgeBridgeStop(db, predecessor, proof, {
      proofKind: BRIDGE_HANDOFF_SETTLED_PROOF,
      at: new Date((options.now ?? Date.now)()),
      publishLiveEvent: options.publishLiveEvent ?? publishLiveEventDefault,
      extra: { observedByRunId: successor.id },
    });
    if (!stopped) return "skipped";
    logger.info({ runId: stopped.id, successorRunId: successor.id }, "bridge stop settled from handoff evidence");
    return "acknowledged";
  } catch (error) {
    logger.warn({ err: error, successorRunId: successor.id }, "bridge handoff settlement failed; the interrupted run is unchanged");
    return "unverified";
  }
}

/**
 * Server-owned reconciliation of a CC Pocket bridge run whose Stop was requested
 * but never confirmed by the adapter. The bridge has no host PID, so the only
 * acceptable stop proof is the adapter's read-only bridge re-check. Verified
 * proof is persisted with a compare-and-set on the exact requested cancellation
 * and then published; anything else leaves the hold unchanged. Forced stops are
 * never acknowledged, and nothing is replayed.
 */
export function createBridgeStopReverification(db: Db, deps: BridgeStopReverificationDependencies) {
  const now = deps.now ?? Date.now;
  const intervalMs = deps.intervalMs ?? DEFAULT_INTERVAL_MS;
  const timeoutMs = deps.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const publishLiveEvent = deps.publishLiveEvent ?? publishLiveEventDefault;
  const lastAttemptAt = new Map<string, number>();
  const inFlight = new Map<string, Promise<BridgeStopReconciliation>>();

  function candidate(run: Run | undefined, companyId: string): run is Run {
    if (!run || run.companyId !== companyId || !["cancelled", "timed_out", "failed", "interrupted"].includes(run.status) || run.runtimeMode !== "legacy") return false;
    const cancellation = parseObject(run.resultJson?.executionCancellation);
    const requested = ["cancelled", "timed_out"].includes(run.status) && cancellation.state === "requested" && cancellation.forced !== true;
    const failed = ["failed", "interrupted"].includes(run.status) && run.resultJson?.executionCancellation == null;
    return (requested || failed) &&
      nonEmpty(run.resultJson?.bridgeSessionId) && nonEmpty(run.resultJson?.nativeSessionId);
  }

  async function sessionParams(run: Run, bridgeSessionId: string, nativeSessionId: string) {
    const [row] = await db.select({ params: agentTaskSessions.sessionParamsJson }).from(agentTaskSessions)
      .where(and(eq(agentTaskSessions.companyId, run.companyId), eq(agentTaskSessions.agentId, run.agentId),
        eq(agentTaskSessions.adapterType, BRIDGE_SESSION_ADAPTER), eq(agentTaskSessions.lastRunId, run.id)))
      .orderBy(desc(agentTaskSessions.updatedAt)).limit(1);
    const params = parseObject(row?.params);
    // A stored state key is only a lookup hint, and only for the same bridge session.
    const key = params.bridgeSessionId === bridgeSessionId && nonEmpty(params.key) ? params.key : undefined;
    return { ...(key ? { key } : {}), bridgeSessionId, nativeSessionId };
  }

  async function callAdapter(
    hook: NonNullable<ServerAdapterModule["reverifyCancelledRunStop"]>,
    input: Parameters<NonNullable<ServerAdapterModule["reverifyCancelledRunStop"]>>[0],
  ): Promise<AdapterStopReverificationResult> {
    let timer: NodeJS.Timeout | undefined;
    const controller = new AbortController();
    let abortResult: (value: AdapterStopReverificationResult) => void;
    const aborted = new Promise<AdapterStopReverificationResult>(resolve => { abortResult = resolve; });
    const abort = () => { controller.abort(deps.signal?.reason); abortResult({ verified: false, reason: "reverification_aborted" }); };
    deps.signal?.addEventListener("abort", abort, { once: true });
    if (deps.signal?.aborted) abort();
    try {
      if (deps.signal?.aborted) return { verified: false, reason: "reverification_aborted" };
      return await Promise.race([
        aborted,
        hook({ ...input, signal: controller.signal }),
        new Promise<AdapterStopReverificationResult>(resolve => {
          timer = setTimeout(() => { controller.abort(); resolve({ verified: false, reason: "reverification_timeout" }); }, timeoutMs);
        }),
      ]);
    } catch {
      return { verified: false, reason: "reverification_failed" };
    } finally { clearTimeout(timer); deps.signal?.removeEventListener("abort", abort); }
  }

  async function attempt(runId: string, companyId: string): Promise<BridgeStopReconciliation> {
    const [run] = await db.select().from(heartbeatRuns)
      .where(and(eq(heartbeatRuns.id, runId), eq(heartbeatRuns.companyId, companyId))).limit(1);
    if (!candidate(run, companyId) || deps.isRunActive(run.id)) return "skipped";
    if (await historicalAdapterType(db, run) !== BRIDGE_SESSION_ADAPTER) return "skipped";
    const hook = deps.getAdapter(BRIDGE_SESSION_ADAPTER)?.reverifyCancelledRunStop;
    if (typeof hook !== "function") { deps.onUnverified?.("adapter_reverification_unavailable"); return "skipped"; }
    const startedAt = now();
    if (startedAt - (lastAttemptAt.get(run.id) ?? -Infinity) < intervalMs) return "skipped";
    lastAttemptAt.set(run.id, startedAt);

    const bridgeSessionId = run.resultJson!.bridgeSessionId as string;
    const nativeSessionId = run.resultJson!.nativeSessionId as string;
    const result = await callAdapter(hook, { runId: run.id, companyId: run.companyId, agentId: run.agentId,
      sessionParams: await sessionParams(run, bridgeSessionId, nativeSessionId) });
    const proof = validBridgeStopProof(result, { runId: run.id, bridgeSessionId, nativeSessionId });
    if (!proof) {
      deps.onUnverified?.(result.verified ? "invalid_proof" : result.reason);
      logger.info({ runId: run.id, companyId, reason: result.verified ? "invalid_proof" : result.reason },
        "bridge stop re-verification did not confirm the stop; the hold is retained");
      return "unverified";
    }
    if (deps.signal?.aborted || deps.isRunActive(run.id)) return "skipped";

    const stopped = await acknowledgeBridgeStop(db, run, proof, {
      proofKind: BRIDGE_STOP_REVERIFICATION_PROOF, at: new Date(now()), publishLiveEvent,
    });
    if (!stopped) return "skipped";
    logger.info({ runId: stopped.id, companyId }, "bridge stop re-verified from bridge evidence");
    return "acknowledged";
  }

  /** Reconcile one run; concurrent callers share one attempt. Never throws. */
  function reconcile(runId: string, companyId: string): Promise<BridgeStopReconciliation> {
    const running = inFlight.get(runId);
    if (running) return running;
    const next = attempt(runId, companyId).catch(error => {
      logger.warn({ err: error, runId, companyId }, "bridge stop re-verification failed; the hold is retained");
      return "unverified" as const;
    }).finally(() => inFlight.delete(runId));
    inFlight.set(runId, next);
    return next;
  }

  return { reconcile };
}
