import { notifyToolReviewChange } from "../services/tool-review-work-notifications.js";
import { writeApprovalChange } from "../services/approval-work-notifications.js";
import { and, eq, inArray } from "drizzle-orm";
import { approvals, type Db } from "@paperclipai/db";
import { notFound, unprocessable } from "../errors.js";
import { assertDelegatedDecisionActor, decisionFingerprint, approvalReservedReasons } from "../services/delegated-decision-policy.js";
import { forbidden } from "../errors.js";
import { persistActivity } from "../services/activity-log.js";

export type ApprovalDecisionActor = string | { agentId: string; runId: string; revision: string };

export const resolvableApprovalStatuses = ["pending", "revision_requested"];

export function approvalResolutionRecords(db: Db) {
  const canResolveStatuses = new Set(resolvableApprovalStatuses);
  const resolvableStatuses = resolvableApprovalStatuses;
  type ApprovalRecord = typeof approvals.$inferSelect;
  type ResolutionResult = { approval: ApprovalRecord; applied: boolean };
  async function getExistingApproval(id: string, database: Db = db) {
    const existing = await database
      .select()
      .from(approvals)
      .where(eq(approvals.id, id))
      .then((rows) => rows[0] ?? null);
    if (!existing) throw notFound("Approval not found");
    return existing;
  }

  async function resolveApproval(
    id: string,
    targetStatus: "approved" | "rejected",
    actor: ApprovalDecisionActor,
    decisionNote: string | null | undefined,
    database: Db = db,
  ): Promise<ResolutionResult> {
    const existing = await getExistingApproval(id, database);
    if (!canResolveStatuses.has(existing.status)) {
      if (existing.status === targetStatus) {
        if (typeof actor !== "string" && (existing.decidedByAgentId !== actor.agentId
          || existing.delegation?.revision !== actor.revision || existing.decisionNote !== (decisionNote ?? null))) {
          throw forbidden("This approval was already decided by another request");
        }
        return { approval: existing, applied: false };
      }
      throw unprocessable(
        `Only pending or revision requested approvals can be ${targetStatus === "approved" ? "approved" : "rejected"}`,
      );
    }

    const now = new Date();
    const updated = await writeApprovalChange(database, existing.companyId, async tx => {
      // Recheck authority and the exact payload under the same approval lock as
      // the decision. The HTTP route and a native tool share this boundary.
      const current = await getExistingApproval(id, tx);
      if (typeof actor === "string" && current.delegation?.level === "human" && actor !== current.delegation.ownerUserId) throw forbidden("This decision is reserved for the delegating human Owner");
      if (typeof actor !== "string") {
        if (!current.delegation || approvalReservedReasons(current.type, current.payload).length) throw forbidden("This approval requires the human Owner");
        await assertDelegatedDecisionActor(tx, { companyId: current.companyId, context: current.delegation,
          agentId: actor.agentId, runId: actor.runId, revision: actor.revision,
          fingerprint: decisionFingerprint({ type: current.type, payload: current.payload }) });
        if (!decisionNote?.trim()) throw forbidden("A delegated approval requires a decision reason");
      }
      await notifyToolReviewChange(tx, existing.companyId);
      const saved = await tx.update(approvals)
      .set({
        status: targetStatus,
        decidedByUserId: typeof actor === "string" ? actor : null,
        decidedByAgentId: typeof actor === "string" ? null : actor.agentId,
        decisionNote: decisionNote ?? null,
        decidedAt: now,
        updatedAt: now,
      })
      .where(and(eq(approvals.id, id), inArray(approvals.status, resolvableStatuses)))
      .returning()
      .then((rows) => rows[0] ?? null);
      if (saved && typeof actor !== "string") await persistActivity(tx, {
        companyId: saved.companyId, actorType: "agent", actorId: actor.agentId, agentId: actor.agentId, runId: actor.runId,
        action: "delegation.decision_recorded", entityType: "approval", entityId: id,
        details: { delegation: saved.delegation, reason: decisionNote, type: saved.type },
      });
      return saved;
    }, { approvalId: id });

    if (updated) {
      return { approval: updated, applied: true };
    }

    const latest = await getExistingApproval(id, database);
    if (latest.status === targetStatus) {
      if (typeof actor !== "string" && (latest.decidedByAgentId !== actor.agentId
        || latest.delegation?.revision !== actor.revision || latest.decisionNote !== (decisionNote ?? null))) {
        throw forbidden("This approval was already decided by another request");
      }
      return { approval: latest, applied: false };
    }

    throw unprocessable(
      `Only pending or revision requested approvals can be ${targetStatus === "approved" ? "approved" : "rejected"}`,
    );
  }

  return { getExistingApproval, resolveApproval };
}
