/** Cancellation ends automatic execution authority. Historical resource-wait
 * rows are the sole exception: matching receipts prove no provider work.
 * A fresh comment is a new admission, never authority to retry a cancelled run. */
export function cancelledRunRejectsAutomaticRetry(run: {
  status: string; errorCode?: string | null; resultJson?: Record<string, unknown> | null;
}, retryReason: string | null | undefined): boolean {
  if (run.status !== "cancelled") return false;
  const cancellation = run.resultJson?.cancellation as { initiator?: { type?: string }; source?: string; expected?: boolean } | undefined;
  // Stop dominates an earlier resource-wait receipt, even if its error code
  // or no-provider fact was retained for audit.
  if (run.resultJson?.executionCancellation || run.resultJson?.startupCancellation ||
      run.resultJson?.cancelledByActorType || run.resultJson?.cancelledByUserId ||
      run.resultJson?.interruptedByActorType || run.resultJson?.queuedCommentInterruptQueueId ||
      (cancellation && (cancellation.source !== "control_plane" || cancellation.expected !== true || cancellation.initiator?.type !== "system"))) return true;
  const recovery = run.resultJson?.executionRecovery;
  if (!recovery || typeof recovery !== "object" || Array.isArray(recovery)) return true;
  const proof = recovery as Record<string, unknown>;
  if (proof.providerWorkStarted !== false) return true;
  return !(
    retryReason === "workspace_busy" && run.errorCode === "workspace_busy" && proof.kind === "workspace_wait" ||
    retryReason === "ai_connection_busy" && run.errorCode === "ai_connection_busy" && proof.kind === "ai_connection_wait" ||
    retryReason === "ai_connection_pool_wait" && run.errorCode === "ai_connection_pool_exhausted" && proof.kind === "ai_connection_wait"
  );
}
