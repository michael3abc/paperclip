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
    expect(priced.pricingProvenance).toMatchObject({ source: "rate_card", version: "compass-official-2026-11-04",
      serviceTier: "standard", contextTier: "short" });
    expect(priced.pricingProvenance?.evidence).toContain("one-hour rate");
    expect(priced.usage).toBe(claude.usage);
    expect(claude.costStatus).toBe("unpriced");
  });
  it("uses the Opus 5.5 rates for compass-opus5.5", () => {
    expect(priceCompassReceipt({ ...claude, model: "compass-opus5.5" }).costUsdExact).toBe("0.270291600");
  });
  it("prices a GPT-backed model, separating cache writes from plain input", () => {
    // 900k*2 + 400k*0.1 + 100k*2.5 + 50k*10 per million tokens
    expect(priceCompassReceipt(codex).costUsdExact).toBe("2.590000000");
    // astra: 900k*10 + 400k*1 + 100k*12.5 + 50k*50 per million tokens
    expect(priceCompassReceipt({ ...codex, model: "compass-6-astra" }).costUsdExact).toBe("13.150000000");
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
    { biller: "anthropic" }, { biller: "unknown" }, { model: "compass-fable5" }, { model: "compass-test" },
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
  ] as Partial<AdapterUsageCheckpoint>[])("preserves GPT receipts it cannot price exactly: %j", override => {
    const original = { ...codex, ...override };
    expect(priceCompassReceipt(original)).toBe(original);
  });
  it("leaves non-Compass receipts untouched", () => {
    const direct = { ...claude, biller: "anthropic", provider: "anthropic", model: "claude-sonnet-5" };
    expect(priceCompassReceipt(direct)).toBe(direct);
  });
});
