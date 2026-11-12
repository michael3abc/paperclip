import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, expect, it } from "vitest";
import { companies, issues, issueRecoveryActions, createDb, startEmbeddedPostgresTestDatabase } from "@paperclipai/db";
import { and, eq } from "drizzle-orm";
import { executionObligationScope, executionObligationScopeSql, type ExecutionObligationScope } from "./execution-obligations.js";
import { executionBlockerPredicate } from "./execution-blocker.js";

let database: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>>;
let db: ReturnType<typeof createDb>, companyId: string;
beforeAll(async () => {
  database = await startEmbeddedPostgresTestDatabase("execution-obligations-"); db = createDb(database.connectionString);
  companyId = randomUUID();
  await db.insert(companies).values({ id: companyId, name: "Obligation fixture", issuePrefix: "OBL" });
}, 60_000);
afterAll(async () => { await db?.$client.end({ timeout: 0 }); await database?.cleanup(); });

const cases: Array<[string, Record<string, unknown>, ExecutionObligationScope]> = [
  ["native_workspace_sync_out_unrecoverable", {}, "cleanup"],
  ["native_workspace_sync_out_retry_exhausted", {}, "cleanup"],
  ["legacy_execution_requires_reconciliation", { workspaceRestoreFailure: "restore_unsafe_archive" }, "cleanup"],
  ["legacy_execution_requires_reconciliation", { workspaceRestoreRecovery: { schema: "paperclip.workspace-restore-recovery.v1" } }, "cleanup"],
  ["execution_finalization_deadline_exceeded", { workspaceRepairRequired: true }, "cleanup"],
  ["execution_finalization_deadline_exceeded", { workspaceRepairRequired: "true" }, "operation"],
  ["native_session_retry_exhausted", { sourceFailureCode: "native_workspace_sync_out_unrecoverable" }, "cleanup"],
  ["native_session_cleanup_quarantined", { workspaceRepairRequired: true }, "session"],
  ["native_session_retry_exhausted", { sourceFailureCode: "native_session_cleanup_quarantined", workspaceRepairRequired: true }, "session"],
  ["provider_ownership_unverified", {}, "session"],
  ["continuation_evidence_incomplete", {}, "input"],
  ["native_session_retry_exhausted", { sourceFailureCode: "continuation_evidence_incomplete" }, "input"],
  ...["uncertain_provider_action", "uncertain_external_action", "uncertain_control_plane_action", "completed_action_context_missing",
    "provider_effect_inventory_unavailable", "provider_failure_meaning_unverified", "native_event_replay_conflict"].map(cause =>
    [cause, { workspaceRepairRequired: true }, "operation"] as [string, Record<string, unknown>, ExecutionObligationScope]),
  ["execution_finalization_deadline_exceeded", { actionOutcome: "unknown", workspaceRepairRequired: true }, "operation"],
  ["native_restart_recovery_blocked", { recoveryMode: "bootstrap_retry", providerWorkStarted: false }, "none"],
  ["native_session_retry_exhausted", { recoveryMode: "bootstrap_retry", providerSessionEstablished: false, providerEventsExist: false }, "none"],
  ["native_session_retry_exhausted", { recoveryMode: "bootstrap_retry", providerSessionEstablished: false }, "operation"],
  ["native_session_retry_exhausted", { recoveryMode: "bootstrap_retry", providerWorkStarted: "false" }, "operation"],
  ["native_restart_recovery_blocked", {}, "operation"],
  ["execution_recovery_budget_exhausted", {}, "operation"],
  ["native_provider_terminal_failed", {}, "operation"],
  ["native_continuation_requires_reconciliation", {}, "operation"],
];
it.each(cases)("classifies %s with %j as %s consistently in admission and presentation", async (cause, evidence, scope) => {
  const issueId = randomUUID();
  await db.insert(issues).values({ id: issueId, companyId, title: "Original obligation" });
  const [saved] = await db.insert(issueRecoveryActions).values({ companyId, sourceIssueId: issueId, kind: "active_run_watchdog",
    cause, evidence, fingerprint: randomUUID(), status: "active", nextAction: "Inspect original evidence" }).returning();
  const [projection] = await db.select({ scope: executionObligationScopeSql() }).from(issueRecoveryActions).where(eq(issueRecoveryActions.id, saved.id));
  expect(executionObligationScope(cause, evidence)).toBe(scope);
  expect(projection.scope).toBe(scope);
  const blockers = await db.select().from(issueRecoveryActions).where(and(eq(issueRecoveryActions.id, saved.id), executionBlockerPredicate()));
  expect(blockers).toHaveLength(["cleanup", "none"].includes(scope) ? 0 : 1);
  expect((await db.select().from(issueRecoveryActions).where(eq(issueRecoveryActions.id, saved.id)))[0]).toEqual(saved);
});
