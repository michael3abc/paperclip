import { and, asc, eq, inArray, ne, or, sql } from "drizzle-orm";
import { agents, issueComments, issues, projects, type Db } from "@paperclipai/db";
import type { CreatePmIntake, PmWorkspaceListing } from "@paperclipai/shared";
import { HttpError } from "../errors.js";
import { resolveDefaultAgentWorkspaceDir } from "../home-paths.js";
import { projectPmConflict, readProjectPmBinding, type ProjectPmWorkspaceBinding } from "./agent-workspace-binding.js";

/** Owner intake (contract §1 "Owner intake"): one comment per receipt on the PM inbox issue. */
export const PM_INTAKE_WAKE_REASON = "pm_intake";
export const PM_INTAKE_MARKER_PREFIX = "ccpocket-intake dedupe=";
const MAX_REPORTS_TO_DEPTH = 50;

/** The marker the dedupe search looks for. The trailing space stops `abc` matching `abcd`. */
export function pmIntakeMarker(dedupeId: string) {
  return `${PM_INTAKE_MARKER_PREFIX}${dedupeId} `;
}

/**
 * Server-only request id stored with the intake comment. It is not a UUID, so the
 * public comment route (UUID client request ids) can never produce it, and it
 * survives body redaction that could alter the marker text.
 */
export function pmIntakeClientRequestId(dedupeId: string) {
  return `ccpocket-intake:${dedupeId}`;
}

export function pmIntakeWakeIdempotencyKey(pmAgentId: string, dedupeId: string) {
  return `pm-intake:${pmAgentId}:${dedupeId}`;
}

export function buildPmIntakeCommentBody(input: CreatePmIntake) {
  return `${input.text}\n\n<!-- ${pmIntakeMarker(input.dedupeId)}source=${input.source} ref=${input.sourceRef ?? "-"} -->`;
}

export function pmInboxMissing(message: string): never {
  throw new HttpError(409, message, { code: "pm_inbox_missing" });
}

export type PmInbox = {
  id: string;
  companyId: string;
  projectId: string | null;
  identifier: string | null;
  title: string;
  status: string;
  executionPolicy: unknown;
};

/**
 * Resolve the binding's inbox issue. A missing binding inbox or a deleted issue is
 * 409 `pm_inbox_missing`; an inbox that no longer satisfies the binding rules
 * (top-level, PM project, assigned to the PM) is the binding's 422.
 */
export async function resolvePmInbox(
  db: Db,
  pm: { id: string; companyId: string; runtimeConfig: Record<string, unknown> | null | undefined },
): Promise<{ binding: ProjectPmWorkspaceBinding; inbox: PmInbox }> {
  const binding = readProjectPmBinding(pm.runtimeConfig);
  if (!binding) pmInboxMissing("The agent has no project_pm binding, so it has no PM inbox.");
  if (!binding.inboxIssueId) pmInboxMissing("The PM binding has no inboxIssueId.");
  const [inbox] = await db.select({
    id: issues.id,
    companyId: issues.companyId,
    projectId: issues.projectId,
    parentId: issues.parentId,
    assigneeAgentId: issues.assigneeAgentId,
    identifier: issues.identifier,
    title: issues.title,
    status: issues.status,
    executionPolicy: issues.executionPolicy,
  }).from(issues).where(and(eq(issues.id, binding.inboxIssueId), eq(issues.companyId, pm.companyId))).limit(1);
  if (!inbox) pmInboxMissing("The PM inbox issue does not exist in the PM's company.");
  if (inbox.projectId !== binding.projectId || inbox.parentId !== null || inbox.assigneeAgentId !== pm.id) {
    projectPmConflict("inbox_invalid", "The PM inbox must be a top-level issue of the PM project, in the same company, assigned to this agent.");
  }
  const { parentId: _parentId, assigneeAgentId: _assigneeAgentId, ...rest } = inbox;
  return { binding, inbox: rest };
}

type CommentReader = Pick<Db, "select">;

/** The first inbox comment carrying this receipt, by marker or by the server request id. Deleted comments still count. */
export async function findPmIntakeComment(
  dbOrTx: CommentReader,
  input: { companyId: string; inboxIssueId: string; dedupeId: string },
) {
  const [row] = await dbOrTx.select({
    id: issueComments.id,
    issueId: issueComments.issueId,
    createdAt: issueComments.createdAt,
  }).from(issueComments).where(and(
    eq(issueComments.companyId, input.companyId),
    eq(issueComments.issueId, input.inboxIssueId),
    or(
      eq(issueComments.clientRequestId, pmIntakeClientRequestId(input.dedupeId)),
      sql`strpos(${issueComments.body}, ${pmIntakeMarker(input.dedupeId)}) > 0`,
    ),
  )).orderBy(asc(issueComments.createdAt), asc(issueComments.id)).limit(1);
  return row ?? null;
}

/** Serialize intake on one inbox for the rest of the transaction. */
export async function lockPmInbox(tx: Pick<Db, "execute">, inboxIssueId: string) {
  await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${`pm-intake:${inboxIssueId}`}, 0))`);
}

/** True when `candidateAgentId` is a strict manager of the PM, walking `reportsTo` inside one company. */
export async function isInPmReportsToChain(
  db: Db,
  input: { companyId: string; pmAgentId: string; candidateAgentId: string },
) {
  const seen = new Set<string>([input.pmAgentId]);
  let current = input.pmAgentId;
  for (let depth = 0; depth < MAX_REPORTS_TO_DEPTH; depth += 1) {
    const [row] = await db.select({ reportsTo: agents.reportsTo }).from(agents)
      .where(and(eq(agents.id, current), eq(agents.companyId, input.companyId))).limit(1);
    const next = row?.reportsTo ?? null;
    if (!next || seen.has(next)) return false;
    if (next === input.candidateAgentId) return true;
    seen.add(next);
    current = next;
  }
  return false;
}

/** Non-terminated agents of the company with a valid `project_pm` binding. Paths only; no adapter config or secrets. */
export async function listPmWorkspaces(db: Db, companyId: string): Promise<PmWorkspaceListing[]> {
  const rows = await db.select({
    id: agents.id,
    name: agents.name,
    status: agents.status,
    runtimeConfig: agents.runtimeConfig,
  }).from(agents).where(and(
    eq(agents.companyId, companyId),
    ne(agents.status, "terminated"),
    sql`${agents.runtimeConfig}->'workspaceBinding'->>'mode' = 'project_pm'`,
  )).orderBy(asc(agents.name), asc(agents.id));
  const bound = rows.flatMap((row) => {
    const binding = readProjectPmBinding(row.runtimeConfig);
    return binding ? [{ row, binding }] : [];
  });
  const projectIds = [...new Set(bound.map(({ binding }) => binding.projectId))];
  const projectNames = new Map(
    (projectIds.length > 0
      ? await db.select({ id: projects.id, name: projects.name }).from(projects)
        .where(and(eq(projects.companyId, companyId), inArray(projects.id, projectIds)))
      : []).map((project) => [project.id, project.name] as const),
  );
  return bound.map(({ row, binding }) => ({
    agentId: row.id,
    agentName: row.name,
    status: row.status,
    projectId: binding.projectId,
    projectName: projectNames.get(binding.projectId) ?? null,
    agentHome: binding.agentHome ?? resolveDefaultAgentWorkspaceDir(row.id),
    workerRoot: binding.workerRoot,
    ...(binding.workerHostId ? { workerHostId: binding.workerHostId } : {}),
    workerIsolation: binding.workerIsolation,
    workerSlots: binding.workerSlots,
    inboxIssueId: binding.inboxIssueId ?? null,
  }));
}
