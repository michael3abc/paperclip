import { sql } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import type { ConversationTaskHandoff } from "@paperclipai/shared";

type Identity = NonNullable<ConversationTaskHandoff["runtimeIdentity"]>;
const text = (value: unknown) => typeof value === "string" && value.trim() ? value.trim() : null;

/** One bounded projection for an already-authorized handoff page (at most 100).
 * Indexed task/run/event/usage lookups; no transcripts, provider I/O, credentials
 * or per-card HTTP reads. Missing historical evidence stays unknown. */
export async function conversationTaskRuntime(db: Db, companyId: string, issueIds: string[]) {
  const identities = new Map<string, Identity>();
  if (!issueIds.length) return identities;
  const rows = await db.execute(sql`select i.id, r.id as run_id, r.status as run_status, r.driver_kind,
      r.runner_profile_json->'adapterDispatch'->>'adapterType' as run_adapter,
      e.payload->>'adapterType' as invoked_adapter,
      e.payload->'context'->>'provider' as invoked_provider,
      e.payload->'context'->>'model' as invoked_model,
      e.payload->'context'->>'billingRoute' as invoked_route,
      left(e.payload->'context'->'route'->>'description', 500) as invoked_route_description,
      e.id as invocation_id, c.model as used_model, c.biller as used_route,
      a.adapter_type as configured_adapter,
      coalesce(i.assignee_adapter_overrides->'adapterConfig'->>'model', a.adapter_config->>'model') as configured_model,
      coalesce(i.assignee_adapter_overrides->'adapterConfig'->>'provider', a.adapter_config->>'provider') as configured_provider
    from issues i
    left join agents a on a.id = i.assignee_agent_id and a.company_id = i.company_id
    left join lateral (select id, status, driver_kind, runner_profile_json from heartbeat_runs
      where company_id = i.company_id and issue_id = i.id order by created_at desc, id desc limit 1) r on true
    left join lateral (select id, payload from heartbeat_run_events
      where company_id = i.company_id and run_id = r.id and event_type = 'adapter.invoke'
      order by seq desc limit 1) e on true
    left join lateral (select
        case when count(distinct (model, biller)) = 1 then min(model) end as model,
        case when count(distinct (model, biller)) = 1 then min(biller) end as biller
      from cost_events
      where company_id = i.company_id and heartbeat_run_id = r.id and usage_kind = 'agent'
        and (e.payload->'context'->>'model' is null or model = e.payload->'context'->>'model')) c on true
    where i.company_id = ${companyId}::uuid and i.id in (${sql.join(issueIds.map(id => sql`${id}::uuid`), sql`, `)})`);
  for (const row of rows) {
    const observed = row.invocation_id != null || row.used_model != null;
    const configured = !observed && (!row.run_id || ["queued", "scheduled_retry"].includes(String(row.run_status)));
    const adapter = text(observed ? row.invoked_adapter ?? row.run_adapter : configured ? row.configured_adapter : row.run_adapter);
    let harness = adapter === "ccpocket_bridge" ? text(observed ? row.invoked_provider : configured ? row.configured_provider : null)
      : text(row.driver_kind) ?? adapter?.replace(/_local$/, "") ?? null;
    let model = text(observed ? row.used_model ?? row.invoked_model : configured ? row.configured_model : null);
    // Bridge's configured selector explicitly contains host/harness/model. It
    // does not attest billing or provider acceptance; never infer the source.
    if (configured && adapter === "ccpocket_bridge" && model) {
      const selector = new RegExp("^[^/]+/(claude|codex|antigravity)/(.+)$").exec(model);
      if (selector) { harness = selector[1]; model = selector[2]; }
    }
    identities.set(String(row.id), { basis: observed ? "run" : configured ? "configured" : "unknown",
      runId: text(row.run_id), harness, model,
      billingRoute: observed ? text(row.used_route ?? row.invoked_route) : null,
      routeDescription: observed ? text(row.invoked_route_description) : null });
  }
  return identities;
}
