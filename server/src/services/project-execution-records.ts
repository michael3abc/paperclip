import { and, desc, eq, isNull, ne, sql } from "drizzle-orm";
import { agents, heartbeatRuns, issues, issueWorkProducts, issueExecutionDecisions, type Db } from "@paperclipai/db";
import type { ProjectSessionRecords, ProjectWorkProductRecords } from "@paperclipai/shared";
import { issueReadSqlCondition, authorizationService, type AuthorizationActor } from "./authorization.js";

/** Runs belong to their recorded task, never to the shared worker's current project. */
export async function projectSessionRecords(db: Db, companyId: string, projectId: string, actor: AuthorizationActor, offset = 0): Promise<ProjectSessionRecords> {
  const readable = await issueReadSqlCondition(db, actor);
  const rows = await db.select({ runId: heartbeatRuns.id, issueId: issues.id, identifier: issues.identifier,
    title: issues.title, agentId: agents.id, agentName: agents.name, status: heartbeatRuns.status,
    sessionId: sql<string | null>`coalesce(${heartbeatRuns.sessionIdAfter}, ${heartbeatRuns.sessionIdBefore}, ${heartbeatRuns.nativeSessionId}::text)`,
    startedAt: heartbeatRuns.startedAt, finishedAt: heartbeatRuns.finishedAt,
  }).from(heartbeatRuns)
    .innerJoin(issues, and(eq(issues.companyId, heartbeatRuns.companyId), sql`${issues.id}::text = coalesce(${heartbeatRuns.nativeIssueId}::text, ${heartbeatRuns.issueId}::text, ${heartbeatRuns.contextSnapshot}->>'issueId')`))
    .innerJoin(agents, and(eq(agents.id, heartbeatRuns.agentId), eq(agents.companyId, heartbeatRuns.companyId)))
    .where(and(eq(issues.companyId, companyId), eq(issues.projectId, projectId), isNull(issues.hiddenAt), readable))
    .orderBy(desc(heartbeatRuns.createdAt), desc(heartbeatRuns.id)).offset(offset).limit(51);
  const pms = await db.select({ id: agents.id, name: agents.name }).from(agents).where(and(eq(agents.companyId, companyId),
    sql`${agents.runtimeConfig}->'workspaceBinding'->>'mode' = 'project_pm'`,
    sql`${agents.runtimeConfig}->'workspaceBinding'->>'projectId' = ${projectId}`));
  const decisions = await authorizationService(db).decideReads(actor, rows.slice(0, 50).map(row => ({ type: "issue" as const, companyId, issueId: row.issueId, projectId })));
  return { records: rows.slice(0, 50).filter((_row, index) => decisions[index]?.allowed).map(row => ({ ...row, startedAt: row.startedAt?.toISOString() ?? null, finishedAt: row.finishedAt?.toISOString() ?? null })),
    nextOffset: rows.length > 50 ? offset + 50 : null, pms };
}

/** Non-file deliverables supplement the existing native artifact projection. */
export async function projectWorkProductRecords(db: Db, companyId: string, projectId: string, actor: AuthorizationActor, offset = 0): Promise<ProjectWorkProductRecords> {
  const readable = await issueReadSqlCondition(db, actor);
  const products = db.select({ id: sql<string>`${issueWorkProducts.id}`.as("record_id"), issueId: issues.id, identifier: issues.identifier,
    title: issueWorkProducts.title, type: issueWorkProducts.type, source: sql<"work_product" | "review">`'work_product'`.as("source"), status: issueWorkProducts.status,
    reviewState: issueWorkProducts.reviewState, createdByRunId: issueWorkProducts.createdByRunId, updatedAt: issueWorkProducts.updatedAt,
  }).from(issueWorkProducts).innerJoin(issues, and(eq(issues.id, issueWorkProducts.issueId), eq(issues.companyId, issueWorkProducts.companyId)))
    .where(and(eq(issues.companyId, companyId), eq(issues.projectId, projectId), isNull(issues.hiddenAt), readable, ne(issueWorkProducts.type, "artifact")));
  const reviews = db.select({ id: sql<string>`${issueExecutionDecisions.id}`.as("record_id"), issueId: issues.id, identifier: issues.identifier,
    title: issues.title, type: issueExecutionDecisions.stageType, source: sql<"work_product" | "review">`'review'`.as("source"),
    status: issueExecutionDecisions.outcome, reviewState: issueExecutionDecisions.outcome, createdByRunId: issueExecutionDecisions.createdByRunId,
    updatedAt: issueExecutionDecisions.updatedAt,
  }).from(issueExecutionDecisions).innerJoin(issues, and(eq(issues.id, issueExecutionDecisions.issueId), eq(issues.companyId, issueExecutionDecisions.companyId)))
    .where(and(eq(issues.companyId, companyId), eq(issues.projectId, projectId), isNull(issues.hiddenAt), readable));
  const rows = await products.unionAll(reviews).orderBy(sql`updated_at desc`, sql`record_id desc`).offset(offset).limit(51);
  const decisions = await authorizationService(db).decideReads(actor, rows.slice(0, 50).map(row => ({ type: "issue" as const, companyId, issueId: row.issueId, projectId })));
  return { records: rows.slice(0, 50).filter((_row, index) => decisions[index]?.allowed).map(row => ({ ...row, updatedAt: row.updatedAt.toISOString() })), nextOffset: rows.length > 50 ? offset + 50 : null };
}
