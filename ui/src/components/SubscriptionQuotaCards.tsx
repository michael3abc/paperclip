import { useQuery, useQueryClient } from "@tanstack/react-query";
import { RefreshCw } from "lucide-react";
import type { ProviderQuotaResult } from "@paperclipai/shared";
import { dashboardApi } from "@/api/dashboard";
import { accessApi } from "@/api/access";
import { queryKeys } from "@/lib/queryKeys";
import { formatDateTime } from "@/lib/utils";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { QuotaBar } from "./QuotaBar";
import { HostClaudeLogin } from "./HostClaudeLogin";
import { HostCodexLogin } from "./HostCodexLogin";

const PROVIDERS = [
  { id: "openai", title: "Codex" },
  { id: "anthropic", title: "Claude" },
  { id: "antigravity", title: "Antigravity" },
];

export function quotaResetLabel(reset: string | null, now: number): string {
  if (!reset) return "Reset time not reported";
  const remaining = Date.parse(reset) - now;
  if (!Number.isFinite(remaining)) return "Reset time not reported";
  if (remaining <= 0) return "Reset due; refresh to check";
  const minutes = Math.ceil(remaining / 60_000);
  if (minutes < 60) return "Resets in " + minutes + "m";
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return "Resets in " + hours + "h " + (minutes % 60) + "m";
  return "Resets in " + Math.floor(hours / 24) + "d " + (hours % 24) + "h";
}

const WINDOW_UNIT_MINUTES: Record<string, number> = { m: 1, h: 60, d: 1440, w: 10080 };

function windowMinutes(label: string): number {
  const match = /·\s*(\d+)\s*([mhdw])\s*$/i.exec(label);
  return match ? Number(match[1]) * WINDOW_UNIT_MINUTES[match[2]!.toLowerCase()]! : Number.POSITIVE_INFINITY;
}

function windowGroup(label: string): string {
  const at = label.lastIndexOf("·");
  return at < 0 ? label : label.slice(0, at).trim();
}

/** Groups keep their reported order; inside a group the shortest window comes first (5h above 7d). */
export function orderQuotaWindows<T extends { label: string }>(windows: readonly T[]): T[] {
  const groups = new Map<string, number>();
  windows.forEach((window) => { if (!groups.has(windowGroup(window.label))) groups.set(windowGroup(window.label), groups.size); });
  return windows
    .map((window, index) => ({ window, index }))
    .sort((a, b) => groups.get(windowGroup(a.window.label))! - groups.get(windowGroup(b.window.label))!
      || windowMinutes(a.window.label) - windowMinutes(b.window.label) || a.index - b.index)
    .map(({ window }) => window);
}

export function SubscriptionQuotaPanels({ companyId, accounts, refreshing, failed, onRefresh }: {
  companyId?: string;
  accounts: ProviderQuotaResult[];
  refreshing: boolean;
  failed: boolean;
  onRefresh: () => void;
}) {
  if (!accounts.length && !refreshing && !failed) return null;
  const now = Date.now();
  return (
    <section className="space-y-3" aria-label="Subscription quotas" data-testid="subscription-quota-cards">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div>
          <h2 className="text-sm font-semibold">Subscription quotas</h2>
          <p className="text-xs text-muted-foreground">Host CLI accounts · Account-wide usage · Refreshes every minute while visible</p>
        </div>
        <Button variant="ghost" size="sm" disabled={refreshing} onClick={onRefresh}>
          <RefreshCw className="h-3.5 w-3.5" />
          {refreshing ? "Checking…" : "Refresh"}
        </Button>
      </div>
      {failed && <p role="alert" className="text-sm text-destructive">Quota refresh failed. Any values below are from the previous check.</p>}
      <div className="grid gap-4 md:grid-cols-3">
        {PROVIDERS.map(({ id, title }) => {
          const account = accounts.find((value) => value.provider === id);
          return (
            <Card key={id}>
              <CardHeader>
                <CardTitle className="text-sm">{title}</CardTitle>
                <CardDescription className="text-xs">{account?.accountLabel ?? "Host subscription"}</CardDescription>
              </CardHeader>
              <CardContent className="space-y-3">
                {id === "anthropic" && companyId ? <HostClaudeLogin key={companyId} companyId={companyId}>
                  <QuotaContent provider={id} account={account} refreshing={refreshing} now={now} />
                </HostClaudeLogin> : id === "openai" && companyId ? <HostCodexLogin key={companyId} companyId={companyId}>
                  <QuotaContent provider={id} account={account} refreshing={refreshing} now={now} />
                </HostCodexLogin> : <QuotaContent provider={id} account={account} refreshing={refreshing} now={now} />}
              </CardContent>
            </Card>
          );
        })}
      </div>
    </section>
  );
}

function QuotaContent({ provider, account, refreshing, now }: { provider: string; account?: ProviderQuotaResult; refreshing: boolean; now: number }) {
  return <>
    {!account ? <p className="text-sm text-muted-foreground">{refreshing ? "Checking quota…" : "Quota unavailable"}</p>
      : !account.ok ? <p className="text-sm text-muted-foreground" role="status">{account.error ?? "Quota unavailable"}</p>
      : orderQuotaWindows(account.windows).map((window, index) => (
        <div key={window.label + ":" + index} className="space-y-1" title={window.detail ?? undefined}>
          {window.usedPercent == null ? (
            <div className="space-y-1 text-xs">
              <p className="text-muted-foreground">{window.label}</p>
              <p>{window.valueLabel ?? "Remaining quota not reported"}</p>
            </div>
          ) : (
            <QuotaBar label={window.label} percentUsed={window.usedPercent} valueMode="remaining"
              leftLabel={new Intl.NumberFormat(undefined, { maximumFractionDigits: 1 }).format(100 - window.usedPercent) + "% remaining"} />
          )}
          {window.usedPercent != null && <p className="text-xs text-muted-foreground" title={window.resetsAt ? formatDateTime(window.resetsAt) : undefined}>
            {quotaResetLabel(window.resetsAt, now)}
          </p>}
        </div>
      ))}
    {provider === "antigravity" && <p className="text-xs text-muted-foreground">Only provider-reported model groups are shown. Other groups are unknown.</p>}
    {account?.capturedAt && <p className="text-xs text-muted-foreground">Last checked {formatDateTime(account.capturedAt)}</p>}
  </>;
}

export function SubscriptionQuotaCards({ companyId }: { companyId: string }) {
  const client = useQueryClient();
  const access = useQuery({
    queryKey: queryKeys.access.currentBoardAccess,
    queryFn: () => accessApi.getCurrentBoardAccess(), retry: false, staleTime: 30_000,
  });
  const allowed = access.data?.isInstanceAdmin || access.data?.source === "local_implicit";
  const quotas = useQuery({
    queryKey: ["dashboard-subscription-quotas", companyId],
    queryFn: () => dashboardApi.subscriptionQuotas(companyId),
    enabled: !!allowed, retry: false, staleTime: 60_000,
    refetchInterval: 60_000, refetchIntervalInBackground: false,
  });
  if (access.isError) return <p className="text-sm text-destructive">Could not check access to subscription quotas.</p>;
  if (!allowed) return null;
  return <SubscriptionQuotaPanels companyId={companyId} accounts={quotas.data ?? []} refreshing={quotas.isFetching}
    failed={quotas.isError} onRefresh={() => {
      void quotas.refetch();
      void client.invalidateQueries({ queryKey: ["host-claude-logins", companyId] });
      void client.invalidateQueries({ queryKey: ["host-claude-status", companyId] });
      void client.invalidateQueries({ queryKey: ["host-codex-logins", companyId] });
      void client.invalidateQueries({ queryKey: ["host-codex-status", companyId] });
    }} />;
}
