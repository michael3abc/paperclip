import { describe, expect, it } from "vitest";
import {
  RUN_FAILURE_BACKOFF_BASE_MS,
  RUN_FAILURE_BACKOFF_CAP_MS,
  classifyRunFailure,
  effectiveRunFailureClass,
  runFailureBackoffMs,
  runFailureRetryAt,
  shouldAutoRetryRunFailure,
  shouldNotifyTransientFailure,
} from "./failure-classification.js";
import { createHostCircuitBreaker, hostCircuitKeyForAgent } from "../host-circuit-breaker.js";
import { transientFailureNoticeKey } from "./transient-failure-notice.js";

describe("liveness-first run failure classification", () => {
  it("treats adapter liveness codes and every former ccpocket uncertain code as transient", () => {
    for (const code of [
      "bridge_unavailable", "host_unavailable", "inactivity_timeout", "session_busy",
      "process_lost", "server_shutdown_interrupted", "abandoned_prior", "abandoned_liveness_reset",
      "adapter_failed", "timeout", "controller_lease_lost", "codex_transient_upstream",
      "manual_takeover", "input_source_unknown", "history_incomplete", "bridge_update_required",
      "background_state_unknown", "stop_unconfirmed", "unresolved_run", "execution_uncertain",
      "binding_changed", "stale_run", "binding_reconciliation_required", "agent_run_superseded",
      "workspace_binding_mismatch", "execution_reconciliation_required",
    ]) {
      expect(classifyRunFailure(code), code).toBe("transient");
    }
  });

  it("treats configuration failures as deterministic", () => {
    for (const code of [
      "project_access_denied", "native_provider_model_rejected", "provider_tool_definition_invalid",
      "adapter_engine_unavailable", "configuration_incomplete", "agent_not_invokable", "budget_blocked",
    ]) {
      expect(classifyRunFailure(code), code).toBe("deterministic");
    }
  });

  it("treats missing and unrecognized codes as unknown", () => {
    expect(classifyRunFailure(null)).toBe("unknown");
    expect(classifyRunFailure(undefined)).toBe("unknown");
    expect(classifyRunFailure("  ")).toBe("unknown");
    expect(classifyRunFailure("setup_failed")).toBe("unknown");
    expect(classifyRunFailure("something_new")).toBe("unknown");
  });

  it("retries transient failures without limit and never retries deterministic ones", () => {
    expect(shouldAutoRetryRunFailure("bridge_unavailable", 1)).toBe(true);
    expect(shouldAutoRetryRunFailure("bridge_unavailable", 500)).toBe(true);
    expect(shouldAutoRetryRunFailure("project_access_denied", 1)).toBe(false);
  });

  it("retries unknown codes three times, then treats them as deterministic", () => {
    expect(effectiveRunFailureClass("setup_failed", 1)).toBe("transient");
    expect(effectiveRunFailureClass("setup_failed", 3)).toBe("transient");
    expect(effectiveRunFailureClass("setup_failed", 4)).toBe("deterministic");
    expect(shouldAutoRetryRunFailure(null, 4)).toBe(false);
  });

  it("backs off 30s x 2^n and caps at 30 minutes", () => {
    expect(runFailureBackoffMs(1)).toBe(RUN_FAILURE_BACKOFF_BASE_MS);
    expect(runFailureBackoffMs(2)).toBe(60_000);
    expect(runFailureBackoffMs(3)).toBe(120_000);
    expect(runFailureBackoffMs(6)).toBe(960_000);
    expect(runFailureBackoffMs(7)).toBe(RUN_FAILURE_BACKOFF_CAP_MS);
    expect(runFailureBackoffMs(10_000)).toBe(RUN_FAILURE_BACKOFF_CAP_MS);
    expect(runFailureBackoffMs(0)).toBe(RUN_FAILURE_BACKOFF_BASE_MS);
    expect(runFailureBackoffMs(Number.NaN)).toBe(RUN_FAILURE_BACKOFF_BASE_MS);
    const now = new Date("2026-11-13T00:00:00.000Z");
    expect(runFailureRetryAt(2, now).toISOString()).toBe("2026-11-13T00:01:00.000Z");
  });

  it("notifies exactly once, at the fifth consecutive failure", () => {
    expect([1, 2, 3, 4, 5, 6, 10].map(shouldNotifyTransientFailure)).toEqual([
      false, false, false, false, true, false, false,
    ]);
    expect(transientFailureNoticeKey("bridge_unavailable")).toBe("transient_failure_streak:bridge_unavailable");
    expect(transientFailureNoticeKey(null)).toBe("transient_failure_streak:unknown");
  });
});

describe("host circuit breaker", () => {
  it("opens on host failures with capped backoff, ignores other codes and closes on success", () => {
    let now = 0;
    const breaker = createHostCircuitBreaker({ now: () => now });
    expect(breaker.recordFailure("h1", "adapter_failed")).toBeNull();
    expect(breaker.openUntil("h1")).toBeNull();
    expect(breaker.recordFailure("h1", "host_unavailable")?.getTime()).toBe(30_000);
    expect(breaker.recordFailure("h1", "bridge_unavailable")?.getTime()).toBe(60_000);
    for (let i = 0; i < 20; i += 1) breaker.recordFailure("h1", "host_unavailable");
    expect(breaker.openUntil("h1")?.getTime()).toBe(30 * 60_000);
    now = 31 * 60_000;
    expect(breaker.openUntil("h1")).toBeNull();
    breaker.recordFailure("h1", "host_unavailable");
    expect(breaker.takeNotice("h1")).toBe(false);
    now = 62 * 60_000;
    expect(breaker.takeNotice("h1")).toBe(true);
    expect(breaker.takeNotice("h1")).toBe(false);
    breaker.recordSuccess("h1");
    expect(breaker.openUntil("h1")).toBeNull();
    expect(breaker.snapshot()).toEqual([]);
  });

  it("keys CC Pocket agents by configured host or the local Bridge", () => {
    expect(hostCircuitKeyForAgent({ adapterType: "ccpocket_bridge", adapterConfig: { hostId: "D" } })).toBe("ccpocket_bridge:D");
    expect(hostCircuitKeyForAgent({ adapterType: "ccpocket_bridge", adapterConfig: {} })).toBe("ccpocket_bridge:local");
    expect(hostCircuitKeyForAgent({ adapterType: "codex_local", adapterConfig: {} })).toBeNull();
    expect(hostCircuitKeyForAgent(null)).toBeNull();
  });
});
