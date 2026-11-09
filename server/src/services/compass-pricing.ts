import { centsToUsd, unitsToCents, usdToUnits } from "@paperclipai/shared";
import type { AdapterUsageCheckpoint } from "@paperclipai/adapter-utils";

// Immutable, reviewed rate card for the Compass gateway. Compass is billed at
// the upstream vendor's list price, so each Compass model carries the rates of
// the vendor model it fronts. A rate change is a new VERSION and a new table;
// receipts already priced keep the rates they were issued with.
// OpenAI:    https://developers.openai.com/api/docs/pricing (retrieved 2026-11-04)
// Anthropic: https://platform.claude.com/docs/en/about-claude/pricing (retrieved 2026-11-04)
const VERSION = "compass-official-2026-11-04";

type Vendor = "openai" | "anthropic";
/** USD per million tokens: [input, cache read, cache write, output]. */
type Rates = readonly [string, string, string, string];

const MODELS: Record<string, { vendor: Vendor; upstream: string; rates: Rates }> = {
  // Anthropic 5.5 has no long-context tier. Cache write is the one-hour rate:
  // Claude Code through Compass was observed writing only one-hour entries.
  "compass-opus5.5": { vendor: "anthropic", upstream: "Claude Opus 5.5", rates: ["4", "0.2", "8", "20"] },
  "compass-sonnet5.5": { vendor: "anthropic", upstream: "Claude Sonnet 5.5", rates: ["2", "0.1", "4", "10"] },
  "compass-6.1-sol": { vendor: "openai", upstream: "gpt-6.1-sol", rates: ["2", "0.1", "2.5", "10"] },
  "compass-6-astra": { vendor: "openai", upstream: "gpt-6-astra", rates: ["10", "1", "12.5", "50"] },
};

const SOURCES: Record<Vendor, string> = {
  openai: "https://developers.openai.com/api/docs/pricing",
  anthropic: "https://platform.claude.com/docs/en/about-claude/pricing",
};

/** Price a complete, per-run Compass receipt at the upstream vendor's list
 * price. The result is an estimate, never an invoice claim: the bridge's own
 * cost figure is a CLI guess for an unknown model and is never trusted here.
 * Token convention (same as the other pricers): `inputTokens` includes cache
 * writes and excludes cache reads; `cacheWriteTokens` is a subset of input.
 * Anything this card cannot price exactly is returned unchanged, so it stays
 * visibly unpriced instead of acquiring a guessed cost. */
export function priceCompassReceipt(
  receipt: AdapterUsageCheckpoint,
): AdapterUsageCheckpoint {
  if (
    !receipt.complete ||
    !receipt.usage ||
    receipt.usageBasis !== "per_run" ||
    receipt.biller !== "compass" ||
    !["api", "metered_api"].includes(receipt.billingType ?? "") ||
    receipt.usageByModel?.length ||
    receipt.costUsd != null ||
    receipt.costUsdExact != null ||
    receipt.cacheAdjustedCostUsd != null
  )
    return receipt;
  const model = receipt.model ?? "";
  // Claude Code's `[1m]` selector suffix only enables the 1M context window and
  // is stripped before the request reaches Compass. Anthropic 5.5 bills the
  // whole window at one tier, so it uses the base model's card. OpenAI models
  // have no such suffix and stay exact-match only.
  const oneMillion = /\[1m\]$/i.test(model);
  const base = oneMillion ? model.slice(0, -4) : model;
  const found = Object.hasOwn(MODELS, base) ? MODELS[base] : undefined;
  const card = found && (!oneMillion || found.vendor === "anthropic") ? found : undefined;
  if (!card) return receipt;
  const context = receipt.pricingContext;
  if (
    (context?.serviceTier && !["standard", "default"].includes(context.serviceTier)) ||
    (context?.contextTier && context.contextTier !== "short" &&
      !(context.contextTier === "long" && card.vendor === "openai"))
  )
    return receipt;
  const usage = receipt.usage;
  // Anthropic receipts must state both cache counters. Without cache writes
  // (billed above plain input) the cost would be silently understated.
  if (
    card.vendor === "anthropic" &&
    (usage.cacheWriteTokens === undefined || usage.cachedInputTokens === undefined)
  )
    return receipt;
  const counts = [
    usage.inputTokens - (usage.cacheWriteTokens ?? 0),
    usage.cachedInputTokens ?? 0,
    usage.cacheWriteTokens ?? 0,
    usage.outputTokens,
  ];
  if (counts.some((n) => !Number.isSafeInteger(n) || n < 0)) return receipt;
  const long = context?.contextTier === "long";
  // OpenAI long context (>272K input tokens): 2x input/cache, 1.5x output.
  const units = counts.reduce((total, count, index) => {
    const numerator = long ? (index === 3 ? 3n : 4n) : 2n;
    return total + BigInt(count) * usdToUnits(card.rates[index]) * numerator;
  }, 0n);
  const divisor = 2_000_000n;
  const costCents = unitsToCents((units + divisor / 2n) / divisor);
  const assumptions = [
    `Compass billed at ${card.upstream} list price`,
    ...(oneMillion ? ["1M context window at the single 5.5 tier"] : []),
    "standard processing assumed",
    long ? "long per-request context" : "short per-request context assumed",
    card.vendor === "anthropic"
      ? "cache writes priced at the one-hour rate"
      : usage.cacheWriteTokens === undefined
        ? "cache writes not separately reported"
        : "cache writes reported",
    "not an invoice",
  ];
  return {
    ...receipt,
    costUsdExact: centsToUsd(costCents),
    costStatus: "estimated",
    pricingProvenance: {
      source: "rate_card",
      version: VERSION,
      evidence: `${SOURCES[card.vendor]}; ${assumptions.join("; ")}`,
      inputCentsPerMillion: unitsToCents(usdToUnits(card.rates[0])),
      cachedInputCentsPerMillion: unitsToCents(usdToUnits(card.rates[1])),
      cacheWriteCentsPerMillion: unitsToCents(usdToUnits(card.rates[2])),
      outputCentsPerMillion: unitsToCents(usdToUnits(card.rates[3])),
      serviceTier: "standard",
      contextTier: long ? "long" : "short",
    },
  };
}
