// @vitest-environment jsdom

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { CostByProject } from "@paperclipai/shared";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ProjectUsageTable } from "./ProjectUsageTable";

const byProject = vi.hoisted(() => vi.fn());
vi.mock("../api/costs", () => ({ costsApi: { byProject } }));

// eslint-disable-next-line @typescript-eslint/no-explicit-any
(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

const row = (overrides: Partial<CostByProject> = {}): CostByProject => ({
  projectId: "project-1", projectName: "Research", eventCount: 1, estimatedEventCount: 0,
  costCents: 0, inputTokens: 100, cachedInputTokens: 50, outputTokens: 10, ...overrides,
});

describe("ProjectUsageTable", () => {
  let container: HTMLDivElement;
  let root: Root;
  let client: QueryClient;

  beforeEach(() => {
    byProject.mockReset();
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
    client = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0 } } });
  });

  afterEach(() => {
    act(() => root.unmount());
    client.clear();
    container.remove();
  });

  async function render(companyId = "company-1", from = "2026-11-01T00:00:00.000Z") {
    await act(async () => root.render(<QueryClientProvider client={client}>
      <ProjectUsageTable companyId={companyId} from={from} />
    </QueryClientProvider>));
    await act(async () => vi.waitFor(() => expect(container.textContent).not.toContain("Loading project usage")));
  }

  it("counts ordinary input and cache once, sorts by tokens and retains unattributed usage", async () => {
    byProject.mockResolvedValue([
      row({ costCents: 125, estimatedEventCount: 1 }),
      row({ projectId: null, projectName: null, inputTokens: 200, cachedInputTokens: 0, outputTokens: 0 }),
    ]);
    await render();
    const rows = [...container.querySelectorAll("tbody tr")];
    expect(rows.map(r => r.querySelector("th")?.textContent)).toEqual(["Unattributed", "Research"]);
    expect([...rows[1]!.querySelectorAll("td")].map(c => c.textContent)).toEqual(["100", "50", "10", "160", "$1.25Estimated"]);
    expect(rows[1]!.querySelectorAll("td")[3]!.getAttribute("title")).toBe("160 tokens");
    expect(container.textContent).toContain("Input (uncached)");
    expect(container.textContent).toContain("Recorded spend excludes subscription API estimates and monthly fees");
  });

  it("uses distinct company and period reads without showing the prior scope", async () => {
    byProject.mockResolvedValueOnce([row()]);
    await render();
    expect(byProject).toHaveBeenLastCalledWith("company-1", "2026-11-01T00:00:00.000Z");
    byProject.mockResolvedValueOnce([row({ projectName: "New period" })]);
    await render("company-1", "2026-11-16T00:00:00.000Z");
    expect(byProject).toHaveBeenLastCalledWith("company-1", "2026-11-16T00:00:00.000Z");
    expect(container.textContent).not.toContain("Research");
    byProject.mockResolvedValueOnce([row({ projectName: "Other company" })]);
    await render("company-2", "2026-11-16T00:00:00.000Z");
    expect(byProject).toHaveBeenLastCalledWith("company-2", "2026-11-16T00:00:00.000Z");
    expect(container.textContent).not.toContain("New period");
  });

  it("distinguishes empty usage from a failed read", async () => {
    byProject.mockResolvedValueOnce([]);
    await render();
    expect(container.textContent).toContain("No project usage in this period.");
    byProject.mockRejectedValueOnce(new Error("unavailable"));
    await render("company-2");
    expect(container.textContent).toContain("Could not load project usage.");
    expect(container.textContent).not.toContain("No project usage in this period.");
    expect(container.querySelector("table")).toBeNull();
  });

  it("retains and labels the last loaded rows when refresh fails", async () => {
    byProject.mockResolvedValueOnce([row()]);
    await render();
    byProject.mockRejectedValueOnce(new Error("unavailable"));
    await act(async () => client.invalidateQueries({ queryKey: ["costs", "company-1"] }));
    await act(async () => vi.waitFor(() => expect(container.textContent).toContain("Could not refresh project usage. Showing the last loaded data.")));
    expect(container.querySelector("tbody th")?.textContent).toBe("Research");
  });
});
