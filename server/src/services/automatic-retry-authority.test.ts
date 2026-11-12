import { describe, expect, it } from "vitest";
import { cancelledRunRejectsAutomaticRetry } from "./automatic-retry-authority.js";

describe("cancelled automatic retry authority", () => {
  it.each(["legacy_disposition_repair_suppressed", "cancelled", "execution_reconciliation_required"])("never retries a cancelled %s as a fresh input", errorCode => {
    expect(cancelledRunRejectsAutomaticRetry({ status: "cancelled", errorCode,
      resultJson: { executionRecovery: { kind: "bootstrap", providerWorkStarted: false } },
    }, "transient_failure")).toBe(true);
  });
  it.each(["workspace_busy", "ai_connection_busy", "ai_connection_pool_wait"])("retains only the matching undispatched %s wait lane", retryReason => {
    const run = { status: "cancelled", errorCode: retryReason === "ai_connection_pool_wait" ? "ai_connection_pool_exhausted" : retryReason,
      resultJson: { executionRecovery: { kind: retryReason === "workspace_busy" ? "workspace_wait" : "ai_connection_wait", providerWorkStarted: false } } };
    expect(cancelledRunRejectsAutomaticRetry(run, retryReason)).toBe(false);
    const systemWait = { ...run, resultJson: { ...run.resultJson, cancellation: {
      source: "control_plane", expected: true, initiator: { type: "system" },
    } } };
    expect(cancelledRunRejectsAutomaticRetry(systemWait, retryReason)).toBe(false);
    expect(cancelledRunRejectsAutomaticRetry({ ...systemWait, resultJson: { ...systemWait.resultJson,
      cancelledByUserId: "owner",
    } }, retryReason)).toBe(true);
    expect(cancelledRunRejectsAutomaticRetry(run, "transient_failure")).toBe(true);
    expect(cancelledRunRejectsAutomaticRetry({ ...run, resultJson: { executionRecovery: { ...run.resultJson.executionRecovery, providerWorkStarted: true } } }, retryReason)).toBe(true);
  });
  it.each([
    { executionCancellation: { state: "requested" } },
    { startupCancellation: { errorCode: "cancelled" } },
    { cancelledByActorType: "user" },
    { cancellation: { initiator: { type: "user" } } },
    { cancellation: { initiator: { type: "agent" } } },
  ])("Stop overrides stale resource-wait proof: %j", stop => {
    expect(cancelledRunRejectsAutomaticRetry({ status: "cancelled", errorCode: "ai_connection_busy",
      resultJson: { executionRecovery: { kind: "ai_connection_wait", providerWorkStarted: false }, ...stop },
    }, "ai_connection_busy")).toBe(true);
  });
});
