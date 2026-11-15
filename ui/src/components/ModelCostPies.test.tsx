// @vitest-environment jsdom

import { flushSync } from "react-dom";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ModelCostPie, PeriodPicker } from "./ModelCostPies";
import type { ModelCostWhole } from "../lib/model-cost-split";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
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
  it("draws one slice per model with a legend of names, shares and amounts", () => {
    render({
      measure: "cost",
      totalCents: 10000,
      totalTokens: 0,
      unpriced: [],
      slices: [
        { key: "opus", label: "Opus 5.5", cents: 7500, tokens: 0, share: 0.75, color: "var(--chart-series-1)", models: ["compass-opus5.5[1m]"] },
        { key: "gpt-6-astra", label: "GPT-6 Astra", cents: 2500, tokens: 0, share: 0.25, color: "var(--chart-series-2)", models: ["compass-6-astra"] },
      ],
    });
    expect(container.querySelector("svg[aria-label='Compass cost by model']")).not.toBeNull();
    expect(container.querySelectorAll("path")).toHaveLength(2);
    const items = [...container.querySelectorAll("li")].map((li) => li.textContent);
    expect(items).toEqual(["Opus 5.575%$75.00", "GPT-6 Astra25%$25.00"]);
    expect(container.querySelector("path title")?.textContent).toContain("Opus 5.5: $75.00 (75%) Compass estimate");
  });

  it("shows token amounts for a token-sized whole", () => {
    render({
      measure: "tokens",
      totalCents: 0,
      totalTokens: 3_000_000,
      unpriced: [],
      slices: [
        { key: "opus", label: "Opus 5.5", cents: 0, tokens: 2_000_000, share: 2 / 3, color: "var(--chart-series-1)", models: ["opus[1m]"] },
        { key: "gemini-4-hydrogen", label: "Gemini 4 Hydrogen", cents: 0, tokens: 1_000_000, share: 1 / 3, color: "var(--chart-series-5)", models: ["gemini-4-hydrogen-high"] },
      ],
    });
    const items = [...container.querySelectorAll("li")].map((li) => li.textContent);
    expect(items[0]).toMatch(/^Opus 5\.567%2(\.0)?M tokens$/);
    expect(container.textContent).not.toContain("$");
  });

  it("uses a full circle for a single model and an empty state for no usage", () => {
    render({
      measure: "cost",
      totalCents: 100,
      totalTokens: 0,
      unpriced: [],
      slices: [{ key: "opus", label: "Opus 5.5", cents: 100, tokens: 0, share: 1, color: "var(--chart-series-1)", models: ["opus"] }],
    });
    expect(container.querySelectorAll("circle")).toHaveLength(1);
    expect(container.querySelectorAll("path")).toHaveLength(0);

    render({ measure: "cost", totalCents: 0, totalTokens: 0, unpriced: [], slices: [] });
    expect(container.textContent).toContain("No usage in this period");
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
});
