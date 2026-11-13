/**
 * Liveness-first run failure classification.
 *
 * Policy: /home/michael/services/docs/agents/liveness-first.md (rule 4).
 *
 * - transient: retried automatically with 30s x 2^n backoff capped at 30 min,
 *   unlimited attempts, one deduplicated notice at the 5th consecutive failure.
 * - deterministic: bad configuration a retry cannot fix; no automatic retry,
 *   one notice per (issue, code).
 * - unknown: retried as transient three times, then treated as deterministic.
 *
 * Every former ccpocket "uncertain" code is transient. Legacy rows that still
 * carry those codes are classified the same way.
 */

export type RunFailureClass = "transient" | "deterministic" | "unknown";
export type EffectiveRunFailureClass = "transient" | "deterministic";

export const RUN_FAILURE_BACKOFF_BASE_MS = 30_000;
export const RUN_FAILURE_BACKOFF_CAP_MS = 30 * 60_000;
export const UNKNOWN_FAILURE_TRANSIENT_ATTEMPTS = 3;
export const TRANSIENT_FAILURE_NOTICE_THRESHOLD = 5;

export const INACTIVITY_TIMEOUT_ERROR_CODE = "inactivity_timeout";
export const PROCESS_LOST_ERROR_CODE = "process_lost";
export const SERVER_SHUTDOWN_INTERRUPTED_ERROR_CODE = "server_shutdown_interrupted";
export const ABANDONED_PRIOR_ERROR_CODE = "abandoned_prior";
export const ABANDONED_LIVENESS_RESET_ERROR_CODE = "abandoned_liveness_reset";

export const TRANSIENT_RUN_FAILURE_CODES: ReadonlySet<string> = new Set<string>([
  // Liveness-first adapter/server codes.
  "bridge_unavailable",
  "host_unavailable",
  INACTIVITY_TIMEOUT_ERROR_CODE,
  "session_busy",
  PROCESS_LOST_ERROR_CODE,
  SERVER_SHUTDOWN_INTERRUPTED_ERROR_CODE,
  ABANDONED_PRIOR_ERROR_CODE,
  ABANDONED_LIVENESS_RESET_ERROR_CODE,
  // Provider and infrastructure transients.
  "adapter_failed",
  "timeout",
  "codex_transient_upstream",
  "codex_harness_crash",
  "claude_transient_upstream",
  "provider_quota",
  "controller_lease_lost",
  "session_authority_busy",
  "remote_workspace_prepare_timeout",
  // Former ccpocket "uncertain" codes (legacy rows included).
  "manual_takeover",
  "input_source_unknown",
  "history_incomplete",
  "bridge_update_required",
  "background_state_unknown",
  "stop_unconfirmed",
  "unresolved_run",
  "execution_uncertain",
  "binding_changed",
  "stale_run",
  // Former fail-closed gate codes (legacy rows included).
  "binding_reconciliation_required",
  "workspace_busy",
  "workspace_binding_mismatch",
  "execution_reconciliation_required",
  "agent_run_superseded",
  "worktree_host_inspection_failed",
]);

export const DETERMINISTIC_RUN_FAILURE_CODES: ReadonlySet<string> = new Set<string>([
  "project_access_denied",
  "native_provider_model_rejected",
  "provider_tool_definition_invalid",
  "adapter_engine_unavailable",
  "configuration_incomplete",
  "agent_not_invokable",
  "agent_not_found",
  "budget_blocked",
  "budget_exhausted",
  "issue_paused",
  "issue_dependencies_blocked",
  // Setup owns the durable retry budget for temporary Git scans.
  "workspace_git_scan_timeout",
  "workspace_git_scan_saturated",
  "workspace_git_scan_cancelled",
  "workspace_git_scan_output_limit",
  "workspace_git_scan_failed",
  "low_trust_isolation_unavailable",
  "low_trust_requires_isolated_workspace",
  "low_trust_boundary_mismatch",
  "low_trust_requires_sandbox_environment",
  "low_trust_runtime_services_denied",
]);

function normalizeCode(code: unknown): string | null {
  if (typeof code !== "string") return null;
  const trimmed = code.trim();
  return trimmed.length > 0 ? trimmed : null;
}

/** Static class of a failure code. Unrecognized and missing codes are `unknown`. */
export function classifyRunFailure(code: string | null | undefined): RunFailureClass {
  const normalized = normalizeCode(code);
  if (!normalized) return "unknown";
  if (TRANSIENT_RUN_FAILURE_CODES.has(normalized)) return "transient";
  if (DETERMINISTIC_RUN_FAILURE_CODES.has(normalized)) return "deterministic";
  return "unknown";
}

export function isTransientRunFailureCode(code: string | null | undefined) {
  return classifyRunFailure(code) === "transient";
}

export function isDeterministicRunFailureCode(code: string | null | undefined) {
  return classifyRunFailure(code) === "deterministic";
}

/**
 * Class after accounting for retries already spent. `consecutiveFailures`
 * counts the failure being classified (1 = first failure).
 */
export function effectiveRunFailureClass(
  code: string | null | undefined,
  consecutiveFailures: number,
): EffectiveRunFailureClass {
  const staticClass = classifyRunFailure(code);
  if (staticClass === "unknown") {
    return consecutiveFailures <= UNKNOWN_FAILURE_TRANSIENT_ATTEMPTS ? "transient" : "deterministic";
  }
  return staticClass;
}

/** Whether the system may schedule another automatic attempt. */
export function shouldAutoRetryRunFailure(
  code: string | null | undefined,
  consecutiveFailures: number,
) {
  return effectiveRunFailureClass(code, consecutiveFailures) === "transient";
}

/**
 * Backoff before retry number `attempt` (1-based): 30s, 60s, 120s, ... capped
 * at 30 minutes. Never throws; non-finite or < 1 attempts use the base delay.
 */
export function runFailureBackoffMs(attempt: number) {
  const n = Number.isFinite(attempt) ? Math.max(1, Math.floor(attempt)) : 1;
  // 2^(n-1) overflows long before it matters; clamp the exponent first.
  const exponent = Math.min(n - 1, 16);
  return Math.min(RUN_FAILURE_BACKOFF_BASE_MS * 2 ** exponent, RUN_FAILURE_BACKOFF_CAP_MS);
}

export function runFailureRetryAt(attempt: number, now = new Date()) {
  return new Date(now.getTime() + runFailureBackoffMs(attempt));
}

/** One notice exactly when the 5th consecutive transient failure is observed. */
export function shouldNotifyTransientFailure(consecutiveFailures: number) {
  return consecutiveFailures === TRANSIENT_FAILURE_NOTICE_THRESHOLD;
}
