import { and, eq } from "drizzle-orm";
import { agentWakeupRequests, issueComments, issueExternalWaits, issues, type Db } from "@paperclipai/db";
import type { CompleteIssueExternalWait, RegisterIssueExternalWait } from "@paperclipai/shared";
import { badRequest, conflict, forbidden, notFound } from "../errors.js";
import { logActivity } from "./activity-log.js";
import type { WakeupOptions } from "./heartbeat/run-preparation.js";

export type ExternalWaitAdmission = {
  before(tx: Db): Promise<boolean>;
  after(tx: Db): Promise<void>;
};
type Actor = { actorType: "user" | "agent" | "system"; actorId: string; agentId?: string | null; runId?: string | null };
type Target = { companyId: string; id: string };
type Wait = typeof issueExternalWaits.$inferSelect;
type Completion = { wait: Wait; woke: boolean; reason?: string };

export function assertExternalWaitActor(issue: Pick<typeof issues.$inferSelect, "assigneeAgentId" | "assigneeUserId">, actor: Actor) {
  if (actor.actorType !== "user" && (actor.actorType !== "agent" || !actor.agentId ||
      issue.assigneeAgentId !== actor.agentId || issue.assigneeUserId)) {
    throw forbidden("Only the current assignee can manage external waits", { code: "external_wait_not_assignee" });
  }
}

export function issueExternalWaitService(db: Db, wakeup: (agentId: string, options: WakeupOptions) => Promise<unknown>) {
  const identity = (target: Target, body: RegisterIssueExternalWait) => and(
    eq(issueExternalWaits.companyId, target.companyId), eq(issueExternalWaits.issueId, target.id),
    eq(issueExternalWaits.service, body.service), eq(issueExternalWaits.externalRef, body.externalRef));
  async function lock(tx: Db, target: Target, actor: Actor) {
    const [issue] = await tx.select().from(issues).where(and(eq(issues.companyId, target.companyId), eq(issues.id, target.id))).for("update");
    if (!issue) throw notFound("Issue not found");
    assertExternalWaitActor(issue, actor);
    return issue;
  }
  async function audit(tx: Db, target: Target, actor: Actor, action: string, wait: Wait) {
    await logActivity(tx, { companyId: target.companyId, entityType: "issue", entityId: target.id,
      actorType: actor.actorType, actorId: actor.actorId, agentId: actor.agentId, runId: actor.runId,
      action, details: { externalWaitId: wait.id, service: wait.service, externalRef: wait.externalRef,
        outcome: wait.outcome, completionCommentId: wait.completionCommentId, wakeRequestId: wait.wakeRequestId } });
  }
  async function settle(tx: Db, target: Target, actor: Actor, body: CompleteIssueExternalWait): Promise<Completion> {
    await lock(tx, target, actor);
    const [existing] = await tx.select().from(issueExternalWaits).where(identity(target, body));
    if (existing && existing.status !== "waiting") return { wait: existing, woke: false, reason: "already_settled" };
    if (body.commentId) {
      const [comment] = await tx.select({ id: issueComments.id }).from(issueComments).where(and(
        eq(issueComments.id, body.commentId), eq(issueComments.companyId, target.companyId), eq(issueComments.issueId, target.id)));
      if (!comment) throw badRequest("Completion comment must belong to this issue");
    }
    const values = { status: "completed", outcome: body.outcome ?? null, completionCommentId: body.commentId ?? null,
      completedByRunId: actor.runId ?? null, completedAt: new Date(), updatedAt: new Date() };
    const [wait] = existing
      ? await tx.update(issueExternalWaits).set(values).where(eq(issueExternalWaits.id, existing.id)).returning()
      : await tx.insert(issueExternalWaits).values({ ...values, companyId: target.companyId, issueId: target.id,
          service: body.service, externalRef: body.externalRef, agentId: actor.agentId ?? null }).returning();
    return { wait: wait!, woke: false };
  }
  return {
    list: (target: Target) => db.select().from(issueExternalWaits).where(and(
      eq(issueExternalWaits.companyId, target.companyId), eq(issueExternalWaits.issueId, target.id))).orderBy(issueExternalWaits.createdAt, issueExternalWaits.id),
    register: (target: Target, actor: Actor, body: RegisterIssueExternalWait) => db.transaction(async transaction => {
      const tx = transaction as unknown as Db;
      const issue = await lock(tx, target, actor);
      if (["done", "cancelled"].includes(issue.status)) throw conflict("Issue is closed", { code: "external_wait_issue_closed" });
      const [existing] = await tx.select().from(issueExternalWaits).where(identity(target, body));
      if (existing) return { wait: existing, created: false };
      const [wait] = await tx.insert(issueExternalWaits).values({ companyId: target.companyId, issueId: target.id,
        ...body, agentId: actor.agentId ?? null, registeredByRunId: actor.runId ?? null }).returning();
      await audit(tx, target, actor, "issue.external_wait_registered", wait!);
      return { wait: wait!, created: true };
    }),
    cancel: (target: Target, actor: Actor, body: RegisterIssueExternalWait) => db.transaction(async transaction => {
      const tx = transaction as unknown as Db;
      await lock(tx, target, actor);
      const [existing] = await tx.select().from(issueExternalWaits).where(identity(target, body));
      if (!existing) throw notFound("External wait not found");
      if (existing.status !== "waiting") return { wait: existing };
      const [wait] = await tx.update(issueExternalWaits).set({ status: "cancelled", completedAt: new Date(), updatedAt: new Date(),
        completedByRunId: actor.runId ?? null }).where(eq(issueExternalWaits.id, existing.id)).returning();
      await audit(tx, target, actor, "issue.external_wait_cancelled", wait!);
      return { wait: wait! };
    }),
    complete: async (target: Target, actor: Actor, body: CompleteIssueExternalWait): Promise<Completion> => {
      // Settle non-waking cases under the same lock; waking cases settle inside
      // normal heartbeat admission, atomically with its queued/deferred receipt.
      const initial = await db.transaction(async transaction => {
        const tx = transaction as unknown as Db;
        const issue = await lock(tx, target, actor);
        const [existing] = await tx.select().from(issueExternalWaits).where(identity(target, body));
        if (existing && existing.status !== "waiting") return { result: { wait: existing, woke: false, reason: "already_settled" } };
        if (!["in_progress", "in_review"].includes(issue.status) || !issue.assigneeAgentId || issue.assigneeUserId) {
          const result = await settle(tx, target, actor, body);
          result.reason = `issue_${issue.status}`;
          await audit(tx, target, actor, "issue.external_wait_completed", result.wait);
          return { result };
        }
        return { agentId: issue.assigneeAgentId };
      });
      if (initial.result) return initial.result;
      const key = `external-wait-completed:${target.id}:${body.service}:${body.externalRef}`;
      let result: Completion | undefined;
      const externalWait = { service: body.service, externalRef: body.externalRef, outcome: body.outcome ?? null };
      const context = { issueId: target.id, taskId: target.id, externalWait,
        wakeReason: "external_wait_completed", ...(body.commentId ? { wakeCommentId: body.commentId, commentId: body.commentId } : {}) };
      await wakeup(initial.agentId!, {
        source: "automation", triggerDetail: "callback", reason: "external_wait_completed", idempotencyKey: key,
        allowRunCoalescing: false, requestedByActorType: actor.actorType, requestedByActorId: actor.actorId,
        payload: { ...context }, contextSnapshot: context,
        externalWaitAdmission: {
          before: async tx => {
            const issue = await lock(tx, target, actor);
            if (issue.assigneeAgentId && !issue.assigneeUserId && ["in_progress", "in_review"].includes(issue.status)
                && issue.assigneeAgentId !== initial.agentId) {
              throw conflict("Issue assignee changed before completion admission", { code: "external_wait_assignee_changed" });
            }
            result = await settle(tx, target, actor, body);
            if (result.reason === "already_settled") return false;
            if (issue.assigneeAgentId !== initial.agentId || issue.assigneeUserId || !["in_progress", "in_review"].includes(issue.status)) {
              result.reason = `issue_${issue.status}`;
              await audit(tx, target, actor, "issue.external_wait_completed", result.wait);
              return false;
            }
            return true;
          },
          after: async tx => {
            const [wake] = await tx.select().from(agentWakeupRequests).where(and(
              eq(agentWakeupRequests.companyId, target.companyId), eq(agentWakeupRequests.idempotencyKey, key)));
            if (!wake) throw conflict("External wait wake admission did not save a receipt", { code: "external_wait_wake_not_saved" });
            // Deferral is represented by status; retain this completion's
            // causal reason on the receipt as well as in its saved context.
            await tx.update(agentWakeupRequests).set({ reason: "external_wait_completed" }).where(eq(agentWakeupRequests.id, wake.id));
            const [wait] = await tx.update(issueExternalWaits).set({ wakeRequestId: wake.id }).where(eq(issueExternalWaits.id, result!.wait.id)).returning();
            const woke = !["skipped", "failed", "cancelled"].includes(wake.status);
            result = { wait: wait!, woke, ...(!woke ? { reason: `wake_${wake.status}` } : {}) };
            await audit(tx, target, actor, "issue.external_wait_completed", wait!);
          },
        },
      });
      if (!result) {
        // A concurrent completion may already have saved the unique wake before
        // heartbeat's pre-admission idempotency lookup returned its receipt.
        const [saved] = await db.select().from(issueExternalWaits).where(identity(target, body));
        if (saved && saved.status !== "waiting") return { wait: saved, woke: false, reason: "already_settled" };
        throw conflict("External wait did not reach issue wake admission", { code: "external_wait_admission_unavailable" });
      }
      return result;
    },
  };
}
