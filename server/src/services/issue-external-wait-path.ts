import { Column, getTableName, is, sql, type SQLWrapper } from "drizzle-orm";
import { issues, type Db } from "@paperclipai/db";

/** Correlated, company-scoped existence probe. Old owners cannot keep a task waiting. */
export function externalWaitPathSql(issue: {
  id: SQLWrapper | string; companyId: SQLWrapper | string;
  status: SQLWrapper | string; assigneeAgentId: SQLWrapper | string | null;
}) {
  // Explicit identifiers preserve correlation when Drizzle de-qualifies a
  // single-table SELECT's column objects inside a nested EXISTS expression.
  const outer = (value: SQLWrapper | string | null) => is(value, Column)
    ? sql`${sql.identifier(getTableName(value.table))}.${sql.identifier(value.name)}` : value;
  return sql<boolean>`(${outer(issue.status)} not in ('done', 'cancelled') and exists (
    select 1 from issue_external_waits ew
    where ew.company_id = ${outer(issue.companyId)} and ew.issue_id = ${outer(issue.id)}
      and ew.status = 'waiting'
      and (ew.agent_id is null or ew.agent_id = ${outer(issue.assigneeAgentId)})
  ))`;
}

export async function hasIssueExternalWait(db: Db, companyId: string, issueId: string) {
  const [row] = await db.select({ waiting: externalWaitPathSql(issues) }).from(issues)
    .where(sql`${issues.companyId} = ${companyId} and ${issues.id} = ${issueId}`).limit(1);
  return row?.waiting === true;
}
