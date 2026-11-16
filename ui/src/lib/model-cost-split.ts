import type { CostByProviderModel } from "@paperclipai/shared";

/**
 * Split model spend into two wholes for the dashboard pies:
 *
 * - Compass: the recorded (estimated, list-price) cost of runs that went
 *   through the Compass gateway.
 * - Subscription: slices use the API list-price estimate of recorded tokens,
 *   not the subscription fee or money charged per run.
 *
 * Model IDs are folded into families so `opus`, `opus[1m]` and
 * `compass-opus5.5[1m]` read as one slice and keep one color in both pies.
 */

const SUBSCRIPTION_BILLING_TYPES = new Set(["subscription_included", "subscription_overage"]);

/** USD per million tokens: [input, cache read, output]. Existing public list
 * prices, matching server rate cards (compass-pricing.ts, codex-pricing.ts).
 * Standard processing is assumed; cache writes are not separately recorded. */
type Rates = readonly [number, number, number];

interface Family {
  key: string;
  label: string;
  rates: Rates | null;
}

const FAMILIES: ReadonlyArray<{ test: RegExp } & Family> = [
  { test: /opus/i, key: "opus", label: "Opus 5.5", rates: [4, 0.2, 20] },
  { test: /sonnet/i, key: "sonnet", label: "Sonnet 5.5", rates: [2, 0.1, 10] },
  { test: /haiku/i, key: "haiku", label: "Haiku 4.5", rates: [1, 0.1, 5] },
  { test: /(^|[-/])(gpt-)?6-astra$/i, key: "gpt-6-astra", label: "GPT-6 Astra", rates: [10, 1, 50] },
  { test: /(^|[-/])(gpt-)?6\.1-sol$/i, key: "gpt-6.1-sol", label: "GPT-6.1 Sol", rates: [2, 0.1, 10] },
  { test: /(^|[-/])(gpt-)?6-sol$/i, key: "gpt-6-sol", label: "GPT-6 Sol", rates: [2, 0.2, 10] },
  { test: /(^|[-/])(gpt-)?6-luna$/i, key: "gpt-6-luna", label: "GPT-6 Luna", rates: [0.1, 0.01, 0.5] },
  { test: /gemini-4-hydrogen/i, key: "gemini-4-hydrogen", label: "Gemini 4 Hydrogen", rates: null },
  { test: /gemini-4-argon/i, key: "gemini-4-argon", label: "Gemini 4 Argon", rates: null },
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
  if (found) return { key: found.key, label: found.label, rates: found.rates };
  const bare = model.split("/").pop() || model;
  return { key: bare, label: bare, rates: null };
}

export function modelColorVar(key: string): string {
  const slot = FAMILY_SLOTS[key];
  return slot ? `var(--chart-series-${slot})` : "var(--chart-series-other)";
}

export function listPriceCents(rates: Rates, row: Pick<CostByProviderModel, "inputTokens" | "cachedInputTokens" | "outputTokens">): number {
  // The API's inputTokens excludes cache reads for every provider. Each input
  // category is priced once; do not subtract cachedInputTokens a second time.
  const usd =
    (row.inputTokens * rates[0] + row.cachedInputTokens * rates[1] + row.outputTokens * rates[2]) / 1_000_000;
  return usd * 100;
}

export interface ModelCostSlice {
  key: string;
  label: string;
  cents: number;
  share: number;
  color: string;
  models: string[];
}

export interface ModelCostWhole {
  totalCents: number;
  slices: ModelCostSlice[];
  /** Families with usage but no rate card (or unpriced Compass runs). */
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
  priced: boolean;
  models: Set<string>;
}

function buildWhole(buckets: Map<string, Bucket>): ModelCostWhole {
  const priced = [...buckets.values()].filter((bucket) => bucket.priced && bucket.cents > 0);
  priced.sort((a, b) => b.cents - a.cents || a.label.localeCompare(b.label));
  const totalCents = priced.reduce((sum, bucket) => sum + bucket.cents, 0);
  const head = priced.length > MAX_SLICES ? priced.slice(0, MAX_SLICES - 1) : priced;
  const tail = priced.length > MAX_SLICES ? priced.slice(MAX_SLICES - 1) : [];
  const slices: ModelCostSlice[] = head.map((bucket) => ({
    key: bucket.key,
    label: bucket.label,
    cents: bucket.cents,
    share: totalCents > 0 ? bucket.cents / totalCents : 0,
    color: modelColorVar(bucket.key),
    models: [...bucket.models].sort(),
  }));
  if (tail.length > 0) {
    const cents = tail.reduce((sum, bucket) => sum + bucket.cents, 0);
    slices.push({
      key: OTHER_SLICE_KEY,
      label: "Other",
      cents,
      share: totalCents > 0 ? cents / totalCents : 0,
      color: "var(--chart-series-other)",
      models: tail.flatMap((bucket) => [...bucket.models]).sort(),
    });
  }
  const unpriced = [...buckets.values()]
    .filter((bucket) => (!bucket.priced && bucket.tokens > 0) || bucket.unpricedEvents > 0)
    .map((bucket) => ({ key: bucket.key, label: bucket.label, tokens: bucket.tokens, events: bucket.unpricedEvents }))
    .sort((a, b) => b.tokens - a.tokens);
  return { totalCents, slices, unpriced };
}

function bucketFor(buckets: Map<string, Bucket>, family: Family): Bucket {
  let bucket = buckets.get(family.key);
  if (!bucket) {
    bucket = { key: family.key, label: family.label, cents: 0, tokens: 0, unpricedEvents: 0, priced: false, models: new Set() };
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
      bucket.tokens += tokens;
      if (family.rates) {
        bucket.priced = true;
        bucket.cents += listPriceCents(family.rates, row);
      }
    } else if (isCompassRow(row)) {
      const bucket = bucketFor(compass, family);
      bucket.models.add(row.model);
      bucket.tokens += tokens;
      bucket.priced = true;
      bucket.cents += row.costCents;
      bucket.unpricedEvents += row.unpricedEventCount ?? 0;
    }
  }
  return { compass: buildWhole(compass), subscription: buildWhole(subscription) };
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
