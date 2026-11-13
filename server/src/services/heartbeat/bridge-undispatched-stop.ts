import type { heartbeatRuns } from "@paperclipai/db";
import type { AdapterStopReverificationResult } from "@paperclipai/adapter-utils";
import { parseObject } from "../../adapters/utils.js";

/**
 * Never-delivered stop proof for a cancelled CC Pocket run that recorded no session identity. Kept free of
 * database and adapter imports so both the continuation gate and the settlement flow can use it.
 * Liveness-first: this is background, record-only evidence; a terminal run never waits for it.
 */
type Run = typeof heartbeatRuns.$inferSelect;
const nonEmpty = (value: unknown): value is string => typeof value === "string" && value.length > 0;

export const BRIDGE_UNDISPATCHED_STOP_PROOF = "bridge_undispatched_reverified";
export const BRIDGE_UNDISPATCHED_STOP_SCHEMA = "ccpocket.bridge-undispatched-stop.v1";
export const BRIDGE_UNDISPATCHED_STOP_RECEIPT_SCHEMA = "paperclip.bridge-undispatched-stop.v1";

export type UndispatchedProof = {
  schema: typeof BRIDGE_UNDISPATCHED_STOP_SCHEMA; runId: string; bridgeSessionId: string; nativeSessionId: string;
  recordedInputs: number; lastRecordedRunId: string | null; checkedAt: string; background: { known: true; active: [] };
};

/** Accept only adapter proof naming exactly this run, with a settled card and no unaccounted input. */
export function validUndispatchedStopProof(
  result: AdapterStopReverificationResult | null | undefined,
  expected: { runId: string },
): UndispatchedProof | null {
  if (!result || result.verified !== true) return null;
  const proof = parseObject(result.proof);
  const background = parseObject(proof.background);
  if (proof.schema !== BRIDGE_UNDISPATCHED_STOP_SCHEMA || proof.runId !== expected.runId ||
      !nonEmpty(proof.bridgeSessionId) || !nonEmpty(proof.nativeSessionId) ||
      !Number.isSafeInteger(proof.recordedInputs) || Number(proof.recordedInputs) < 0 ||
      (proof.lastRecordedRunId !== null && !nonEmpty(proof.lastRecordedRunId)) ||
      !nonEmpty(proof.checkedAt) || Number.isNaN(Date.parse(proof.checkedAt)) ||
      background.known !== true || !Array.isArray(background.active) || background.active.length !== 0 ||
      Object.keys(background).some(key => key !== "known" && key !== "active")) return null;
  return { schema: BRIDGE_UNDISPATCHED_STOP_SCHEMA, runId: expected.runId, bridgeSessionId: proof.bridgeSessionId,
    nativeSessionId: proof.nativeSessionId, recordedInputs: proof.recordedInputs as number,
    lastRecordedRunId: (proof.lastRecordedRunId as string | null) ?? null, checkedAt: proof.checkedAt,
    background: { known: true, active: [] } };
}

/** A cancelled legacy run that recorded no session identity, process or cancellation request. */
export function isUndispatchedStopCandidate(run: Pick<Run, "status" | "runtimeMode" | "finishedAt" | "resultJson" | "processPid" | "processGroupId" | "nativeSessionId">) {
  return run.runtimeMode === "legacy" && run.status === "cancelled" && run.finishedAt != null &&
    run.resultJson?.executionCancellation == null && run.resultJson?.executionStopVerification == null &&
    run.resultJson?.bridgeSessionId == null && run.resultJson?.nativeSessionId == null &&
    !run.processPid && !run.processGroupId && !run.nativeSessionId;
}

export function hasVerifiedBridgeUndispatchedStop(run: Pick<Run, "id" | "status" | "runtimeMode" | "resultJson" | "nativeSessionId">) {
  const receipt = parseObject(run.resultJson?.executionStopVerification);
  return run.runtimeMode === "legacy" && run.status === "cancelled" && run.resultJson?.executionCancellation == null &&
    run.resultJson?.bridgeSessionId == null && run.resultJson?.nativeSessionId == null && !run.nativeSessionId &&
    receipt.schema === BRIDGE_UNDISPATCHED_STOP_RECEIPT_SCHEMA && receipt.proof === BRIDGE_UNDISPATCHED_STOP_PROOF &&
    validUndispatchedStopProof({ verified: true, proof: parseObject(receipt.bridgeStopProof) }, { runId: run.id }) !== null;
}
