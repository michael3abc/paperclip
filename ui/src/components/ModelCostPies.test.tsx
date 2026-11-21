// @vitest-environment jsdom

import { flushSync } from "react-dom";
import { createRoot, type Root } from "react-dom/client";
import type { ReactNode } from "react";
import type { CostByProviderModel } from "@paperclipai/shared";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ModelCostPie, ModelCostPies, PeriodPicker } from "./ModelCostPies";
import type { ModelCostWhole } from "../lib/model-cost-split";

const query = vi.hoisted(() => ({ data: [] as CostByProviderModel[], error: undefined as Error | undefined }));
vi.mock("@tanstack/react-query", () => ({ useQuery: ({ queryKey }: { queryKey: readonly unknown[] }) =>
  queryKey.includes("by-project") ? { data: [] } : { data: query.data, error: query.error },
}));
vi.mock("@/lib/router", () => ({
  Link: ({ to, children, ...props }: { to: string; children: ReactNode }) => <a href={to} {...props}>{children}</a>,
}));

// eslint-disable-next-line @typescript-eslint/no-explicit-any
(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
  query.data = [];
  query.error = undefined;
  window.localStorage.clear();
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(() => {
  flushSync(() => root.unmount());
  container.remove();
});

function render(whole: ModelCostWhole) {
  flushSync(() => {
    root.render(<ModelCostPie whole={whole} valueLabel="Compass estimate" ariaLabel="Compass cost by model" />);
  });
}

describe("ModelCostPie", () => {
  it("keeps project usage available when model costs fail", () => {
    query.error = new Error("unavailable");
    flushSync(() => root.render(<ModelCostPies companyId="test-company" />));
    expect(container.textContent).toContain("Could not load model costs");
    expect(container.querySelector('[aria-label="Project usage"]')).not.toBeNull();
    expect(container.textContent).toContain("No project usage in this period.");
  });

  it("draws one slice per model with a legend of names, shares and amounts", () => {
    render({
      totalCents: 10000,
      unpriced: [],
      slices: [
        { key: "opus", label: "Opus 5.5", cents: 7500, share: 0.75, color: "var(--chart-series-1)", models: ["compass-opus5.5[1m]"] },
        { key: "gpt-6-astra", label: "GPT-6 Astra", cents: 2500, share: 0.25, color: "var(--chart-series-2)", models: ["compass-6-astra"] },
      ],
    });
    expect(container.querySelector("svg[aria-label='Compass cost by model']")).not.toBeNull();
    expect(container.querySelectorAll("path")).toHaveLength(2);
    const items = [...container.querySelectorAll("li")].map((li) => li.textContent);
    expect(items).toEqual(["Opus 5.575%$75.00", "GPT-6 Astra25%$25.00"]);
    expect(container.querySelector("path title")?.textContent).toContain("Opus 5.5: $75.00 (75%) Compass estimate");
  });

  it("shows the subscription USD estimate and excludes unpriced usage from the chart", () => {
    const subscription = (model: string, outputTokens: number): CostByProviderModel => ({
      provider: "claude",
      biller: "anthropic_subscription",
      billingType: "subscription_included",
      model,
      costCents: 0,
      inputTokens: 0,
      cachedInputTokens: 0,
      outputTokens,
      apiRunCount: 0,
      subscriptionRunCount: 1,
      subscriptionInputTokens: 0,
      subscriptionCachedInputTokens: 0,
      subscriptionOutputTokens: outputTokens,
    });
    query.data = [
      subscription("opus[1m]", 1_000_000),
      subscription("gpt-6-luna", 1_000_000),
      subscription("gemini-4-hydrogen-high", 1_000_000),
    ];
    flushSync(() => root.render(<ModelCostPies companyId="test-company" />));
    const section = [...container.querySelectorAll("section")].find((item) => item.querySelector("h4")?.textContent === "Subscription")!;
    expect(section.textContent).toContain("$20.50");
    expect(section.textContent).toContain("API list-price estimate (USD), not subscription fees or charges");
    expect(section.textContent).toContain("assumes standard processing. Cache writes are not fully itemized.");
    expect(section.querySelector("svg")?.getAttribute("aria-label")).toBe("Subscription API list-price estimate by model in USD");
    expect([...section.querySelectorAll("li")].map((li) => li.textContent)).toEqual([
      "Opus 5.598%$20.00",
      "GPT-6 Luna2%$0.50",
    ]);
    expect(section.textContent).toContain("Unpriced usage, excluded from estimate: Gemini 4 Hydrogen");
    expect(section.textContent).not.toContain("costs $0");
  });

  it("uses a full circle for a single model and an empty state for no usage", () => {
    render({
      totalCents: 100,
      unpriced: [],
      slices: [{ key: "opus", label: "Opus 5.5", cents: 100, share: 1, color: "var(--chart-series-1)", models: ["opus"] }],
    });
    expect(container.querySelectorAll("circle")).toHaveLength(1);
    expect(container.querySelectorAll("path")).toHaveLength(0);

    render({ totalCents: 0, unpriced: [], slices: [] });
    expect(container.textContent).toContain("No priced usage in this period");
  });

  it("labels an unknown-only subscription total unpriced instead of $0", () => {
    query.data = [{
      provider: "google", biller: "google", billingType: "subscription_included", model: "gemini-4-hydrogen-high",
      costCents: 0, inputTokens: 100, cachedInputTokens: 0, outputTokens: 0,
      apiRunCount: 0, subscriptionRunCount: 1, subscriptionInputTokens: 100,
      subscriptionCachedInputTokens: 0, subscriptionOutputTokens: 0,
    }];
    flushSync(() => root.render(<ModelCostPies companyId="test-company" />));
    const section = [...container.querySelectorAll("section")].find((item) => item.querySelector("h4")?.textContent === "Subscription")!;
    expect(section.querySelector("div span")?.textContent).toBe("Unpriced");
    expect(section.textContent).not.toContain("$0.00");
    expect(section.textContent).toContain("Gemini 4 Hydrogen 100 tokens");
    expect(section.querySelector("svg")).toBeNull();
  });

  it("shows unknown same-family usage without charging it at the known member's rate", () => {
    const subscription = (model: string, inputTokens: number): CostByProviderModel => ({
      provider: "claude", biller: "anthropic_subscription", billingType: "subscription_included", model,
      costCents: 0, inputTokens, cachedInputTokens: 0, outputTokens: 0,
      apiRunCount: 0, subscriptionRunCount: 1, subscriptionInputTokens: inputTokens,
      subscriptionCachedInputTokens: 0, subscriptionOutputTokens: 0,
    });
    query.data = [subscription("opus", 1_000_000), subscription("vendor/opus-preview", 100)];
    flushSync(() => root.render(<ModelCostPies companyId="test-company" />));
    const section = [...container.querySelectorAll("section")].find((item) => item.querySelector("h4")?.textContent === "Subscription")!;
    expect(section.querySelector("div span")?.textContent).toBe("$4.00");
    expect(section.querySelector("li")?.getAttribute("title")).toBe("opus");
    expect(section.textContent).toContain("Unpriced usage, excluded from estimate: Opus 5.5 (vendor/opus-preview) 100 tokens");
  });

  it("offers this year, this month, this week and today as periods", () => {
    const picked: string[] = [];
    flushSync(() => {
      root.render(<PeriodPicker value="month" onChange={(period) => picked.push(period)} />);
    });
    const buttons = [...container.querySelectorAll("button")];
    expect(buttons.map((b) => [b.textContent, b.getAttribute("aria-pressed")])).toEqual([
      ["This year", "false"],
      ["This month", "true"],
      ["This week", "false"],
      ["Today", "false"],
    ]);
    flushSync(() => buttons[3]!.click());
    expect(picked).toEqual(["today"]);
  });

  it("switches both pies to token usage, including subscription models without a price, and remembers the choice", () => {
    const usage = (partial: Partial<CostByProviderModel>): CostByProviderModel => ({
      provider: "claude", biller: "compass", billingType: "metered_api", model: "compass-opus5.5",
      costCents: 0, inputTokens: 0, cachedInputTokens: 0, outputTokens: 0,
      apiRunCount: 1, subscriptionRunCount: 0, subscriptionInputTokens: 0,
      subscriptionCachedInputTokens: 0, subscriptionOutputTokens: 0, ...partial,
    });
    query.data = [
      usage({ model: "compass-opus5.5[1m]", costCents: 500, inputTokens: 1_000_000, cachedInputTokens: 2_000_000 }),
      usage({ provider: "google", biller: "google", billingType: "subscription_included", model: "gemini-4-hydrogen-high", inputTokens: 3_000_000 }),
      usage({ biller: "anthropic_subscription", billingType: "subscription_included", model: "claude-sonnet-5-5", outputTokens: 1_000_000 }),
    ];
    flushSync(() => root.render(<ModelCostPies companyId="test-company" />));
    const tokensButton = [...container.querySelectorAll("button")].find((b) => b.textContent === "Tokens")!;
    expect(tokensButton.getAttribute("aria-pressed")).toBe("false");
    flushSync(() => tokensButton.click());
    expect(window.localStorage.getItem("paperclip.dashboard.modelUsageMeasure")).toBe("tokens");

    const section = (name: string) => [...container.querySelectorAll("section")].find((item) => item.querySelector("h4")?.textContent === name)!;
    expect(section("Compass").querySelector("div span")?.textContent).toBe("3.0M tokens");
    expect(section("Subscription").querySelector("div span")?.textContent).toBe("4.0M tokens");
    expect(section("Subscription").querySelector("svg")?.getAttribute("aria-label")).toBe("Subscription tokens by model");
    expect([...section("Subscription").querySelectorAll("li")].map((li) => li.textContent)).toEqual([
      "Gemini 4 Hydrogen75%3.0M",
      "Sonnet 5.525%1.0M",
    ]);
    expect(section("Subscription").textContent).not.toContain("Unpriced");

    flushSync(() => root.unmount());
    root = createRoot(container);
    flushSync(() => root.render(<ModelCostPies companyId="test-company" />));
    expect([...container.querySelectorAll("button")].find((b) => b.textContent === "Tokens")!.getAttribute("aria-pressed")).toBe("true");
  });
});
