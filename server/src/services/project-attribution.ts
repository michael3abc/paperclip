import { EXTERNAL_API_BILLING_CODE, isUuidLike } from "@paperclipai/shared";
import { sql, type SQL, type SQLWrapper } from "drizzle-orm";
import { costEvents, issues, projects, type Db } from "@paperclipai/db";

/**
 * Effective project of spend (read-time attribution; stored rows are never rewritten).
 *
 * 1. Self-reported external API spend (billing code `external_api`) has no project.
 * 2. Otherwise the event's own `project_id`;
 * 3. else (cost reports only) the legacy run-to-issue project link in costs.ts;
 * 4. else, for a Chat conversation issue with no project, the single
 *    non-archived project in the same company that the conversation agent
 *    leads (`projects.lead_agent_id`). Zero or several such projects leave the
 *    spend unattributed.
 *
 * Every helper below applies rule 4 through `chatLeadProjectIdSql`, so reports,
 * budget exposure, budget evaluation and run admission share one definition.
 */

type SqlValue = string | SQLWrapper;
// Wrap each argument as a nested chunk: Drizzle strips table qualifiers from a
// single-table selection's direct column chunks, which would make them ambiguous here.
const nested = (value: SqlValue) => sql`${value}`;

/** Rule 4 for one issue: the project its conversation agent solely leads, else null. */
export function chatLeadProjectIdSql(companyId: SqlValue, issueId: SqlValue): SQL<string | null> {
  return sql<string | null>`(select min(chat_project.id::text)::uuid
    from ${issues} chat_issue
    join ${projects} chat_project on chat_project.company_id = chat_issue.company_id
      and chat_project.lead_agent_id = chat_issue.conversation_agent_id
      and chat_project.archived_at is null
    where chat_issue.id = ${nested(issueId)} and chat_issue.company_id = ${nested(companyId)}
      and chat_issue.project_id is null and chat_issue.conversation_agent_id is not null
    having count(*) = 1)`;
}

/** Chat conversation issues of `companyId` whose rule-4 project is `projectId` (uuid column). */
export function chatIssueIdsForProjectSql(companyId: SqlValue, projectId: SqlValue): SQL {
  return sql`(select attributed_issue.id from ${issues} attributed_issue
    where attributed_issue.company_id = ${nested(companyId)} and attributed_issue.project_id is null
      and attributed_issue.conversation_agent_id = (select lead_project.lead_agent_id from ${projects} lead_project
        where lead_project.id = ${nested(projectId)} and lead_project.company_id = ${nested(companyId)})
      and ${chatLeadProjectIdSql(companyId, sql`attributed_issue.id`)} = ${nested(projectId)})`;
}

/** Whether a cost event is excluded from every project (rule 1). */
export const costEventHasNoProjectSql = sql<boolean>`coalesce(${costEvents.billingCode} = ${EXTERNAL_API_BILLING_CODE}, false)`;

/** Rules 1-4 as a per-row expression over `cost_events`. `linkedProjectId` is
 * the optional rule-3 fallback, already restricted to the rows it applies to. */
export function effectiveCostEventProjectIdSql(linkedProjectId?: SQL): SQL<string | null> {
  return sql<string | null>`case when ${costEventHasNoProjectSql} then null::uuid
    else coalesce(${costEvents.projectId}, ${linkedProjectId ?? sql`null::uuid`},
      ${chatLeadProjectIdSql(costEvents.companyId, costEvents.issueId)}) end`;
}

/** Predicate: a `cost_events` row counts toward `projectId` (rules 1, 2 and 4).
 * Budget exposure has never used the legacy rule-3 run link. */
export function costEventCountsTowardProjectSql(companyId: string, projectId: string): SQL<boolean> {
  return sql<boolean>`(not ${costEventHasNoProjectSql} and (${costEvents.projectId} = ${projectId}
    or (${costEvents.projectId} is null and ${costEvents.issueId} in ${chatIssueIdsForProjectSql(companyId, projectId)})))`;
}

/** Rule 4 in TypeScript, for run admission, ledger scopes and budget evaluation. */
export async function resolveChatLeadProjectId(db: Db, companyId: string, issueId: string | null | undefined) {
  if (!issueId || !isUuidLike(issueId) || !isUuidLike(companyId)) return null;
  const rows = await db.execute<{ project_id: string | null }>(
    sql`select ${chatLeadProjectIdSql(companyId, issueId)} as project_id`);
  return rows[0]?.project_id ?? null;
}

/** Rules 1, 2 and 4 for a newly written cost event. */
export async function resolveCostEventProjectId(db: Db, event: {
  companyId: string; projectId: string | null; issueId: string | null; billingCode: string | null;
}) {
  if (event.billingCode === EXTERNAL_API_BILLING_CODE) return null;
  return event.projectId ?? await resolveChatLeadProjectId(db, event.companyId, event.issueId);
}
