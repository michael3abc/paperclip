import { isPreDispatchReviewWait } from "./pre-dispatch-review-wait.js";
import { expect, it } from "vitest";
import { legacyExecutionNeedsReconciliation } from "./legacy-execution-recovery.js";

// Liveness-first (rule 1): an unknown legacy provider outcome is abandoned and
// resent with a "check current state first" note. Only unrestored workspace
// files still hold automatic recovery.

const stopped = {
  runtimeMode: "legacy", status: "cancelled", errorCode: "cancelled",
  resultJson: {
    executionCancellation: { state: "acknowledged" },
    executionRecovery: { kind: "interrupted", providerStopped: true, sessionPreserved: true, actionOutcomes: "settled" },
  },
};

it.each(["workspace_git_scan_timeout", "workspace_git_scan_saturated", "remote_workspace_prepare_timeout", "setup_failed"])(
  "never holds a %s failure for operator reconciliation, with or without bootstrap evidence",
  (errorCode) => {
    const run = { runtimeMode: "legacy", status: "failed", errorCode, scheduledRetryAttempt: 2,
      resultJson: { executionRecovery: { kind: "bootstrap", providerWorkStarted: false } } };
    expect(legacyExecutionNeedsReconciliation(run)).toBe(false);
    expect(legacyExecutionNeedsReconciliation({ ...run, resultJson: {} })).toBe(false);
    expect(legacyExecutionNeedsReconciliation({ ...run, resultJson: {
      executionRecovery: { kind: "bootstrap", providerWorkStarted: true },
    } })).toBe(false);
  },
);

it("resends after unknown provider outcomes instead of holding them", () => {
  for (const errorCode of ["execution_uncertain", "stop_unconfirmed", "process_lost", "bridge_unavailable", "adapter_failed"]) {
    for (const status of ["failed", "timed_out", "interrupted", "cancelled"]) {
      expect(legacyExecutionNeedsReconciliation({
        runtimeMode: "legacy", status, errorCode, scheduledRetryAttempt: 7, resultJson: {},
      })).toBe(false);
    }
  }
});

it("does not hold interrupted or cancelled runs on missing stop evidence", () => {
  expect(legacyExecutionNeedsReconciliation(stopped)).toBe(false);
  expect(legacyExecutionNeedsReconciliation({ ...stopped, resultJson: {} })).toBe(false);
  expect(legacyExecutionNeedsReconciliation({ ...stopped, resultJson: {
    ...stopped.resultJson, executionCancellation: { state: "requested" },
  } })).toBe(false);
  expect(legacyExecutionNeedsReconciliation({ ...stopped, resultJson: {
    ...stopped.resultJson,
    executionRecovery: { ...stopped.resultJson.executionRecovery, actionOutcomes: "unknown" },
  } })).toBe(false);
});

it("continues a conversation without requiring receipts, even after many automatic attempts", () => {
  for (const status of ["failed", "timed_out", "interrupted", "cancelled"]) {
    expect(legacyExecutionNeedsReconciliation({
      runtimeMode: "legacy", status, errorCode: "process_lost", scheduledRetryAttempt: 2,
      resultJson: { conversationContinuation: "continue_conversation_v1" },
    })).toBe(false);
  }
});

it("never applies to native, running or succeeded runs", () => {
  expect(legacyExecutionNeedsReconciliation({ runtimeMode: "native", status: "failed", errorCode: null, resultJson: {
    workspaceRestoreFailure: "restore_unsafe_archive",
  } })).toBe(false);
  for (const status of ["running", "queued", "succeeded"]) {
    expect(legacyExecutionNeedsReconciliation({ runtimeMode: "legacy", status, errorCode: null, resultJson: {} })).toBe(false);
  }
});

it.each(["failed", "timed_out", "cancelled"])("holds an unsafe archive after %s even with conversation or bootstrap evidence", (status) => {
  expect(legacyExecutionNeedsReconciliation({ runtimeMode: "legacy", status, errorCode: "workspace_restore_failed", resultJson: {
    workspaceRestoreFailure: "restore_unsafe_archive", conversationContinuation: "continue_conversation_v1",
    executionRecovery: { kind: "bootstrap", providerWorkStarted: false }, stopReason: "max_turns",
  } })).toBe(true);
});

it("retains conversation retry eligibility for a transient restore lock timeout", () => {
  expect(legacyExecutionNeedsReconciliation({ runtimeMode: "legacy", status: "failed", errorCode: "workspace_restore_failed", resultJson: {
    workspaceRestoreFailure: "restore_lock_timeout", conversationContinuation: "continue_conversation_v1",
  } })).toBe(false);
});

it("recognizes only an unclaimed pre-dispatch review wait receipt", () => {
  const run = { runtimeMode: "legacy", status: "cancelled", errorCode: "issue_continuation_waiting_on_review",
    startedAt: null, runtimeModeResolvedAt: null, processPid: null, processGroupId: null,
    processStartedAt: null, nativeIssueId: null, nativeSessionId: null, sessionIdAfter: null,
    controllerBootId: null, controllerLeaseExpiresAt: null, executionStage: null,
    resultJson: { stopReason: "issue_continuation_waiting_on_review", timeoutSource: "stale_queued_run_gate" } };
  expect(isPreDispatchReviewWait(run)).toBe(true);
  expect(legacyExecutionNeedsReconciliation(run)).toBe(false);
  for (const patch of [
    { startedAt: new Date() }, { processPid: 123 }, { processGroupId: 123 },
    { processStartedAt: new Date() }, { nativeSessionId: "provider-session" }, { nativeIssueId: "native-task" },
    { sessionIdAfter: "provider-session" }, { runtimeModeResolvedAt: new Date() },
    { controllerBootId: "live-controller" }, { controllerLeaseExpiresAt: new Date() }, { executionStage: "preparing" },
    { errorCode: "operator_interrupted" }, { resultJson: {} },
    { resultJson: { ...run.resultJson, stopReason: "cancelled" } },
    { resultJson: { ...run.resultJson, workspaceRestoreFailure: "restore_unsafe_archive" } },
  ]) expect(isPreDispatchReviewWait({ ...run, ...patch })).toBe(false);
});
