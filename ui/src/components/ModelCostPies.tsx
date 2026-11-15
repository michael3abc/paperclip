import { useMemo, useState } from "react";
import { Button } from "@/components/ui/button";
import { useQuery } from "@tanstack/react-query";
import { Link } from "@/lib/router";
import { costsApi } from "../api/costs";
import { queryKeys } from "../lib/queryKeys";
import { formatCents, formatTokens } from "../lib/utils";
import {
  isModelCostPeriod,
  MODEL_COST_PERIODS,
  modelCostPeriodStartIso,
  splitModelCosts,
  type ModelCostPeriod,
  type ModelCostSlice,
  type ModelCostWhole,
} from "../lib/model-cost-split";

const SIZE = 120;
const RADIUS = 56;
const CENTER = SIZE / 2;

function percent(share: number): string {
  if (share > 0 && share < 0.01) return "<1%";
  return `${Math.round(share * 100)}%`;
}

function arcPath(start: number, end: number): string {
  const startAngle = start * 2 * Math.PI - Math.PI / 2;
  const endAngle = end * 2 * Math.PI - Math.PI / 2;
  const x1 = CENTER + RADIUS * Math.cos(startAngle);
  const y1 = CENTER + RADIUS * Math.sin(startAngle);
  const x2 = CENTER + RADIUS * Math.cos(endAngle);
  const y2 = CENTER + RADIUS * Math.sin(endAngle);
  const large = end - start > 0.5 ? 1 : 0;
  return `M ${CENTER} ${CENTER} L ${x1} ${y1} A ${RADIUS} ${RADIUS} 0 ${large} 1 ${x2} ${y2} Z`;
}

function sliceTitle(slice: ModelCostSlice, valueLabel: string): string {
  return `${slice.label}: ${formatCents(slice.cents)} (${percent(slice.share)}) ${valueLabel}\n${slice.models.join(", ")}`;
}

export function ModelCostPie({ whole, valueLabel, ariaLabel }: { whole: ModelCostWhole; valueLabel: string; ariaLabel: string }) {
  if (whole.slices.length === 0) {
    return <p className="text-xs text-muted-foreground">No priced usage in this period</p>;
  }
  let cursor = 0;
  return (
    <div className="flex flex-col gap-3 sm:flex-row sm:items-start">
      <svg
        viewBox={`0 0 ${SIZE} ${SIZE}`}
        className="h-28 w-28 shrink-0"
        role="img"
        aria-label={ariaLabel}
      >
        {whole.slices.length === 1 ? (
          <circle cx={CENTER} cy={CENTER} r={RADIUS} fill={whole.slices[0]!.color}>
            <title>{sliceTitle(whole.slices[0]!, valueLabel)}</title>
          </circle>
        ) : (
          whole.slices.map((slice) => {
            const start = cursor;
            cursor += slice.share;
            return (
              <path
                key={slice.key}
                d={arcPath(start, cursor)}
                fill={slice.color}
                stroke="var(--card)"
                strokeWidth={2}
                strokeLinejoin="round"
                className="transition-opacity hover:opacity-80"
              >
                <title>{sliceTitle(slice, valueLabel)}</title>
              </path>
            );
          })
        )}
      </svg>
      <ul className="min-w-0 flex-1 space-y-1">
        {whole.slices.map((slice) => (
          <li
            key={slice.key}
            className="flex items-center gap-2 text-xs"
            title={slice.models.join(", ")}
          >
            <span className="h-2 w-2 shrink-0 rounded-full" style={{ backgroundColor: slice.color }} />
            <span className="min-w-0 flex-1 truncate">{slice.label}</span>
            <span className="tabular-nums text-muted-foreground">{percent(slice.share)}</span>
            <span className="tabular-nums">{formatCents(slice.cents)}</span>
          </li>
        ))}
      </ul>
    </div>
  );
}

function UnpricedNote({ whole, kind }: { whole: ModelCostWhole; kind: "subscription" | "compass" }) {
  if (whole.unpriced.length === 0) return null;
  const parts = whole.unpriced.map((item) =>
    kind === "subscription"
      ? `${item.label} ${formatTokens(item.tokens)} tokens`
      : `${item.label} ${item.events} run${item.events === 1 ? "" : "s"}`,
  );
  return (
    <p className="text-(length:--text-nano) text-muted-foreground">
      {kind === "subscription" ? "No list price, not in chart: " : "Unpriced runs, not in total: "}
      {parts.join(" · ")}
    </p>
  );
}

const PERIOD_STORAGE_KEY = "paperclip.dashboard.modelCostPeriod";

function readStoredPeriod(): ModelCostPeriod {
  try {
    const stored = window.localStorage.getItem(PERIOD_STORAGE_KEY);
    return isModelCostPeriod(stored) ? stored : "month";
  } catch {
    return "month";
  }
}

export function PeriodPicker({ value, onChange }: { value: ModelCostPeriod; onChange: (period: ModelCostPeriod) => void }) {
  return (
    <div className="flex flex-wrap items-center gap-1" role="group" aria-label="Cost period">
      {MODEL_COST_PERIODS.map((period) => (
        <Button
          key={period.key}
          variant={value === period.key ? "secondary" : "ghost"}
          size="xs"
          onClick={() => onChange(period.key)}
          aria-pressed={value === period.key}
        >
          {period.label}
        </Button>
      ))}
    </div>
  );
}

export function ModelCostPies({ companyId }: { companyId: string }) {
  const [period, setPeriodState] = useState<ModelCostPeriod>(readStoredPeriod);
  const setPeriod = (next: ModelCostPeriod) => {
    setPeriodState(next);
    try {
      window.localStorage.setItem(PERIOD_STORAGE_KEY, next);
    } catch {
      // Remembering the choice is a convenience only.
    }
  };
  const from = modelCostPeriodStartIso(period);
  const detail = MODEL_COST_PERIODS.find((entry) => entry.key === period)!.detail;
  const { data, error } = useQuery({
    queryKey: queryKeys.usageByProvider(companyId, from, undefined),
    queryFn: () => costsApi.byProvider(companyId, from),
    refetchInterval: 60_000,
    staleTime: 30_000,
  });
  const split = useMemo(() => splitModelCosts(data ?? []), [data]);

  const header = (
    <div className="flex flex-wrap items-center justify-between gap-2 md:col-span-2">
      <span className="text-(length:--text-nano) text-muted-foreground">{detail}</span>
      <PeriodPicker value={period} onChange={setPeriod} />
    </div>
  );

  if (error) {
    return (
      <div className="grid gap-3 md:grid-cols-2">
        {header}
        <p className="text-xs text-destructive">Could not load model costs</p>
      </div>
    );
  }
  if (!data) {
    return (
      <div className="grid gap-3 md:grid-cols-2">
        {header}
        <p className="text-xs text-muted-foreground">Loading…</p>
      </div>
    );
  }

  return (
    <div className="grid gap-6 md:grid-cols-2">
      {header}
      <section className="space-y-2">
        <div className="flex items-baseline justify-between gap-2">
          <h4 className="text-xs font-medium">Compass</h4>
          <span className="text-sm font-semibold tabular-nums">{formatCents(split.compass.totalCents)}</span>
        </div>
        <p className="text-(length:--text-nano) text-muted-foreground">Estimated spend at list price</p>
        <ModelCostPie whole={split.compass} valueLabel="Compass estimate" ariaLabel="Compass cost by model" />
        <UnpricedNote whole={split.compass} kind="compass" />
      </section>
      <section className="space-y-2">
        <div className="flex items-baseline justify-between gap-2">
          <h4 className="text-xs font-medium">Subscription</h4>
          <span className="text-sm font-semibold tabular-nums">{formatCents(split.subscription.totalCents)}</span>
        </div>
        <p className="text-(length:--text-nano) text-muted-foreground">
          API list-price equivalent, included in plans (not billed)
        </p>
        <ModelCostPie
          whole={split.subscription}
          valueLabel="list-price equivalent"
          ariaLabel="Subscription usage by model at list-price equivalent"
        />
        <UnpricedNote whole={split.subscription} kind="subscription" />
      </section>
      <Link to="/costs" className="text-(length:--text-nano) text-muted-foreground underline underline-offset-2 md:col-span-2">
        Costs details
      </Link>
    </div>
  );
}
