import { and, eq, sql } from "drizzle-orm";
import { approvals, documents, issueApprovals, issueDocuments, issueThreadInteractions, issues, type Db } from "@paperclipai/db";
import { escalateDelegatedRequestSchema, type DelegatedDecisionContext } from "@paperclipai/shared";
import { conflict, forbidden, notFound } from "../errors.js";
import { redactEventPayload } from "../redaction.js";
import { assertDelegatedDecisionActor, decisionFingerprint, nextDelegatedDecision } from "./delegated-decision-policy.js";
import { notifyDelegatedDecision } from "./delegated-decision-delivery.js";
import { ensureAssignmentIssueAccessGrant } from "./issues.js";
import { persistActivity, publishActivity } from "./activity-log.js";
import { enqueuePushSource } from "./web-push-events.js";

export type DelegatedRequestActor = { companyId: string; agentId: string; runId: string };
export type DelegatedRequestKind = "interaction" | "approval";

async function readDecisionSource(db: Db, companyId: string, issueId: string) {
  const [source] = await db.select({ id: issues.id, identifier: issues.identifier, title: issues.title,
    description: issues.description, projectId: issues.projectId, status: issues.status,
    assigneeAgentId: issues.assigneeAgentId, executionRunId: issues.executionRunId,
  }).from(issues).where(and(eq(issues.id, issueId), eq(issues.companyId, companyId))).limit(1);
  if (!source) throw notFound("The delegated request's source task is unavailable");
  const refs = await db.select({ key: issueDocuments.key, title: documents.title,
    revisionId: documents.latestRevisionId }).from(issueDocuments)
    .innerJoin(documents, and(eq(documents.id, issueDocuments.documentId), eq(documents.companyId, companyId)))
    .where(and(eq(issueDocuments.issueId, issueId), eq(issueDocuments.companyId, companyId))).limit(100);
  return { ...source, description: source.description?.slice(0, 32_000) ?? null,
    descriptionTruncated: (source.description?.length ?? 0) > 32_000, documents: refs,
    taskPath: `/issues/${issueId}`, commentsPath: `/issues/${issueId}/comments` };
}

export async function getDelegatedRequest(db: Db, actor: DelegatedRequestActor, kind: DelegatedRequestKind, id: string) {
  if (kind === "interaction") {
    const [row] = await db.select().from(issueThreadInteractions).where(and(eq(issueThreadInteractions.id, id), eq(issueThreadInteractions.companyId, actor.companyId))).limit(1);
    if (!row?.delegation) throw notFound("Delegated request not found");
    await assertDelegatedDecisionActor(db, { ...actor, context: row.delegation, revision: row.delegation.revision,
      fingerprint: decisionFingerprint({ kind: row.kind, payload: row.payload, sourceRunId: row.sourceRunId }) });
    return { kind, requestId: row.id, issueId: row.issueId, revision: row.delegation.revision, request: row,
      delegation: row.delegation, sources: [await readDecisionSource(db, actor.companyId, row.issueId)] };
  }
  const [row] = await db.select().from(approvals).where(and(eq(approvals.id, id), eq(approvals.companyId, actor.companyId))).limit(1);
  if (!row?.delegation) throw notFound("Delegated request not found");
  await assertDelegatedDecisionActor(db, { ...actor, context: row.delegation, revision: row.delegation.revision,
    fingerprint: decisionFingerprint({ type: row.type, payload: row.payload }) });
  const linked = await db.select({ issueId: issueApprovals.issueId }).from(issueApprovals)
    .where(and(eq(issueApprovals.approvalId, row.id), eq(issueApprovals.companyId, actor.companyId))).limit(100);
  const sources = [];
  for (const link of linked) sources.push(await readDecisionSource(db, actor.companyId, link.issueId));
  return { kind, requestId: row.id, issueId: null, revision: row.delegation.revision,
    request: { ...row, payload: redactEventPayload(row.payload) ?? {} }, delegation: row.delegation, sources };
}

export async function listDelegatedRequests(db: Db, actor: DelegatedRequestActor) {
  const result: { kind: DelegatedRequestKind; requestId: string; revision: string; delegation: DelegatedDecisionContext }[] = [];
  for (const [table, kind] of [[issueThreadInteractions, "interaction"], [approvals, "approval"]] as const) {
    const rows = await db.select({ id: table.id, delegation: table.delegation }).from(table).where(and(
      eq(table.companyId, actor.companyId), eq(table.status, "pending"),
      sql`${table.delegation}->>'recipientAgentId' = ${actor.agentId}`,
    )).limit(100);
    for (const row of rows) if (row.delegation) result.push({ kind, requestId: row.id, revision: row.delegation.revision, delegation: row.delegation });
  }
  return result;
}

export async function escalateDelegatedRequest(db: Db, actor: DelegatedRequestActor, value: unknown) {
  const input = escalateDelegatedRequestSchema.parse(value);
  if (input.kind === "runtime") throw forbidden("Use the delegated interaction bound to the native request");
  const kind = input.kind;
  const initial = await getDelegatedRequest(db, actor, kind, input.requestId);
  const table = input.kind === "interaction" ? issueThreadInteractions : approvals;
  let publication: Parameters<typeof publishActivity>[0] | undefined;
  const result = await db.transaction(async tx => {
    if (initial.issueId) await tx.select({ id: issues.id }).from(issues).where(eq(issues.id, initial.issueId)).for("update");
    const [current] = await tx.select().from(table).where(and(eq(table.id, input.requestId), eq(table.companyId, actor.companyId))).for("update");
    if (!current?.delegation || current.status !== "pending" || current.delegation.revision !== input.revision) throw conflict("The request is no longer pending at this revision");
    await getDelegatedRequest(tx as unknown as Db, actor, kind, input.requestId);
    const context = nextDelegatedDecision(current.delegation, input.humanReason);
    delete context.notifiedRevision;
    delete context.deliveryError;
    await notifyDelegatedDecision(tx, actor.companyId);
    if (input.kind === "interaction") {
      await tx.update(issueThreadInteractions).set({ delegation: context,
        addresseeAgentId: context.recipientAgentId, addresseeUserId: context.level === "human" ? context.ownerUserId : null,
        effectiveResolverPolicy: context.level === "human" ? "human_only" : "anyone", updatedAt: new Date(),
      }).where(eq(issueThreadInteractions.id, input.requestId));
      const [issue] = await tx.select().from(issues).where(eq(issues.id, initial.issueId!));
      if (issue) await ensureAssignmentIssueAccessGrant(tx, { ...issue,
        assigneeAgentId: context.recipientAgentId, assigneeUserId: context.level === "human" ? context.ownerUserId : null,
      }, null, actor);
    } else await tx.update(approvals).set({ delegation: context, updatedAt: new Date() }).where(eq(approvals.id, input.requestId));
    if (context.level === "human") await enqueuePushSource(tx as unknown as Db, {
      companyId: actor.companyId, issueId: initial.issueId,
      eventKey: `delegated-decision:${input.requestId}:${context.revision}`, sourceKind: kind, sourceId: input.requestId,
      category: "approval",
    });
    const activity = await persistActivity(tx as unknown as Db, { companyId: actor.companyId, actorType: "agent",
      actorId: actor.agentId, agentId: actor.agentId, runId: actor.runId,
      action: "delegation.escalated", entityType: input.kind, entityId: input.requestId,
      details: { previousRevision: input.revision, delegation: context, reason: input.reason } });
    publication = activity.publication;
    return { kind: input.kind, requestId: input.requestId, delegation: context };
  });
  if (publication) publishActivity(publication);
  return result;
}
