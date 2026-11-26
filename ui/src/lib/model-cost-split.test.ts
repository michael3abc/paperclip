import { describe, expect, it } from "vitest";
import type { CostByProviderModel } from "@paperclipai/shared";
import { modelColorVar, modelCostPeriodStartIso, modelFamily, OTHER_SLICE_KEY, splitModelCosts, splitModelTokens } from "./model-cost-split";

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
    expect(modelFamily("controller-host/antigravity/gemini-4-argon-high").key).toBe("gemini-4-argon");
    expect(modelFamily("vendor/some-model")).toEqual({ key: "some-model", label: "some-model" });
  });

  it("keeps one color per family regardless of rank", () => {
    expect(modelColorVar("opus")).toBe("var(--chart-series-1)");
    expect(modelColorVar("unknown-model")).toBe("var(--chart-series-other)");
  });
});

describe("splitModelCosts", () => {
  it("keeps Compass spend and estimates subscription usage at API list prices in USD", () => {
    const split = splitModelCosts([
      row({ model: "compass-opus5.5[1m]", costCents: 3000, inputTokens: 10 }),
      row({ model: "compass-opus5.5", costCents: 1000 }),
      row({ provider: "codex", model: "compass-6-astra", costCents: 1000 }),
      row({ biller: "anthropic_subscription", billingType: "subscription_included", model: "opus[1m]", inputTokens: 1_000_000, cachedInputTokens: 5_000_000, outputTokens: 1_000_000 }),
      row({ provider: "codex", biller: "openai_subscription", billingType: "subscription_included", model: "gpt-6.1-sol", inputTokens: 2_000_000 }),
      row({ provider: "google", biller: "google", billingType: "subscription_included", model: "gemini-4-hydrogen-high", inputTokens: 1_000_000 }),
      row({ biller: "anthropic", billingType: "subscription_included", model: "opus", inputTokens: 0 }),
    ]);
    expect(split.compass.totalCents).toBe(5000);
    expect(split.compass.slices.map((s) => [s.key, s.cents])).toEqual([["opus", 4000], ["gpt-6-astra", 1000]]);
    expect(split.compass.slices[0]!.share).toBeCloseTo(0.8);
    expect(split.subscription.totalCents).toBe(2900);
    expect(split.subscription.slices.map((s) => [s.key, s.cents])).toEqual([
      ["opus", 2500],
      ["gpt-6.1-sol", 400],
    ]);
    expect(split.subscription.slices[0]!.share).toBeCloseTo(2500 / 2900);
    expect(split.subscription.unpriced).toEqual([
      { key: "gemini-4-hydrogen", label: "Gemini 4 Hydrogen", tokens: 1_000_000, events: 0 },
    ]);
    // A subscription row never leaks into Compass even if the model name is a Compass alias.
    expect(splitModelCosts([row({ billingType: "subscription_included", model: "compass-opus5.5[1m]", outputTokens: 1_000_000 })]).compass.slices).toEqual([]);
  });

  it("sizes subscription slices by dollars when token counts are equal", () => {
    const { subscription } = splitModelCosts([
      row({ biller: "anthropic_subscription", billingType: "subscription_included", model: "opus", outputTokens: 1_000_000 }),
      row({ provider: "codex", biller: "openai_subscription", billingType: "subscription_included", model: "gpt-6-luna", outputTokens: 1_000_000 }),
    ]);
    expect(subscription.totalCents).toBe(2050);
    expect(subscription.slices.map((slice) => slice.cents)).toEqual([2000, 50]);
    expect(subscription.slices[0]!.share).toBeCloseTo(2000 / 2050);
  });

  it("prices exclusive input, cached input and output exactly once for each subscription provider", () => {
    const { subscription } = splitModelCosts([
      row({ biller: "anthropic_subscription", billingType: "subscription_included", model: "opus", inputTokens: 1_000_000, cachedInputTokens: 5_000_000, outputTokens: 1_000_000 }),
      row({ provider: "codex", biller: "openai_subscription", billingType: "subscription_included", model: "gpt-6.1-sol", inputTokens: 1_000_000, cachedInputTokens: 5_000_000, outputTokens: 1_000_000 }),
    ]);
    // Opus: $4 + $1 + $20; Sol: $2 + $0.50 + $10.
    expect(subscription.totalCents).toBe(3750);
    expect(subscription.slices.map((slice) => [slice.key, slice.cents])).toEqual([
      ["opus", 2500],
      ["gpt-6.1-sol", 1250],
    ]);
  });

  it("keeps unknown subscription models unpriced rather than reporting free usage", () => {
    const { subscription } = splitModelCosts([
      row({ provider: "google", biller: "google", billingType: "subscription_included", model: "gemini-4-argon-high", inputTokens: 40, cachedInputTokens: 20, outputTokens: 10 }),
      row({ biller: "vendor_subscription", billingType: "subscription_included", model: "vendor/new-model", inputTokens: 100 }),
    ]);
    expect(subscription.slices).toEqual([]);
    expect(subscription.unpriced).toEqual([
      { key: "new-model", label: "new-model", tokens: 100, events: 0 },
      { key: "gemini-4-argon", label: "Gemini 4 Argon", tokens: 70, events: 0 },
    ]);
  });

  it("uses exact model rates inside a shared family instead of pricing older Sonnet as 5.5", () => {
    const subscription = (model: string) => row({
      biller: "anthropic_subscription", billingType: "subscription_included", model, cachedInputTokens: 1_000_000,
    });
    expect(splitModelCosts([subscription("claude-sonnet-5")]).subscription.totalCents).toBe(20);
    expect(splitModelCosts([subscription("sonnet")]).subscription.totalCents).toBe(10);
    const combined = splitModelCosts([subscription("claude-sonnet-5"), subscription("sonnet[1m]")]).subscription;
    expect(combined.totalCents).toBeCloseTo(30);
    expect(combined.slices).toHaveLength(1);
    expect(combined.slices[0]!.models).toEqual(["claude-sonnet-5", "sonnet[1m]"]);
    expect(combined.unpriced).toEqual([]);
  });

  it("keeps known older OpenAI model rates while rejecting unknown model variants", () => {
    const subscription = (model: string) => row({
      biller: "openai_subscription", billingType: "subscription_included", model, cachedInputTokens: 1_000_000,
    });
    expect(splitModelCosts([subscription("gpt-5.6-sol")]).subscription.totalCents).toBe(40);
    for (const model of ["gpt-6-astra[1m]", "gpt-6.1-sol-preview", "vendor/gpt-6-astra"]) {
      const whole = splitModelCosts([subscription(model)]).subscription;
      expect(whole.slices, model).toEqual([]);
      expect(whole.unpriced, model).toHaveLength(1);
      expect(whole.unpriced[0]!.tokens, model).toBe(1_000_000);
    }
  });

  it("retains unpriced usage alongside a priced member of the same family in either order", () => {
    const known = row({
      biller: "anthropic_subscription", billingType: "subscription_included", model: "opus", inputTokens: 1_000_000,
    });
    const unknown = row({
      biller: "vendor_subscription", billingType: "subscription_included", model: "vendor/opus-preview", inputTokens: 40, cachedInputTokens: 20, outputTokens: 10,
    });
    for (const rows of [[known, unknown], [unknown, known]]) {
      const whole = splitModelCosts(rows).subscription;
      expect(whole.totalCents).toBe(400);
      expect(whole.slices).toHaveLength(1);
      expect(whole.slices[0]!.models).toEqual(["opus"]);
      expect(whole.unpriced).toEqual([
        { key: "opus", label: "Opus 5.5 (vendor/opus-preview)", tokens: 70, events: 0 },
      ]);
    }
  });

  it("lists unpriced Compass runs instead of guessing", () => {
    const split = splitModelCosts([
      row({ provider: "codex", model: "compass-6.1-sol", costCents: 0, unpricedEventCount: 3, inputTokens: 10 }),
      row({ provider: "claude", biller: "local", billingType: "fixed", model: "Qwen3.8", costCents: 50, inputTokens: 10 }),
    ]);
    expect(split.compass.totalCents).toBe(0);
    expect(split.compass.slices).toEqual([]);
    expect(split.compass.unpriced).toEqual([{ key: "gpt-6.1-sol", label: "GPT-6.1 Sol", tokens: 10, events: 3 }]);
    expect(split.subscription.slices).toEqual([]);
  });

  it("folds a long tail into Other", () => {
    const models = ["opus", "sonnet", "haiku", "gpt-6-astra", "gpt-6.1-sol", "gpt-6-sol", "gpt-6-luna"];
    const split = splitModelCosts(models.map((model, index) => row({ model: `compass-${model}`, costCents: 100 * (index + 1) })));
    expect(split.compass.slices).toHaveLength(6);
    expect(split.compass.slices.at(-1)!.key).toBe(OTHER_SLICE_KEY);
    expect(split.compass.slices.reduce((sum, s) => sum + s.cents, 0)).toBe(2800);
  });
});

describe("splitModelTokens", () => {
  it("sizes both wholes by recorded tokens and keeps models without a price", () => {
    const split = splitModelTokens([
      row({ model: "compass-opus5.5[1m]", costCents: 3000, inputTokens: 100, cachedInputTokens: 300 }),
      row({ model: "compass-opus5.5", outputTokens: 100 }),
      row({ provider: "codex", model: "compass-6-astra", inputTokens: 500 }),
      row({ provider: "google", biller: "google", billingType: "subscription_included", model: "gemini-4-hydrogen-high", inputTokens: 600 }),
      row({ biller: "anthropic_subscription", billingType: "subscription_included", model: "sonnet[1m]", outputTokens: 200 }),
      row({ biller: "anthropic_subscription", billingType: "subscription_included", model: "vendor/sonnet-preview", inputTokens: 200 }),
      row({ biller: "anthropic", billingType: "metered_api", model: "claude-opus-5-5", inputTokens: 999 }),
      row({ billingType: "subscription_included", model: "opus", inputTokens: 0 }),
    ]);
    expect(split.compass.totalTokens).toBe(1000);
    expect(split.compass.slices.map((s) => [s.key, s.tokens, s.share])).toEqual([["gpt-6-astra", 500, 0.5], ["opus", 500, 0.5]]);
    expect(split.compass.slices.find((s) => s.key === "opus")!.models).toEqual(["compass-opus5.5", "compass-opus5.5[1m]"]);
    expect(split.subscription.totalTokens).toBe(1000);
    expect(split.subscription.slices.map((s) => [s.key, s.tokens])).toEqual([["gemini-4-hydrogen", 600], ["sonnet", 400]]);
    expect(split.subscription.slices[0]!.color).toBe(modelColorVar("gemini-4-hydrogen"));
    expect(split.subscription.slices[1]!.models).toEqual(["sonnet[1m]", "vendor/sonnet-preview"]);
  });

  it("folds a long token tail into Other", () => {
    const rows = ["a", "b", "c", "d", "e", "f", "g"].map((model, index) =>
      row({ billingType: "subscription_included", model, inputTokens: 100 - index }));
    const split = splitModelTokens(rows);
    expect(split.subscription.slices).toHaveLength(6);
    expect(split.subscription.slices.at(-1)).toMatchObject({ key: OTHER_SLICE_KEY, tokens: 95 + 94, models: ["f", "g"] });
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
