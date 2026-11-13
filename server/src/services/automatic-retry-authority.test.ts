import { describe, expect, it } from "vitest";
import { cancelledRunRejectsAutomaticRetry, isDeliberateRunCancellation } from "./automatic-retry-authority.js";

describe("cancelled automatic retry authority (liveness-first)", () => {
  it("never rejects a run that was not cancelled", () => {
    for (const status of ["failed", "timed_out", "interrupted", "succeeded"])
      expect(cancelledRunRejectsAutomaticRetry({ status, resultJson: { cancelledByActorType: "user" } }, "transient_failure")).toBe(false);
  });

  it.each([
    ["control-plane system stop", { cancellation: { source: "control_plane", expected: true, initiator: { type: "system" } } }],
    ["controller lease loss", { cancellation: { source: "controller_lease", expected: false, initiator: { type: "system" } } }],
    ["server shutdown", { cancellation: { source: "shutdown", expected: true, initiator: { type: "system" } } }],
    ["provider cancellation", { cancellation: { source: "provider", expected: false, initiator: { type: "provider" } } }],
    ["system Stop request with a system receipt", { executionCancellation: { state: "requested" },
      cancellation: { source: "control_plane", expected: true, initiator: { type: "system" } } }],
    ["abandoned prior", { abandonedPrior: { byRunId: "next" } }],
    ["resource wait without proof", {}],
  ])("does not revoke automatic retry after a system-initiated cancellation: %s", (_label, resultJson) => {
    expect(cancelledRunRejectsAutomaticRetry({ status: "cancelled", errorCode: "cancelled", resultJson }, "transient_failure")).toBe(false);
  });

  it.each(["inactivity_timeout", "abandoned_prior", "abandoned_liveness_reset", "process_lost", "server_shutdown_interrupted",
    "controller_lease_lost"])("does not revoke automatic retry for liveness system code %s, even with a Stop request", errorCode => {
    expect(cancelledRunRejectsAutomaticRetry({ status: "cancelled", errorCode,
      resultJson: { executionCancellation: { state: "requested" } } }, "transient_failure")).toBe(false);
  });

  it.each(["execution_reconciliation_required", "workspace_busy", "ai_connection_busy", "issue_waiting_for_response"])(
    "does not revoke automatic retry for a dispatch-gate system cancellation %s", errorCode => {
      expect(cancelledRunRejectsAutomaticRetry({ status: "cancelled", errorCode,
        resultJson: { executionRecovery: { kind: "bootstrap", providerWorkStarted: true } } }, "transient_failure")).toBe(false);
    });

  it.each([
    ["unattributed Stop request", { executionCancellation: { state: "requested" } }],
    ["unattributed startup cancellation", { startupCancellation: { errorCode: "cancelled" } }],
  ])("treats an %s as a manual Stop", (_label, resultJson) => {
    expect(cancelledRunRejectsAutomaticRetry({ status: "cancelled", errorCode: "codex_transient_upstream", resultJson }, "transient_failure")).toBe(true);
  });

  it.each(["legacy_disposition_repair_suppressed", "issue_disposition_repair_superseded", "retry_source_cancelled", "retry_input_superseded"])(
    "keeps a gate's suppression decision for %s", errorCode => {
      expect(cancelledRunRejectsAutomaticRetry({ status: "cancelled", errorCode, resultJson: {} }, "transient_failure")).toBe(true);
    });

  it.each([
    ["board Stop", { cancelledByActorType: "user" }],
    ["Owner user id", { cancelledByUserId: "owner" }],
    ["agent Stop", { cancelledByActorType: "agent" }],
    ["board comment interrupt", { operatorInterrupted: true, interruptedByActorType: "user" }],
    ["queued message interrupt", { queuedCommentInterruptQueueId: "queue" }],
    ["chat preemption", { chatPreemption: { chatQueueId: "queue" } }],
    ["withdrawn question", { withdrawnByActorType: "user" }],
    ["operator cancellation receipt", { cancellation: { source: "operator", expected: true, initiator: { type: "user", id: "owner" } } }],
    ["agent cancellation receipt", { cancellation: { initiator: { type: "agent" } } }],
    ["queued-message cancellation receipt", { cancellation: { source: "queued_message", expected: true } }],
    ["native board cancellation request", { startupCancellation: { requestedBy: { type: "board", userId: "owner" } } }],
    // Manual Stop dominates any earlier system receipt retained for audit.
    ["Stop after a resource wait", { executionRecovery: { kind: "ai_connection_wait", providerWorkStarted: false },
      cancellation: { source: "control_plane", expected: true, initiator: { type: "system" } }, cancelledByUserId: "owner" }],
  ])("keeps manual Owner/user cancellation authority: %s", (_label, resultJson) => {
    const run = { status: "cancelled", errorCode: "cancelled", resultJson };
    expect(isDeliberateRunCancellation(run)).toBe(true);
    expect(cancelledRunRejectsAutomaticRetry(run, "transient_failure")).toBe(true);
    expect(cancelledRunRejectsAutomaticRetry(run, "workspace_busy")).toBe(true);
  });

  it.each(["operator_interrupted", "issue_reassigned", "issue_cancelled"])("treats %s as a deliberate stop", errorCode => {
    expect(cancelledRunRejectsAutomaticRetry({ status: "cancelled", errorCode, resultJson: {} }, "transient_failure")).toBe(true);
  });

  it("does not treat a system actor attribution as deliberate", () => {
    expect(cancelledRunRejectsAutomaticRetry({ status: "cancelled", errorCode: "cancelled",
      resultJson: { cancelledByActorType: "system", interruptedByActorType: "system" } }, "transient_failure")).toBe(false);
  });
});
