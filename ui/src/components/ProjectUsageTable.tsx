import { useQuery } from "@tanstack/react-query";
import { costsApi } from "../api/costs";
import { queryKeys } from "../lib/queryKeys";
import { formatTokens } from "../lib/utils";
import { CostAmount } from "./CostAmount";

export function ProjectUsageTable({ companyId, from }: { companyId: string; from?: string }) {
  const { data, error } = useQuery({
    queryKey: [...queryKeys.costs(companyId, from, undefined), "by-project"],
    queryFn: () => costsApi.byProject(companyId, from),
    refetchInterval: 60_000,
    staleTime: 30_000,
  });
  const totalTokens = (row: { inputTokens: number; cachedInputTokens: number; outputTokens: number }) =>
    row.inputTokens + row.cachedInputTokens + row.outputTokens;
  const rows = data?.slice().sort((a, b) => totalTokens(b) - totalTokens(a));

  return (
    <section aria-label="Project usage" className="min-w-0 space-y-2 md:col-span-2">
      <h4 className="text-xs font-medium">Project usage</h4>
      <p className="text-(length:--text-nano) text-muted-foreground">
        API and subscription tokens. Recorded spend excludes subscription API estimates and monthly fees; missing prices are not estimated here.
      </p>
      {error && <p role="status" className="text-xs text-destructive">
        {data ? "Could not refresh project usage. Showing the last loaded data." : "Could not load project usage."}
      </p>}
      {!data && !error ? <p className="text-xs text-muted-foreground">Loading project usage…</p> : null}
      {rows?.length === 0 ? <p className="text-xs text-muted-foreground">No project usage in this period.</p> : null}
      {!!rows?.length && <div className="overflow-x-auto">
        <table aria-label="Usage by project" className="w-full text-xs">
          <thead>
            <tr className="border-b border-border text-muted-foreground">
              <th scope="col" className="py-2 pr-3 text-left font-medium">Project</th>
              <th scope="col" className="px-3 py-2 text-right font-medium">Input (uncached)</th>
              <th scope="col" className="px-3 py-2 text-right font-medium">Cached input</th>
              <th scope="col" className="px-3 py-2 text-right font-medium">Output</th>
              <th scope="col" className="px-3 py-2 text-right font-medium">Total tokens</th>
              <th scope="col" className="py-2 pl-3 text-right font-medium">Recorded spend</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((row) => <tr key={row.projectId ?? "unattributed"} className="border-b border-border last:border-0">
              <th scope="row" className="py-2 pr-3 text-left font-medium">
                {row.projectName ?? (row.projectId ? "Unnamed project" : "Unattributed")}
              </th>
              {[row.inputTokens, row.cachedInputTokens, row.outputTokens, totalTokens(row)].map((value, index) =>
                <td key={index} className="px-3 py-2 text-right font-mono tabular-nums" title={`${value.toLocaleString()} tokens`}>
                  {formatTokens(value)}
                </td>,
              )}
              <td className="py-2 pl-3"><CostAmount costCents={row.costCents} eventCount={row.eventCount} estimatedEventCount={row.estimatedEventCount} /></td>
            </tr>)}
          </tbody>
        </table>
      </div>}
    </section>
  );
}
