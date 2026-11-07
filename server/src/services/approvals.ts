import { notifyToolReviewChange } from "./tool-review-work-notifications.js";
import { randomUUID } from "node:crypto";
import { writeApprovalChange } from "./approval-work-notifications.js";
import { approvalResolutionRecords, resolvableApprovalStatuses as resolvableStatuses } from "../lib/approval-records.js";
import { notifyHireApproved } from "./hire-hook.js";

import { and, asc, eq, inArray, sql, type SQL } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import { approvalComments, approvals, budgetIncidents } from "@paperclipai/db";
import { resolveBudgetIncidentSchema, type BudgetIncidentResolutionInput } from "@paperclipai/shared";
import { unprocessable } from "../errors.js";
import { redactCurrentUserText } from "../log-redaction.js";
import { createAgentLifecycle } from "./agent-lifecycle.js";

import { instanceSettingsService } from "./instance-settings.js";
import { approvalReservedReasons, decisionFingerprint, routeDelegatedDecision } from "./delegated-decision-policy.js";
import type { ApprovalDecisionActor } from "../lib/approval-records.js";

export function approvalRecords(db: Db) {
  const instanceSettings = instanceSettingsService(db);
  const { getExistingApproval, resolveApproval } = approvalResolutionRecords(db);

  function redactApprovalComment<T extends { body: string }>(comment: T, censorUsernameInLogs: boolean): T {
    return {
      ...comment,
      body: redactCurrentUserText(comment.body, { enabled: censorUsernameInLogs }),
    };
  }

  return {
    getExistingApproval, resolveApproval,
    list: (companyId: string, status?: string, readCondition?: SQL<boolean>) => {
      const conditions = [eq(approvals.companyId, companyId)];
      if (status) conditions.push(eq(approvals.status, status));
      if (readCondition) conditions.push(readCondition);
      return db.select().from(approvals).where(and(...conditions));
    },

    getById: (id: string) =>
      db
        .select()
        .from(approvals)
        .where(eq(approvals.id, id))
        .then((rows) => rows[0] ?? null),

    findOpenHireApprovalForAgent: async (companyId: string, agentId: string) => {
      const rows = await db
        .select()
        .from(approvals)
        .where(
          and(
            eq(approvals.companyId, companyId),
            eq(approvals.type, "hire_agent"),
            inArray(approvals.status, resolvableStatuses),
            sql`${approvals.payload} ->> 'agentId' = ${agentId}`,
          ),
        );
      return rows[0] ?? null;
    },

    create: (companyId: string, data: Omit<typeof approvals.$inferInsert, "companyId" | "delegation" | "decidedByAgentId">,
      source: { runId?: string | null } = {}) =>
      writeApprovalChange(db, companyId, async tx => {
        const createdAt = new Date();
        const delegation = await routeDelegatedDecision(tx, {
          companyId, requesterAgentId: data.requestedByAgentId ?? null, sourceRunId: source.runId ?? null,
          fingerprint: decisionFingerprint({ type: data.type, payload: data.payload }), createdAt,
          category: "approval", reservedReasons: approvalReservedReasons(data.type, data.payload),
          requiredScopes: ["hire_agent", "budget_override_required"].includes(data.type) ? ["agent_model_budget"] : ["ordinary_operations"],
        });
        return tx.insert(approvals).values({ ...data, companyId, createdAt, delegation, decidedByAgentId: null })
          .returning().then(rows => rows[0]);
      }),

    // Cancel an open (pending/revision_requested) approval without a board
    // decision — e.g. when its paired agent is terminated during duplicate
    // cleanup. Idempotent: a no-op on already-resolved approvals.
    cancel: async (id: string, reason?: string | null) => {
      const now = new Date();
      const [existing] = await db.select({ companyId: approvals.companyId }).from(approvals).where(eq(approvals.id, id));
      if (!existing) return null;
      const updated = await writeApprovalChange(db, existing.companyId, async tx => {
        await notifyToolReviewChange(tx, existing.companyId);
        return tx.update(approvals)
        .set({
          status: "cancelled",
          decisionNote: reason ?? null,
          decidedAt: now,
          updatedAt: now,
        })
        .where(and(eq(approvals.id, id), inArray(approvals.status, resolvableStatuses)))
        .returning()
        .then((rows) => rows[0] ?? null);
      }, { approvalId: id });
      return updated;
    },

    requestRevision: async (id: string, decidedByUserId: string, decisionNote?: string | null) => {
      const existing = await getExistingApproval(id);
      if (existing.status !== "pending") {
        throw unprocessable("Only pending approvals can request revision");
      }

      const now = new Date();
      return writeApprovalChange(db, existing.companyId, tx => tx
        .update(approvals)
        .set({
          status: "revision_requested",
          decidedByUserId,
          decidedByAgentId: null,
          decisionNote: decisionNote ?? null,
          decidedAt: now,
          updatedAt: now,
        })
        .where(eq(approvals.id, id))
        .returning()
        .then((rows) => rows[0]), { approvalId: id });
    },

    resubmit: async (id: string, payload?: Record<string, unknown>) => {
      const existing = await getExistingApproval(id);
      if (existing.status !== "revision_requested") {
        throw unprocessable("Only revision requested approvals can be resubmitted");
      }

      const now = new Date();
      return writeApprovalChange(db, existing.companyId, async tx => {
        const [current] = await tx.select().from(approvals).where(eq(approvals.id, id)).for("update");
        if (current?.status !== "revision_requested") throw unprocessable("The approval changed before resubmission");
        const nextPayload = payload ?? current.payload;
        let delegation = current.delegation;
        if (delegation) {
          const reservedReasons = [...new Set([...delegation.reservedReasons, ...approvalReservedReasons(current.type, nextPayload)])];
          delegation = { ...delegation, revision: randomUUID(), sourceFingerprint: decisionFingerprint({ type: current.type, payload: nextPayload }), reservedReasons,
            ...(reservedReasons.length ? { level: "human" as const, recipientAgentId: null } : {}) };
          delete delegation.notifiedRevision;
          delete delegation.deliveryError;
        }
        return tx.update(approvals)
        .set({
          status: "pending",
          payload: nextPayload,
          delegation,
          decisionNote: null,
          decidedByUserId: null,
          decidedByAgentId: null,
          decidedAt: null,
          updatedAt: now,
        })
        .where(eq(approvals.id, id))
        .returning()
        .then((rows) => rows[0]);
      }, { approvalId: id });
    },

    listComments: async (approvalId: string) => {
      const existing = await getExistingApproval(approvalId);
      const { censorUsernameInLogs } = await instanceSettings.getGeneral();
      return db
        .select()
        .from(approvalComments)
        .where(
          and(
            eq(approvalComments.approvalId, approvalId),
            eq(approvalComments.companyId, existing.companyId),
          ),
        )
        .orderBy(asc(approvalComments.createdAt))
        .then((comments) => comments.map((comment) => redactApprovalComment(comment, censorUsernameInLogs)));
    },

    addComment: async (
      approvalId: string,
      body: string,
      actor: { agentId?: string; userId?: string },
    ) => {
      const existing = await getExistingApproval(approvalId);
      const currentUserRedactionOptions = {
        enabled: (await instanceSettings.getGeneral()).censorUsernameInLogs,
      };
      const redactedBody = redactCurrentUserText(body, currentUserRedactionOptions);
      return db
        .insert(approvalComments)
        .values({
          companyId: existing.companyId,
          approvalId,
          authorAgentId: actor.agentId ?? null,
          authorUserId: actor.userId ?? null,
          body: redactedBody,
        })
        .returning()
        .then((rows) => redactApprovalComment(rows[0], currentUserRedactionOptions.enabled));
    },
  };
}

export function approvalService(db: Db) {
  const { getExistingApproval, resolveApproval, ...records } = approvalRecords(db);
  async function reconcileApprovedBuiltInAgent(companyId: string, payload: Record<string, unknown>, database: Db) {
    const sourceBuiltInAgentKey = typeof payload.sourceBuiltInAgentKey === "string" ? payload.sourceBuiltInAgentKey : null;
    if (!sourceBuiltInAgentKey) return;
    const { builtInAgentService } = await import("./built-in-agents.js");
    await builtInAgentService(database).ensure(companyId, sourceBuiltInAgentKey);
  }

  async function decideHire(target: string | { approvalId: string }, status: "approved" | "rejected", userId: ApprovalDecisionActor, note?: string | null) {
    const lifecycle = createAgentLifecycle(db);
    const result = await (status === "approved" ? lifecycle.approveHire : lifecycle.rejectHire)(target, userId, note);
    if (result?.hireApprovedAgentId && result.approval) {
      await reconcileApprovedBuiltInAgent(result.approval.companyId, result.approval.payload, db);
      void notifyHireApproved(db, { companyId: result.approval.companyId, agentId: result.hireApprovedAgentId,
        source: "approval", sourceId: result.approval.id, approvedAt: result.approval.decidedAt ?? new Date() }).catch(() => {});
    }
    return result;
  }

  async function decide(id: string, status: "approved" | "rejected", userId: ApprovalDecisionActor, note?: string | null, budgetResolution?: BudgetIncidentResolutionInput) {
    const approval = await getExistingApproval(id);
    if (approval.type === "budget_override_required" && typeof userId !== "string") {
      const [incident] = await db.select({ id: budgetIncidents.id }).from(budgetIncidents).where(and(
        eq(budgetIncidents.companyId, approval.companyId), eq(budgetIncidents.approvalId, approval.id),
      )).limit(1);
      if (!incident) throw unprocessable("The budget approval has no formal budget incident");
      const resolution = resolveBudgetIncidentSchema.parse(status === "rejected"
        ? { action: "keep_paused", decisionNote: note } : { ...budgetResolution, decisionNote: note });
      if (status === "approved" && resolution.action !== "raise_budget_and_resume") throw unprocessable("Supply the new budget amount when approving");
      const { budgetService } = await import("./budgets.js");
      await budgetService(db).resolveIncident(approval.companyId, incident.id, resolution, userId);
      return { approval: await getExistingApproval(id), applied: true };
    }
    if (approval.type === "hire_agent") {
      const result = await decideHire({ approvalId: id }, status, userId, note);
      return { approval: result!.approval!, applied: result!.applied };
    }
    return resolveApproval(id, status, userId, note);
  }
  return { ...records,
    approveHire: (agentId: string, userId: string, note?: string | null) => decideHire(agentId, "approved", userId, note),
    rejectHire: (agentId: string, userId: string, note?: string | null) => decideHire(agentId, "rejected", userId, note),
    approve: (id: string, actor: ApprovalDecisionActor, note?: string | null, budgetResolution?: BudgetIncidentResolutionInput) => decide(id, "approved", actor, note, budgetResolution),
    reject: (id: string, actor: ApprovalDecisionActor, note?: string | null) => decide(id, "rejected", actor, note),
  };
}
