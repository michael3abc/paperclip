import { and, eq, isNull } from "drizzle-orm";
import { approvals, authUsers, companies, companyMemberships, decisions, decisionTargetIssues, heartbeatRuns,
  instanceUserRoles, issueComments, issues, issueThreadInteractions, type Db } from "@paperclipai/db";
import type { PushCategory, PushPayload } from "@paperclipai/shared";
import { requestConfirmationTargetSchema } from "@paperclipai/shared";
import { authorizationService, canActorReadApproval, type AuthorizationActor } from "./authorization.js";
import { taskToastEligible } from "../realtime/task-toast-eligibility.js";
import { evaluateIssueThreadInteractionResolverAudience } from "./issue-thread-interaction-resolution.js";
import { redactSensitiveText } from "../redaction.js";
import type { PushSource } from "./web-push-events.js";
import { assertIssueReviewVerdictActorAllowed, isIssueReviewVerdictInteraction } from "./issue-review-policy.js";
import { HttpError } from "../errors.js";
import { assertRequestConfirmationTargetIsCurrent } from "./issue-thread-interaction-targets.js";

export function pushExcerpt(text: string, length = 160) {
  const plain = redactSensitiveText(text).replace(/<[^>]*>/g, " ").replace(/!?(?:\[([^\]]*)\])\([^)]*\)/g, "$1")
    .replace(/https?:\/\/\S+/g, "[link]").replace(/[`*_#>|~]/g, "").replace(/\s+/g, " ").trim();
  return Array.from(plain).slice(0, length).join("");
}
const labels: Record<PushCategory, string> = { approval: "需要批准", question: "需要回答", completed: "任務完成",
  problem: "需要處理", chat: "新訊息", progress: "任務更新", subtask: "子任務更新" };

export async function pushActor(db: Db, userId: string, companyId: string): Promise<AuthorizationActor | null> {
  if (!await db.query.authUsers.findFirst({ where: eq(authUsers.id, userId), columns: { id: true } })) return null;
  const memberships = await db.select().from(companyMemberships).where(and(eq(companyMemberships.principalId, userId),
    eq(companyMemberships.principalType, "user"), eq(companyMemberships.status, "active"), eq(companyMemberships.companyId, companyId)));
  const admin = await db.query.instanceUserRoles.findFirst({ where: and(eq(instanceUserRoles.userId, userId), eq(instanceUserRoles.role, "instance_admin")) });
  if (!memberships.length && !admin) return null;
  return { type: "board", source: "session", userId, memberships, isInstanceAdmin: !!admin, companyIds: memberships.map(m => m.companyId) };
}

export async function resolvePushAudience(db: Db, source: PushSource, userId: string): Promise<{
  category: PushCategory; payload: Omit<PushPayload, "tag">;
} | null> {
  if (source.actorUserId === userId) return null;
  const actor = await pushActor(db, userId, source.companyId);
  if (!actor) return null;
  const company = await db.query.companies.findFirst({ where: eq(companies.id, source.companyId) });
  if (!company || company.status === "archived") return null;
  const access = authorizationService(db);
  const canRead = async (id: string) => (await access.decide({ actor, action: "issue:read",
    resource: { type: "issue", companyId: source.companyId, issueId: id } })).allowed;
  let issueId = source.issueId;
  let title = "Paperclip";
  let body = "";
  let relevant = false;
  let destination: string | null = null;
  if (source.sourceKind === "decision") {
    const row = await db.query.decisions.findFirst({ where: and(eq(decisions.id, source.sourceId), eq(decisions.companyId, source.companyId)) });
    if (!row || row.status !== "open" || row.expiresAt.getTime() <= Date.now()) return null;
    const targets = await db.select().from(decisionTargetIssues).where(eq(decisionTargetIssues.decisionId, row.id));
    for (const target of targets) if (!await canRead(target.issueId)) return null;
    issueId = row.originIssueId; title = row.title; body = row.body;
    relevant = true; destination = `/${company.issuePrefix}/decisions?decisionId=${row.id}`;
  } else if (source.sourceKind === "approval") {
    const row = await db.query.approvals.findFirst({ where: and(eq(approvals.id, source.sourceId), eq(approvals.companyId, source.companyId)) });
    if (!row || row.status !== "pending" || row.requestedByUserId === userId || !await canActorReadApproval(db, actor, row.id)) return null;
    relevant = true; title = "待批准申請";
    body = typeof row.payload.title === "string" ? row.payload.title : row.type;
    destination = `/${company.issuePrefix}/approvals/${row.id}`;
  } else if (source.sourceKind === "interaction") {
    const row = await db.query.issueThreadInteractions.findFirst({ where: and(eq(issueThreadInteractions.id, source.sourceId),
      eq(issueThreadInteractions.companyId, source.companyId)) });
    if (!row || row.status !== "pending" || row.dismissedAt || row.createdByUserId === userId) return null;
    const issue = await db.query.issues.findFirst({ where: and(eq(issues.id, row.issueId), eq(issues.companyId, source.companyId)) });
    if (!issue || ["done", "cancelled"].includes(issue.status) || issue.conversationUserId && issue.conversationUserId !== userId) return null;
    const payload = row.payload as { target?: unknown; items?: { target?: unknown }[] };
    const targets = [payload.target, ...(Array.isArray(payload.items) ? payload.items.map(item => item.target) : [])];
    for (const candidate of targets) {
      if (candidate == null) continue;
      const parsed = requestConfirmationTargetSchema.safeParse(candidate);
      if (!parsed.success) return null;
      const target = parsed.data;
      if ("issueId" in target && target.issueId && !await canRead(target.issueId)) return null;
      try { await assertRequestConfirmationTargetIsCurrent(db, { companyId: issue.companyId, issueId: issue.id, target }); }
      catch (error) { if (error instanceof HttpError && error.status === 422) return null; throw error; }
    }
    if (!(await access.decide({ actor, action: "issue:mutate", resource: { type: "issue", companyId: source.companyId, issueId: issue.id, status: issue.status, assigneeAgentId: issue.assigneeAgentId, assigneeUserId: issue.assigneeUserId } })).allowed) return null;
    if (issue.status === "in_review" && ["request_confirmation", "request_checkbox_confirmation"].includes(row.kind)
      && await isIssueReviewVerdictInteraction(db, { issue, interaction: row })) {
      try { await assertIssueReviewVerdictActorAllowed(db, { issue, actor: { type: "user", id: userId } }); }
      catch (error) { if (error instanceof HttpError && error.status === 403) return null; throw error; }
    }
    if (!evaluateIssueThreadInteractionResolverAudience({ actor: { type: "user", userId }, interaction: row }).allowed) return null;
    issueId = row.issueId; title = row.title ?? labels[source.category]; body = row.summary ?? title;
    relevant = row.addresseeUserId === userId || !row.addresseeAgentId;
  } else if (source.sourceKind === "comment") {
    const row = await db.query.issueComments.findFirst({ where: and(eq(issueComments.id, source.sourceId),
      eq(issueComments.companyId, source.companyId), isNull(issueComments.deletedAt)) });
    if (!row || row.authorUserId === userId || row.authorType === "system" || row.metadata?.recoveryResponsibility === "system") return null;
    issueId = row.issueId; body = row.body;
  } else if (source.sourceKind === "run") {
    const row = await db.query.heartbeatRuns.findFirst({ where: and(eq(heartbeatRuns.id, source.sourceId), eq(heartbeatRuns.companyId, source.companyId)) });
    if (!row || !["failed", "timed_out"].includes(row.status)) return null;
    issueId = row.issueId ?? row.nativeIssueId; body = row.error ?? "執行失敗，請開啟任務查看。";
  }
  let category = source.category;
  if (issueId) {
    if (!await canRead(issueId)) return null;
    const issue = await db.query.issues.findFirst({ where: and(eq(issues.id, issueId), eq(issues.companyId, source.companyId)) });
    if (!issue) return null;
    if (source.sourceKind === "issue") {
      if (category === "completed" && issue.status !== "done" || category === "problem" && issue.status !== "blocked") return null;
      body = `${issue.identifier ?? ""} · ${issue.status}`;
    }
    if (title === "Paperclip") title = issue.title;
    if (source.sourceKind === "comment" && issue.conversationUserId) {
      if (issue.conversationUserId !== userId) return null;
      category = "chat"; relevant = true;
      destination = `/${company.issuePrefix}/chats/${issue.conversationAgentId}`;
    }
    const involved = (id: string) => taskToastEligible(db, { id: 0, companyId: source.companyId,
      type: "activity.logged", createdAt: new Date().toISOString(),
      payload: { entityType: "issue", entityId: id, action: "issue.updated" } }, userId);
    relevant ||= await involved(issueId);
    if (!relevant) {
      let parentId = issue.parentId;
      const seen = new Set([issueId]);
      while (parentId && seen.size < 100 && !seen.has(parentId)) {
        seen.add(parentId);
        if (!await canRead(parentId)) break;
        if (await involved(parentId)) { relevant = true; category = "subtask"; break; }
        const parent = await db.query.issues.findFirst({ where: and(eq(issues.id, parentId), eq(issues.companyId, source.companyId)), columns: { parentId: true } });
        parentId = parent?.parentId ?? null;
      }
    }
    destination ??= `/${company.issuePrefix}/issues/${issue.identifier ?? issue.id}`;
  }
  if (!relevant || !destination) return null;
  return { category, payload: { title: `${labels[category]}：${pushExcerpt(title, 80)}`, body: pushExcerpt(body), url: destination } };
}
