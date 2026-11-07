import { describe, expect, it } from "vitest";
import { projectRunDiagnostics } from "./project-run-diagnostics.js";

describe("safe project execution diagnostics", () => {
  it("does not infer provider stop from a failure or missing evidence", () => {
    expect(projectRunDiagnostics({ errorCode: "failed", providerWorkStarted: null, recoveryKind: null, processStoppedAt: null }))
      .toMatchObject({ providerWorkStarted: null, processStop: "unknown", failureCategory: "execution" });
    expect(projectRunDiagnostics({ errorCode: null, providerWorkStarted: true, recoveryKind: null, processStoppedAt: new Date() }))
      .toMatchObject({ providerWorkStarted: true, processStop: "confirmed" });
    expect(projectRunDiagnostics({ errorCode: "setup_failed", providerWorkStarted: false, recoveryKind: "bootstrap", processStoppedAt: null }))
      .toMatchObject({ providerWorkStarted: false, processStop: "not_started", failureCategory: "configuration" });
  });
});
