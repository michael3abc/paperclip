import { useQuery } from "@tanstack/react-query";
import { costsApi } from "../api/costs";
import { queryKeys } from "../lib/queryKeys";
import { CostAmount } from "./CostAmount";

/** Spend agents self-report for paid external APIs (billing code
 * `external_api`). It belongs to no project, so it is shown apart from
 * Project usage; company and agent totals still include it. */
export function ExternalApiUsageTable({ companyId, from }: { companyId: string; from?: string }) {
  const { data, error } = useQuery({
    queryKey: [...queryKeys.costs(companyId, from, undefined), "external-api"],
    queryFn: () => costsApi.externalApi(companyId, from),
    refetchInterval: 60_000,
    staleTime: 30_000,
  });
  const rows = data?.slice().sort((a, b) => b.costCents - a.costCents);
  const totalCents = rows?.reduce((sum, row) => sum + row.costCents, 0) ?? 0;

  return (
    <section aria-label="External API (self-reported)" className="min-w-0 space-y-2 md:col-span-2">
      <div className="flex items-baseline justify-between gap-2">
        <h4 className="text-xs font-medium">External API (self-reported)</h4>
        {!!rows?.length && <CostAmount costCents={totalCents} />}
      </div>
      <p className="text-(length:--text-nano) text-muted-foreground">
        Paid APIs that agents call directly and report themselves. Not counted in any project&apos;s usage or budget; company and agent totals include it.
      </p>
      {error && <p role="status" className="text-xs text-destructive">
        {data ? "Could not refresh external API spend. Showing the last loaded data." : "Could not load external API spend."}
      </p>}
      {!data && !error ? <p className="text-xs text-muted-foreground">Loading external API spend…</p> : null}
      {rows?.length === 0 ? <p className="text-xs text-muted-foreground">No self-reported external API spend in this period.</p> : null}
      {!!rows?.length && <div className="overflow-x-auto">
        <table aria-label="External API spend by provider, model and agent" className="w-full text-xs">
          <thead>
            <tr className="border-b border-border text-muted-foreground">
              <th scope="col" className="py-2 pr-3 text-left font-medium">Provider</th>
              <th scope="col" className="px-3 py-2 text-left font-medium">Model</th>
              <th scope="col" className="px-3 py-2 text-left font-medium">Agent</th>
              <th scope="col" className="px-3 py-2 text-right font-medium">Reports</th>
              <th scope="col" className="py-2 pl-3 text-right font-medium">Spend</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((row) => <tr key={`${row.provider}\u0000${row.model}\u0000${row.agentId ?? ""}`} className="border-b border-border last:border-0">
              <th scope="row" className="py-2 pr-3 text-left font-medium">{row.provider}</th>
              <td className="px-3 py-2 font-mono">{row.model}</td>
              <td className="px-3 py-2">{row.agentName ?? (row.agentId ? "Unknown agent" : "No agent")}</td>
              <td className="px-3 py-2 text-right font-mono tabular-nums" title={`Last reported ${row.lastOccurredAt}`}>{row.eventCount}</td>
              <td className="py-2 pl-3"><CostAmount costCents={row.costCents} eventCount={row.eventCount}
                estimatedEventCount={row.estimatedEventCount} unpricedEventCount={row.unpricedEventCount} showUnavailableCount /></td>
            </tr>)}
          </tbody>
        </table>
      </div>}
    </section>
  );
}
