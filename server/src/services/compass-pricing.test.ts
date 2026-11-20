import { describe, expect, it } from "vitest";
import type { AdapterUsageCheckpoint } from "@paperclipai/adapter-utils";
import { priceCompassReceipt } from "./compass-pricing.js";

const claude: AdapterUsageCheckpoint = { complete: true, usageBasis: "per_run", provider: "claude", biller: "compass",
  billingType: "metered_api", model: "compass-sonnet5.5", costUsd: null, costStatus: "unpriced",
  usage: { inputTokens: 22462, cachedInputTokens: 208218, cacheWriteTokens: 22450, outputTokens: 2450 } };
const codex: AdapterUsageCheckpoint = { complete: true, usageBasis: "per_run", provider: "codex", biller: "compass",
  billingType: "metered_api", model: "compass-6.1-sol", costUsd: null, costStatus: "unpriced",
  usage: { inputTokens: 1_000_000, cachedInputTokens: 400_000, cacheWriteTokens: 100_000, outputTokens: 50_000 } };

describe("Compass receipt pricing at the upstream vendor's list price", () => {
  it("prices a Claude-backed model with input, cache read, one-hour cache write and output rates", () => {
    const priced = priceCompassReceipt(claude);
    // 12*2 + 208218*0.1 + 22450*4 + 2450*10 per million tokens
    expect(priced.costUsdExact).toBe("0.135145800");
    expect(priced.costStatus).toBe("estimated");
    expect(priced.pricingProvenance).toMatchObject({ source: "rate_card", version: "compass-official-2026-11-20-ttl",
      serviceTier: "standard", contextTier: "short" });
    expect(priced.pricingProvenance?.evidence).toContain("one-hour rate");
    expect(priced.usage).toBe(claude.usage);
    expect(claude.costStatus).toBe("unpriced");
  });
  it.each([
    ["compass-opus5.5", "6.500000000"], ["compass-sonnet5.5", "3.250000000"],
    ["compass-fable5.2", "13.000000000"], ["compass-fable5", "16.250000000"],
    ["compass-opus5", "8.125000000"],
  ])("prices mixed 5m/1h writes for %s", (model, cost) => {
    const result = priceCompassReceipt({ ...claude, model, usage: { inputTokens: 1000000, cachedInputTokens: 0,
      cacheWriteTokens: 1000000, cacheWrite1hTokens: 500000, outputTokens: 0 } });
    expect(result.costUsdExact).toBe(cost);
    expect(result.pricingProvenance?.evidence).toContain("500000 at one-hour");
    expect(result.pricingProvenance?.evidence).toContain("500000 at five-minute");
  });
  it.each([[0, "2.500000000"], [1000000, "4.000000000"]])("prices an explicit 1h subset of %s", (oneHour, cost) => {
    expect(priceCompassReceipt({ ...claude, usage: { inputTokens: 1000000, outputTokens: 0,
      cachedInputTokens: 0, cacheWriteTokens: 1000000, cacheWrite1hTokens: oneHour } }).costUsdExact).toBe(cost);
  });
  it.each([-1, 22451, 0.5, NaN, Infinity])("does not price invalid 1h subsets: %s", oneHour => {
    const receipt = { ...claude, usage: { ...claude.usage!, cacheWrite1hTokens: oneHour } };
    expect(priceCompassReceipt(receipt)).toBe(receipt);
  });
  it("keeps a previously priced receipt immutable even with new TTL evidence", () => {
    const previous = { ...claude, costUsdExact: "0.135145800", pricingProvenance: { source: "rate_card" as const,
      version: "compass-official-2026-11-16" }, usage: { ...claude.usage!, cacheWrite1hTokens: 0 } };
    expect(priceCompassReceipt(previous)).toBe(previous);
  });
  it("uses the Opus 5.5 rates for compass-opus5.5", () => {
    expect(priceCompassReceipt({ ...claude, model: "compass-opus5.5" }).costUsdExact).toBe("0.270291600");
  });
  it("prices the [1m] context-window selector at its base 5.5 card and keeps the model id", () => {
    const priced = priceCompassReceipt({ ...claude, model: "compass-opus5.5[1m]" });
    expect(priced.costUsdExact).toBe("0.270291600");
    expect(priced.model).toBe("compass-opus5.5[1m]");
    expect(priced.pricingProvenance?.evidence).toContain("1M context window");
    expect(priceCompassReceipt({ ...claude, model: "compass-sonnet5.5[1M]" }).costUsdExact).toBe("0.135145800");
    expect(priceCompassReceipt({ ...claude, model: "compass-opus5.5" }).pricingProvenance?.evidence)
      .not.toContain("1M context window");
  });
  it("prices a GPT-backed model, separating cache writes from plain input", () => {
    // 900k*2 + 400k*0.1 + 100k*2.5 + 50k*10 per million tokens
    expect(priceCompassReceipt(codex).costUsdExact).toBe("2.590000000");
    // astra: 900k*10 + 400k*1 + 100k*12.5 + 50k*50 per million tokens
    expect(priceCompassReceipt({ ...codex, model: "compass-6-astra" }).costUsdExact).toBe("13.150000000");
  });
  it("prices the Compass selectors added from the 2026-11-16 official list prices", () => {
    // terra: 900k*1 + 400k*0.05 + 100k*1.25 + 50k*5; long: 2*(0.9+0.02+0.125) + 1.5*0.25
    expect(priceCompassReceipt({ ...codex, model: "compass-6.1-terra" }).costUsdExact).toBe("1.295000000");
    expect(priceCompassReceipt({ ...codex, model: "compass-6.1-terra", pricingContext: { contextTier: "long" } }).costUsdExact)
      .toBe("2.465000000");
    // luna: 900k*0.1 + 400k*0.01 + 100k*0.125 + 50k*0.5
    expect(priceCompassReceipt({ ...codex, model: "compass-6-luna" }).costUsdExact).toBe("0.131500000");
    // fable 5.2: 12*8 + 208218*0.2 + 22450*16 + 2450*40, the [1m] selector at the same card
    expect(priceCompassReceipt({ ...claude, model: "compass-fable5.2" }).costUsdExact).toBe("0.498939600");
    expect(priceCompassReceipt({ ...claude, model: "compass-fable5.2[1m]" }).costUsdExact).toBe("0.498939600");
    // fable 5: 12*10 + 208218*1 + 22450*20 + 2450*50; opus 5: 12*5 + 208218*0.5 + 22450*10 + 2450*25
    expect(priceCompassReceipt({ ...claude, model: "compass-fable5" }).costUsdExact).toBe("0.779838000");
    expect(priceCompassReceipt({ ...claude, model: "compass-opus5" }).costUsdExact).toBe("0.389919000");
    // Models without an official card entry stay visibly unpriced.
    expect(priceCompassReceipt({ ...codex, model: "compass-5.6-sol" }).costStatus).toBe("unpriced");
  });
  it("treats unreported OpenAI cache writes as plain input and says so", () => {
    const priced = priceCompassReceipt({ ...codex, usage: { inputTokens: 1_000_000, cachedInputTokens: 400_000, outputTokens: 50_000 } });
    // 1M*2 + 400k*0.1 + 50k*10
    expect(priced.costUsdExact).toBe("2.540000000");
    expect(priced.pricingProvenance?.evidence).toContain("cache writes not separately reported");
  });
  it("applies the OpenAI long-context multipliers only when the receipt states a long context", () => {
    const priced = priceCompassReceipt({ ...codex, pricingContext: { contextTier: "long" } });
    // 2 * (1.8 + 0.04 + 0.25) + 1.5 * 0.5
    expect(priced.costUsdExact).toBe("4.930000000");
    expect(priced.pricingProvenance?.contextTier).toBe("long");
  });
  it("accepts the legacy api billing type and an explicit standard tier", () => {
    expect(priceCompassReceipt({ ...claude, billingType: "api", pricingContext: { serviceTier: "standard" } }).costUsdExact)
      .toBe("0.135145800");
  });
  it("prices zero-token runs at zero rather than leaving them unpriced", () => {
    const priced = priceCompassReceipt({ ...claude, usage: { inputTokens: 0, outputTokens: 0, cachedInputTokens: 0, cacheWriteTokens: 0 } });
    expect(priced.costUsdExact).toBe("0.000000000");
    expect(priced.costStatus).toBe("estimated");
  });
  it.each([
    { complete: false }, { billingType: "unknown" }, { billingType: "credits" }, { billingType: "subscription_included" },
    { biller: "anthropic" }, { biller: "unknown" }, { model: "compass-fable5.1" }, { model: "compass-test" },
    { model: "compass-haiku5.5[1m]" }, { model: "[1m]" }, { model: "compass-opus5.5[1m]x" },
    { model: "claude-sonnet-5" }, { model: "constructor" }, { model: undefined },
    { usageBasis: "session_cumulative" }, { costUsd: 0.12 }, { costUsd: 0 }, { costUsdExact: "0.12" }, { cacheAdjustedCostUsd: 0.12 },
    { pricingContext: { serviceTier: "priority" } }, { pricingContext: { contextTier: "long" } },
    { usageByModel: [{ model: "other", usage: { inputTokens: 1, outputTokens: 1 }, costUsd: 1 }] },
    { usage: undefined }, { usage: { inputTokens: 1, outputTokens: 1 } },
    { usage: { inputTokens: 1, outputTokens: 1, cacheWriteTokens: 1 } },
    { usage: { inputTokens: 1, outputTokens: 1, cacheWriteTokens: 2, cachedInputTokens: 0 } },
    { usage: { inputTokens: 1, outputTokens: -1, cacheWriteTokens: 0, cachedInputTokens: 0 } },
    { usage: { inputTokens: 1.5, outputTokens: 1, cacheWriteTokens: 0, cachedInputTokens: 0 } },
  ] as Partial<AdapterUsageCheckpoint>[])("preserves incomplete, incompatible or already priced Claude receipts: %j", override => {
    const original = { ...claude, ...override };
    expect(priceCompassReceipt(original)).toBe(original);
  });
  it.each([
    { pricingContext: { serviceTier: "flex" } }, { pricingContext: { serviceTier: "batch" } },
    { usage: { inputTokens: 5, cachedInputTokens: 0, cacheWriteTokens: 6, outputTokens: 1 } },
    { model: "compass-6.1-sol[1m]" }, { model: "compass-6-astra[1m]" },
  ] as Partial<AdapterUsageCheckpoint>[])("preserves GPT receipts it cannot price exactly: %j", override => {
    const original = { ...codex, ...override };
    expect(priceCompassReceipt(original)).toBe(original);
  });
  it("leaves non-Compass receipts untouched", () => {
    const direct = { ...claude, biller: "anthropic", provider: "anthropic", model: "claude-sonnet-5" };
    expect(priceCompassReceipt(direct)).toBe(direct);
  });
});
