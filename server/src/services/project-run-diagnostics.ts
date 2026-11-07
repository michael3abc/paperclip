import type { ProjectSessionRecord } from "@paperclipai/shared";

/** Explicit projection: never expose raw errors, result payloads, logs or configuration. */
export function projectRunDiagnostics(input: {
  errorCode: string | null; providerWorkStarted: unknown; recoveryKind: unknown;
  processStoppedAt: Date | null;
}): NonNullable<ProjectSessionRecord["diagnostics"]> {
  const providerWorkStarted = typeof input.providerWorkStarted === "boolean" ? input.providerWorkStarted : null;
  const failureCategory = input.errorCode === "workspace_validation_failed" ? "workspace"
    : ["configuration_incomplete", "setup_failed", "provider_not_started"].includes(input.errorCode ?? "") ? "configuration"
    : input.errorCode ? "execution" : null;
  return { failureCategory, providerWorkStarted,
    processStop: input.processStoppedAt ? "confirmed"
      : providerWorkStarted === false && input.recoveryKind === "bootstrap" ? "not_started" : "unknown",
    recoverySummary: failureCategory === "workspace" ? "Inspect the task's configured development repository and workspace ownership. A failed run is not authorization to retry."
      : failureCategory === "configuration" ? "Inspect current dispatchReadiness and task configuration before scheduling new work."
      : failureCategory ? "Execution failed. Read the task history and recovery action; a terminal run status alone does not prove process stop." : null };
}
