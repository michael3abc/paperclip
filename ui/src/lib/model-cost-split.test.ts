import { describe, expect, it } from "vitest";
import type { CostByProviderModel } from "@paperclipai/shared";
import { modelColorVar, modelCostPeriodStartIso, modelFamily, OTHER_SLICE_KEY, splitModelCosts } from "./model-cost-split";

function row(partial: Partial<CostByProviderModel>): CostByProviderModel {
  return {
    provider: "claude",
    biller: "compass",
    billingType: "metered_api",
    model: "compass-opus5.5",
    costCents: 0,
    inputTokens: 0,
    cachedInputTokens: 0,
    outputTokens: 0,
    apiRunCount: 0,
    subscriptionRunCount: 0,
    subscriptionCachedInputTokens: 0,
    subscriptionInputTokens: 0,
    subscriptionOutputTokens: 0,
    ...partial,
  } as CostByProviderModel;
}

describe("modelFamily", () => {
  it("folds subscription, Compass and 1M selectors into one family", () => {
    for (const model of ["opus", "opus[1m]", "compass-opus5.5", "compass-opus5.5[1m]", "claude-opus-5-5"]) {
      expect(modelFamily(model).key).toBe("opus");
    }
    expect(modelFamily("compass-6-astra").key).toBe("gpt-6-astra");
    expect(modelFamily("gpt-6-astra").key).toBe("gpt-6-astra");
    expect(modelFamily("compass-6.1-sol").key).toBe("gpt-6.1-sol");
    expect(modelFamily("gpt-6-sol").key).toBe("gpt-6-sol");
    expect(modelFamily("michael-server/antigravity/gemini-4-argon-high").key).toBe("gemini-4-argon");
    expect(modelFamily("vendor/some-model")).toEqual({ key: "some-model", label: "some-model", rates: null });
  });

  it("keeps one color per family regardless of rank", () => {
    expect(modelColorVar("opus")).toBe("var(--chart-series-1)");
    expect(modelColorVar("unknown-model")).toBe("var(--chart-series-other)");
  });
});

describe("splitModelCosts", () => {
  it("keeps Compass spend and subscription equivalents in separate wholes", () => {
    const split = splitModelCosts([
      row({ model: "compass-opus5.5[1m]", costCents: 3000 }),
      row({ model: "compass-opus5.5", costCents: 1000 }),
      row({ provider: "codex", model: "compass-6-astra", costCents: 1000 }),
      row({ biller: "anthropic_subscription", billingType: "subscription_included", model: "opus[1m]", inputTokens: 1_000_000, cachedInputTokens: 10_000_000, outputTokens: 100_000 }),
      row({ provider: "codex", biller: "openai_subscription", billingType: "subscription_included", model: "gpt-6.1-sol", inputTokens: 1_000_000 }),
    ]);
    expect(split.compass.totalCents).toBe(5000);
    expect(split.compass.slices.map((s) => [s.key, s.cents])).toEqual([["opus", 4000], ["gpt-6-astra", 1000]]);
    expect(split.compass.slices[0]!.share).toBeCloseTo(0.8);
    // Opus: 1M input × $4 + 10M cache read × $0.2 + 0.1M output × $20 = $8 = 800¢.
    // GPT-6.1 Sol: 1M input × $2 = 200¢.
    expect(split.subscription.slices.map((s) => [s.key, Math.round(s.cents)])).toEqual([["opus", 800], ["gpt-6.1-sol", 200]]);
    expect(split.subscription.totalCents).toBeCloseTo(1000);
    // A subscription row never leaks into Compass even if the model name is a Compass alias.
    expect(splitModelCosts([row({ billingType: "subscription_included", model: "compass-opus5.5[1m]", outputTokens: 1_000_000 })]).compass.slices).toEqual([]);
  });

  it("lists families without a list price instead of guessing", () => {
    const split = splitModelCosts([
      row({ provider: "google", biller: "google", billingType: "subscription_included", model: "gemini-4-hydrogen-high", inputTokens: 5000 }),
      row({ biller: "anthropic", billingType: "subscription_included", model: "opus", inputTokens: 0 }),
      row({ provider: "codex", model: "compass-6.1-sol", costCents: 0, unpricedEventCount: 3, inputTokens: 10 }),
      row({ provider: "claude", biller: "local", billingType: "fixed", model: "Qwen3.8", costCents: 50, inputTokens: 10 }),
    ]);
    expect(split.subscription.slices).toEqual([]);
    expect(split.subscription.unpriced).toEqual([{ key: "gemini-4-hydrogen", label: "Gemini 4 Hydrogen", tokens: 5000, events: 0 }]);
    expect(split.compass.totalCents).toBe(0);
    expect(split.compass.unpriced).toEqual([{ key: "gpt-6.1-sol", label: "GPT-6.1 Sol", tokens: 10, events: 3 }]);
  });

  it("folds a long tail into Other", () => {
    const models = ["opus", "sonnet", "haiku", "gpt-6-astra", "gpt-6.1-sol", "gpt-6-sol", "gpt-6-luna"];
    const split = splitModelCosts(models.map((model, index) => row({ model: `compass-${model}`, costCents: 100 * (index + 1) })));
    expect(split.compass.slices).toHaveLength(6);
    expect(split.compass.slices.at(-1)!.key).toBe(OTHER_SLICE_KEY);
    expect(split.compass.slices.reduce((sum, s) => sum + s.cents, 0)).toBe(2800);
  });
});

describe("modelCostPeriodStartIso", () => {
  // Sunday 2026-11-15 18:30 local time; process TZ is pinned by the UI test setup or system.
  const now = new Date(2026, 10, 15, 18, 30);
  it("starts year and month on the UTC calendar", () => {
    expect(modelCostPeriodStartIso("year", new Date("2026-11-15T09:00:00Z"))).toBe("2026-01-01T00:00:00.000Z");
    expect(modelCostPeriodStartIso("month", new Date("2026-11-15T09:00:00Z"))).toBe("2026-11-01T00:00:00.000Z");
  });
  it("starts week on local Monday and today at local midnight", () => {
    expect(modelCostPeriodStartIso("week", now)).toBe(new Date(2026, 10, 9).toISOString());
    expect(modelCostPeriodStartIso("week", new Date(2026, 10, 9, 0, 0))).toBe(new Date(2026, 10, 9).toISOString());
    expect(modelCostPeriodStartIso("today", now)).toBe(new Date(2026, 10, 15).toISOString());
  });
});
