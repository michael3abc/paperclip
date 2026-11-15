// @vitest-environment jsdom

import { flushSync } from "react-dom";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ModelCostPie } from "./ModelCostPies";
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

  it("uses a full circle for a single model and an empty state for no usage", () => {
    render({
      totalCents: 100,
      unpriced: [],
      slices: [{ key: "opus", label: "Opus 5.5", cents: 100, share: 1, color: "var(--chart-series-1)", models: ["opus"] }],
    });
    expect(container.querySelectorAll("circle")).toHaveLength(1);
    expect(container.querySelectorAll("path")).toHaveLength(0);

    render({ totalCents: 0, unpriced: [], slices: [] });
    expect(container.textContent).toContain("No priced usage this month");
  });
});
