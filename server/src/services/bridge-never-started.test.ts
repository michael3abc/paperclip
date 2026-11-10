import { describe, expect, it } from "vitest";
import { bridgeSessionNeverStarted } from "./explicit-native-continuation.js";

const run = (over: Record<string, unknown> = {}) => ({
  status: "failed", runtimeMode: "legacy", errorCode: "session_start_failed", resultJson: null,
  processPid: null, processGroupId: null, nativeSessionId: null, ...over,
}) as Parameters<typeof bridgeSessionNeverStarted>[0];

describe("bridgeSessionNeverStarted", () => {
  it("accepts a Bridge run that failed before any session work existed", () => {
    expect(bridgeSessionNeverStarted(run())).toBe(true);
    expect(bridgeSessionNeverStarted(run({ errorCode: "session_busy", resultJson: {} }))).toBe(true);
  });

  it("never treats input-uncertain or unrelated failures as stopped", () => {
    for (const errorCode of ["execution_uncertain", "bridge_unavailable", "background_state_unknown", null]) {
      expect(bridgeSessionNeverStarted(run({ errorCode }))).toBe(false);
    }
  });

  it("keeps the hold when any session, process or stop evidence exists", () => {
    expect(bridgeSessionNeverStarted(run({ resultJson: { bridgeSessionId: "b1" } }))).toBe(false);
    expect(bridgeSessionNeverStarted(run({ resultJson: { nativeSessionId: "n1" } }))).toBe(false);
    expect(bridgeSessionNeverStarted(run({ nativeSessionId: "n1" }))).toBe(false);
    expect(bridgeSessionNeverStarted(run({ processPid: 42 }))).toBe(false);
    expect(bridgeSessionNeverStarted(run({ processGroupId: 42 }))).toBe(false);
    expect(bridgeSessionNeverStarted(run({ resultJson: { executionCancellation: { state: "requested" } } }))).toBe(false);
  });

  it("only applies to terminal failed legacy runs", () => {
    expect(bridgeSessionNeverStarted(run({ status: "cancelled" }))).toBe(false);
    expect(bridgeSessionNeverStarted(run({ status: "timed_out" }))).toBe(false);
    expect(bridgeSessionNeverStarted(run({ runtimeMode: "native" }))).toBe(false);
  });
});
