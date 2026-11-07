import { getDelegatedRequest } from "../services/delegated-requests.js";
import { and, eq, sql } from "drizzle-orm";
import { heartbeatRuns, runnerApiResponseReservations, issueAttachments, issues } from "@paperclipai/db";
import type { RequestHandler } from "express";
import type { Db } from "@paperclipai/db";
import { forbidden } from "../errors.js";
import { currentPmCoordinationScope, assertPmIssue, assertPmDispatch, assertPmRun, assertPmApproval, pmDispatchExecutionPolicy, PM_BUNDLE_FILES, PM_EDITABLE_BUNDLE_FILES, type PmCoordinationScope } from "../services/pm-coordination-policy.js";
import { requirePmBundleReads } from "../services/pm-bundle-tools.js";
import { getNativeReviewAssignment, readNativeReviewAssignmentContext } from "../services/native-runtime/native-review-participant.js";
import { readNativeExecutionReviewAssignment } from "../services/native-runtime/native-execution-review.js";
import { boundRunIssueIdSql } from "../services/run-task-binding.js";

// Explicit read routes: a new GET route is not automatically execution-free.
const ISSUE_READ_PATH = /^(?:|\/(?:recent-comments|comments(?:\/[^/]+)?|documents(?:\/[^/]+(?:\/(?:revisions(?:\/[^/]+)?|annotations(?:\/[^/]+)?))?)?|approvals|interactions|work-products|attachments|workspace|runner-goal|heartbeat-context|diagnostics\/(?:blockers|wakes|subtree)|watchdog|recovery-actions|external-objects|external-object-summary|accepted-plan-decompositions|privacy-constraints|access-grants|queued-comments|chat-handoffs|pending-questions|decision-receipts|feedback-votes|feedback-traces|tree-control\/state|tree-holds(?:\/[^/]+)?|cases|activity|runs|live-runs|execution|active-run|cost-summary))$/;

/** Closed API surface shared by generic API calls and direct authenticated HTTP. */
export async function assertPmApiRequest(db: Db, pm: PmCoordinationScope, request: {
  method: string; path: string; query: Record<string, unknown>; body: Record<string, unknown>; runId?: string;
}) {
  const { method, query, body } = request;
  const path = request.path.replace(/\/$/, "");
  const deny = () => { throw forbidden("This API operation is outside the PM coordination role; use a worker for execution", { code: "PM_API_DENIED" }); };
  if (!request.runId) deny();
  const { run, issue: source } = await assertPmRun(db, pm, request.runId!);
  const read = method === "GET";
  if (!read && readNativeExecutionReviewAssignment(run.contextSnapshot)) deny();
  if (!read && readNativeReviewAssignmentContext(run.contextSnapshot) && !/^\/issues\/[^/]+\/interactions\/[^/]+\/(accept|reject)$/.test(path)) deny();
  let operation = "api_update";
  let allowed = false;
  let match: RegExpMatchArray | null;
  if ((match = path.match(/^\/agents\/([^/]+)(?:\/(instructions-bundle)(?:\/(file))?)?$/))) {
    const own = match[1] === pm.agentId;
    if (!match[2]) allowed = read && (own || Boolean(pm.delegation?.workers.some(worker => worker.agentId === match![1])));
    else if (own && !match[3]) allowed = read;
    else if (own && match[3]) {
      const file = read ? query.path : body.path;
      allowed = typeof file === "string" && (read ? PM_BUNDLE_FILES.includes(file as typeof PM_BUNDLE_FILES[number])
        : method === "PUT" && PM_EDITABLE_BUNDLE_FILES.has(file) && typeof body.changeReason === "string"
          && !!body.changeReason.trim() && body.clearLegacyPromptTemplate !== true);
    }
  } else if ((match = path.match(/^\/assets\/([^/]+)\/content$/))) {
    // Project attachments and captured responses retain the underlying asset,
    // issue privacy and responsible-user checks, regardless of producing worker.
    if (read && /^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/i.test(match[1]!)) {
      const [capture] = await db.select({ id: runnerApiResponseReservations.id })
        .from(runnerApiResponseReservations).innerJoin(heartbeatRuns, eq(heartbeatRuns.id, runnerApiResponseReservations.runId))
        .innerJoin(issues, sql`${issues.id}::text = ${boundRunIssueIdSql()}`)
        .where(and(eq(runnerApiResponseReservations.assetId, match[1]!), eq(runnerApiResponseReservations.companyId, pm.companyId),
          eq(heartbeatRuns.companyId, pm.companyId), eq(issues.companyId, pm.companyId), eq(issues.projectId, pm.projectId))).limit(1);
      const [attachment] = await db.select({ id: issueAttachments.id }).from(issueAttachments)
        .innerJoin(issues, eq(issues.id, issueAttachments.issueId)).where(and(eq(issueAttachments.assetId, match[1]!),
          eq(issueAttachments.companyId, pm.companyId), eq(issues.companyId, pm.companyId), eq(issues.projectId, pm.projectId))).limit(1);
      allowed = Boolean(capture || attachment);
    }
  } else if ((match = path.match(/^\/heartbeat-runs\/([^/]+)(?:\/(events|log|workspace-operations))?$/))) {
    if (read) {
      const [target] = await db.select({ issueId: boundRunIssueIdSql() }).from(heartbeatRuns)
        .where(and(eq(heartbeatRuns.id, match[1]!), eq(heartbeatRuns.companyId, pm.companyId))).limit(1);
      if (target?.issueId) { await assertPmIssue(db, pm, target.issueId); allowed = true; }
    }
  } else if ((match = path.match(/^\/projects\/([^/]+)(?:\/(workspaces|repositories|sessions|work-products|external-object-summary|access-members))?$/))) {
    allowed = read && match[1] === pm.projectId;
  } else if ((match = path.match(/^\/companies\/([^/]+)\/adapters\/(claude_local|codex_local)\/models$/))) {
    allowed = read && match[1] === pm.companyId;
  } else if ((match = path.match(/^\/companies\/([^/]+)\/execution-workspaces$/))) {
    allowed = read && match[1] === pm.companyId && query.projectId === pm.projectId;
  } else if ((match = path.match(/^\/companies\/([^/]+)\/approvals$/))) {
    if (method === "POST" && match[1] === pm.companyId && Array.isArray(body.issueIds) && body.issueIds.length > 0
      && Object.keys(body).every(key => ["type", "payload", "issueIds"].includes(key))) {
      for (const id of body.issueIds) await assertPmIssue(db, pm, String(id));
      allowed = true;
    }
  } else if ((match = path.match(/^\/approvals\/([^/]+)(?:\/(issues|comments|approve|reject))?$/))) {
    await assertPmApproval(db, pm, match[1]!);
    if (read && !["approve", "reject"].includes(match[2] ?? "")) allowed = true;
    if (method === "POST" && ["approve", "reject"].includes(match[2] ?? "")
      && typeof body.delegationRevision === "string" && typeof body.decisionNote === "string" && body.decisionNote.trim()
      && Object.keys(body).every(key => ["delegationRevision", "decisionNote"].includes(key))) {
      const delegated = await getDelegatedRequest(db, { ...pm, runId: run.id }, "approval", match[1]!);
      allowed = delegated.revision === body.delegationRevision;
      operation = "resolve_delegated_request";
    }
  } else if ((match = path.match(/^\/companies\/([^/]+)\/issues$/))) {
    if (match[1] !== pm.companyId) deny();
    if (read) allowed = query.projectId === pm.projectId;
    else if (method === "POST") {
      const fields = ["projectId", "parentId", "title", "description", "initialPlan", "status", "priority", "assigneeAgentId", "assigneeAdapterOverrides",
        "blockedByIssueIds", "executionPolicy", "executionWorkspacePreference", "executionWorkspaceSettings", "workspaceSelection", "idempotencyKey"];
      if (Object.keys(body).some(key => !fields.includes(key)) || ![undefined, "todo", "backlog"].includes(body.status as string | undefined)
        || typeof body.initialPlan !== "string" || !body.initialPlan.trim()) deny();
      if ((source.conversationAgentId && body.parentId != null) || (!source.conversationAgentId && body.parentId !== source.id)) deny();
      await assertPmDispatch(db, pm, body);
      if (body.parentId) await assertPmIssue(db, pm, String(body.parentId));
      body.executionPolicy = pmDispatchExecutionPolicy(pm, body.executionPolicy, source.executionPolicy);
      allowed = true; operation = "dispatch";
    }
  } else if ((match = path.match(/^\/issues\/([^/]+)(.*)$/))) {
    const issue = await assertPmIssue(db, pm, match[1]!);
    const tail = match[2];
    allowed = read && ISSUE_READ_PATH.test(tail!);
    if (method === "POST" && tail === "/comments") allowed = Object.keys(body).every(key => ["body", "clientRequestId"].includes(key));
    if (method === "PUT" && /^\/documents\/[^/]+$/.test(tail!)) allowed = true;
    if (method === "POST" && tail === "/interactions") allowed = true;
    if (method === "POST" && /^\/interactions\/[^/]+\/(accept|reject|respond|verdicts)$/.test(tail!) && typeof body.delegationRevision === "string") {
      const requestId = tail!.split("/")[2]!;
      const delegated = await getDelegatedRequest(db, { ...pm, runId: run.id }, "interaction", requestId);
      allowed = delegated.issueId === issue.id && delegated.revision === body.delegationRevision;
      operation = "resolve_delegated_request";
    } else if (method === "POST" && /^\/interactions\/[^/]+\/(accept|reject)$/.test(tail!)) {
      const assignmentContext = readNativeReviewAssignmentContext(run.contextSnapshot);
      const assignment = assignmentContext && await getNativeReviewAssignment(db, { ...pm, issueId: issue.id, actingRunId: run.id, contextSnapshot: assignmentContext });
      allowed = Boolean(assignment && (tail === `/interactions/${assignment.interaction.id}/accept` || tail === `/interactions/${assignment.interaction.id}/reject`)
        && typeof body.reason === "string" && body.reason.trim() && Object.keys(body).every(key => key === "reason"));
      operation = "review";
    }
    if (method === "PUT" && tail === "/title") allowed = true;
    if (method === "PATCH" && tail === "") {
      allowed = Object.keys(body).every(key => ["title", "description", "priority", "blockedByIssueIds", "status"].includes(key));
      if (body.status !== undefined && !(body.status === "blocked" && issue.assigneeAgentId === pm.agentId && !issue.conversationAgentId)) allowed = false;
    }
  }
  if (!allowed) deny();
  for (const id of Array.isArray(body.blockedByIssueIds) ? body.blockedByIssueIds : []) await assertPmIssue(db, pm, String(id));
  if (!read) {
    if (!request.runId) deny();
    await requirePmBundleReads(db, pm, request.runId!, operation);
  }
}

export function pmCoordinationMiddleware(db: Db): RequestHandler {
  return async (req, _res, next) => {
    try {
      if (req.actor.type === "agent" && req.actor.agentId && req.actor.companyId) {
        const pm = await currentPmCoordinationScope(db, { agentId: req.actor.agentId, companyId: req.actor.companyId });
        if (pm) await assertPmApiRequest(db, pm, { method: req.method, path: req.path,
          query: req.query, body: req.body ?? {}, runId: req.actor.runId });
      }
      next();
    } catch (error) { next(error); }
  };
}
