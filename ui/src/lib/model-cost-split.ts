import type { CostByProviderModel } from "@paperclipai/shared";

/**
 * Split model usage into two wholes for the dashboard pies:
 *
 * - Compass: the recorded (estimated, list-price) cost of runs that went
 *   through the Compass gateway, sliced by cost.
 * - Subscription: runs draw on the plan's fixed limits and cost $0 (Owner,
 *   HOM-265), so that pie is sliced by tokens and its total cost is $0.
 *
 * Model IDs are folded into families so `opus`, `opus[1m]` and
 * `compass-opus5.5[1m]` read as one slice and keep one color in both pies.
 */

const SUBSCRIPTION_BILLING_TYPES = new Set(["subscription_included", "subscription_overage"]);

interface Family {
  key: string;
  label: string;
}

const FAMILIES: ReadonlyArray<{ test: RegExp } & Family> = [
  { test: /opus/i, key: "opus", label: "Opus 5.5" },
  { test: /sonnet/i, key: "sonnet", label: "Sonnet 5.5" },
  { test: /haiku/i, key: "haiku", label: "Haiku 4.5" },
  { test: /(^|[-/])(gpt-)?6-astra$/i, key: "gpt-6-astra", label: "GPT-6 Astra" },
  { test: /(^|[-/])(gpt-)?6\.1-sol$/i, key: "gpt-6.1-sol", label: "GPT-6.1 Sol" },
  { test: /(^|[-/])(gpt-)?6-sol$/i, key: "gpt-6-sol", label: "GPT-6 Sol" },
  { test: /(^|[-/])(gpt-)?6-luna$/i, key: "gpt-6-luna", label: "GPT-6 Luna" },
  { test: /gemini-4-hydrogen/i, key: "gemini-4-hydrogen", label: "Gemini 4 Hydrogen" },
  { test: /gemini-4-argon/i, key: "gemini-4-argon", label: "Gemini 4 Argon" },
];

/** Fixed color slot per family: color follows the model, never its rank. */
const FAMILY_SLOTS: Record<string, number> = {
  opus: 1,
  "gpt-6-astra": 2,
  "gpt-6.1-sol": 3,
  sonnet: 4,
  "gemini-4-hydrogen": 5,
  "gemini-4-argon": 6,
  haiku: 7,
  "gpt-6-luna": 8,
};

export const OTHER_SLICE_KEY = "__other__";
const MAX_SLICES = 6;

export function modelFamily(model: string): Family {
  const found = FAMILIES.find((family) => family.test.test(model));
  if (found) return { key: found.key, label: found.label };
  const bare = model.split("/").pop() || model;
  return { key: bare, label: bare };
}

export function modelColorVar(key: string): string {
  const slot = FAMILY_SLOTS[key];
  return slot ? `var(--chart-series-${slot})` : "var(--chart-series-other)";
}

export interface ModelCostSlice {
  key: string;
  label: string;
  cents: number;
  tokens: number;
  share: number;
  color: string;
  models: string[];
}

export interface ModelCostWhole {
  /** What sizes the slices: Compass by cost, subscription by tokens. */
  measure: "cost" | "tokens";
  totalCents: number;
  totalTokens: number;
  slices: ModelCostSlice[];
  /** Compass families with unpriced runs, not in the total. */
  unpriced: { key: string; label: string; tokens: number; events: number }[];
}

export interface ModelCostSplit {
  compass: ModelCostWhole;
  subscription: ModelCostWhole;
}

export function isCompassRow(row: CostByProviderModel): boolean {
  if (SUBSCRIPTION_BILLING_TYPES.has(row.billingType)) return false;
  return row.biller === "compass" || /^compass-/i.test(row.model);
}

export function isSubscriptionRow(row: CostByProviderModel): boolean {
  return SUBSCRIPTION_BILLING_TYPES.has(row.billingType);
}

interface Bucket {
  key: string;
  label: string;
  cents: number;
  tokens: number;
  unpricedEvents: number;
  models: Set<string>;
}

function buildWhole(buckets: Map<string, Bucket>, measure: ModelCostWhole["measure"]): ModelCostWhole {
  const valueOf = (bucket: Pick<Bucket, "cents" | "tokens">) => (measure === "cost" ? bucket.cents : bucket.tokens);
  const included = [...buckets.values()].filter((bucket) => valueOf(bucket) > 0);
  included.sort((a, b) => valueOf(b) - valueOf(a) || a.label.localeCompare(b.label));
  const total = included.reduce((sum, bucket) => sum + valueOf(bucket), 0);
  const head = included.length > MAX_SLICES ? included.slice(0, MAX_SLICES - 1) : included;
  const tail = included.length > MAX_SLICES ? included.slice(MAX_SLICES - 1) : [];
  const slices: ModelCostSlice[] = head.map((bucket) => ({
    key: bucket.key,
    label: bucket.label,
    cents: bucket.cents,
    tokens: bucket.tokens,
    share: total > 0 ? valueOf(bucket) / total : 0,
    color: modelColorVar(bucket.key),
    models: [...bucket.models].sort(),
  }));
  if (tail.length > 0) {
    const other = {
      cents: tail.reduce((sum, bucket) => sum + bucket.cents, 0),
      tokens: tail.reduce((sum, bucket) => sum + bucket.tokens, 0),
    };
    slices.push({
      key: OTHER_SLICE_KEY,
      label: "Other",
      ...other,
      share: total > 0 ? valueOf(other) / total : 0,
      color: "var(--chart-series-other)",
      models: tail.flatMap((bucket) => [...bucket.models]).sort(),
    });
  }
  const unpriced = [...buckets.values()]
    .filter((bucket) => bucket.unpricedEvents > 0)
    .map((bucket) => ({ key: bucket.key, label: bucket.label, tokens: bucket.tokens, events: bucket.unpricedEvents }))
    .sort((a, b) => b.events - a.events);
  return {
    measure,
    totalCents: included.reduce((sum, bucket) => sum + bucket.cents, 0),
    totalTokens: included.reduce((sum, bucket) => sum + bucket.tokens, 0),
    slices,
    unpriced,
  };
}

function bucketFor(buckets: Map<string, Bucket>, family: Family): Bucket {
  let bucket = buckets.get(family.key);
  if (!bucket) {
    bucket = { key: family.key, label: family.label, cents: 0, tokens: 0, unpricedEvents: 0, models: new Set() };
    buckets.set(family.key, bucket);
  }
  return bucket;
}

export function splitModelCosts(rows: readonly CostByProviderModel[]): ModelCostSplit {
  const compass = new Map<string, Bucket>();
  const subscription = new Map<string, Bucket>();
  for (const row of rows) {
    const tokens = row.inputTokens + row.cachedInputTokens + row.outputTokens;
    const family = modelFamily(row.model);
    if (isSubscriptionRow(row)) {
      if (tokens <= 0) continue;
      const bucket = bucketFor(subscription, family);
      bucket.models.add(row.model);
      // Drawn from the plan's fixed limits: no money is spent per run.
      bucket.tokens += tokens;
    } else if (isCompassRow(row)) {
      const bucket = bucketFor(compass, family);
      bucket.models.add(row.model);
      bucket.tokens += tokens;
      bucket.cents += row.costCents;
      bucket.unpricedEvents += row.unpricedEventCount ?? 0;
    }
  }
  return { compass: buildWhole(compass, "cost"), subscription: buildWhole(subscription, "tokens") };
}

export type ModelCostPeriod = "year" | "month" | "week" | "today";

export const MODEL_COST_PERIODS: ReadonlyArray<{ key: ModelCostPeriod; label: string; detail: string }> = [
  { key: "year", label: "This year", detail: "This year (UTC)" },
  { key: "month", label: "This month", detail: "This month (UTC)" },
  { key: "week", label: "This week", detail: "This week (from Monday, local time)" },
  { key: "today", label: "Today", detail: "Today (local time)" },
];

export function isModelCostPeriod(value: unknown): value is ModelCostPeriod {
  return MODEL_COST_PERIODS.some((period) => period.key === value);
}

/**
 * Start of the selected period. Year and month follow the UTC calendar like
 * Month Spend, budgets and the Costs page presets; week (Monday start) and
 * today follow the viewer's local calendar like the Costs page week view.
 */
export function modelCostPeriodStartIso(period: ModelCostPeriod, now = new Date()): string {
  switch (period) {
    case "year":
      return new Date(Date.UTC(now.getUTCFullYear(), 0, 1)).toISOString();
    case "month":
      return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1)).toISOString();
    case "week": {
      const day = now.getDay();
      const diffToMonday = day === 0 ? -6 : 1 - day;
      return new Date(now.getFullYear(), now.getMonth(), now.getDate() + diffToMonday).toISOString();
    }
    case "today":
      return new Date(now.getFullYear(), now.getMonth(), now.getDate()).toISOString();
  }
}
