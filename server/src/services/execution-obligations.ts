import { issueRecoveryActions } from "@paperclipai/db";
import { and, or, sql } from "drizzle-orm";

export type ExecutionObligationScope = "cleanup" | "session" | "input" | "operation" | "none";
type Rule = { scope: ExecutionObligationScope; causes?: readonly string[]; evidence?: Record<string, string | boolean> };
// Ordered once for both SQL admission and API projections. Known mixed effects
// take precedence over file cleanup. Missing evidence never proves non-delivery.
const rules: readonly Rule[] = [
  { scope: "operation", causes: ["uncertain_provider_action", "uncertain_external_action", "uncertain_control_plane_action",
    "completed_action_context_missing", "provider_effect_inventory_unavailable", "provider_failure_meaning_unverified",
    "native_event_replay_conflict", "native_permission_declined", "native_provider_approval_required"] },
  { scope: "input", causes: ["continuation_evidence_incomplete", "delivery_unknown"] },
  { scope: "session", causes: ["provider_ownership_unverified", "native_session_cleanup_quarantined",
    "native_execution_ownership_unverified", "native_adopted_runner_authentication_timeout", "session_busy"] },
  { scope: "operation", evidence: { actionOutcome: "unknown" } },
  { scope: "input", evidence: { deliveryState: "unknown" } },
  { scope: "session", evidence: { providerOwnershipUnverified: true } },
  { scope: "cleanup", causes: ["native_workspace_sync_out_unrecoverable", "native_workspace_sync_out_retry_exhausted", "restore_unsafe_archive"] },
  { scope: "cleanup", evidence: { workspaceRestoreFailure: "restore_unsafe_archive" } },
  { scope: "cleanup", evidence: { "workspaceRestoreRecovery.schema": "paperclip.workspace-restore-recovery.v1" } },
  { scope: "cleanup", evidence: { workspaceRepairRequired: true } },
  { scope: "none", evidence: { recoveryMode: "bootstrap_retry", providerSessionEstablished: false, providerEventsExist: false } },
  { scope: "none", evidence: { recoveryMode: "bootstrap_retry", providerWorkStarted: false } },
];
const wrappers = ["execution_finalization_deadline_exceeded", "execution_recovery_budget_exhausted", "native_provider_terminal_failed",
  "native_session_retry_exhausted", "native_restart_recovery_blocked", "native_continuation_requires_reconciliation", "legacy_execution_requires_reconciliation"];
const evidenceValue = (evidence: Record<string, unknown>, key: string): unknown => key.split(".").reduce<unknown>((value, part) =>
  value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>)[part] : undefined, evidence);

export function executionObligationScope(cause: string, evidence: Record<string, unknown> = {}): ExecutionObligationScope {
  const codes = [cause, ...(wrappers.includes(cause) && typeof evidence.sourceFailureCode === "string" ? [evidence.sourceFailureCode] : [])];
  return rules.find(rule => rule.causes ? rule.causes.some(code => codes.includes(code))
    : Object.entries(rule.evidence!).every(([key, value]) => evidenceValue(evidence, key) === value))?.scope ?? "operation";
}

export function executionObligationScopeSql() {
  const cause = issueRecoveryActions.cause, evidence = issueRecoveryActions.evidence;
  const source = sql`case when ${cause} in (${sql.join(wrappers.map(value => sql`${value}`), sql`, `)}) then ${evidence}->>'sourceFailureCode' else null end`;
  const clauses = rules.map(rule => {
    const condition = rule.causes ? or(...rule.causes.map(code => or(sql`${cause} = ${code}`, sql`${source} = ${code}`)))
      : and(...Object.entries(rule.evidence!).map(([key, value]) => {
        const keys = key.split('.');
        // JSON comparison retains types: the string "false" is not false.
        const path = sql`array[${sql.join(keys.map(part => sql`${part}`), sql`, `)}]::text[]`;
        return sql`${evidence} #> ${path} = ${JSON.stringify(value)}::jsonb`;
      }));
    return sql`when ${condition} then ${rule.scope}`;
  });
  return sql<ExecutionObligationScope>`case ${sql.join(clauses, sql` `)} else 'operation' end`;
}
