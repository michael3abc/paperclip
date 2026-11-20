// @vitest-environment jsdom

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { ExternalApiCostRow } from "@paperclipai/shared";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ExternalApiUsageTable } from "./ExternalApiUsageTable";

const externalApi = vi.hoisted(() => vi.fn());
vi.mock("../api/costs", () => ({ costsApi: { externalApi } }));

// eslint-disable-next-line @typescript-eslint/no-explicit-any
(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

const row = (overrides: Partial<ExternalApiCostRow> = {}): ExternalApiCostRow => ({
  provider: "serpapi", model: "search", agentId: "agent-1", agentName: "Scout", costCents: 0, costCentsExact: "0.0000000",
  eventCount: 1, estimatedEventCount: 0, unpricedEventCount: 0, inputTokens: 0, outputTokens: 0,
  lastOccurredAt: "2026-11-20T12:00:00.000Z", ...overrides,
});

describe("ExternalApiUsageTable", () => {
  let container: HTMLDivElement;
  let root: Root;
  let client: QueryClient;

  beforeEach(() => {
    externalApi.mockReset();
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

  async function render(from = "2026-11-01T00:00:00.000Z") {
    await act(async () => root.render(<QueryClientProvider client={client}>
      <ExternalApiUsageTable companyId="company-1" from={from} />
    </QueryClientProvider>));
    await act(async () => vi.waitFor(() => expect(container.textContent).not.toContain("Loading external API spend")));
  }

  it("lists self-reported spend by cost with a total and requests the dashboard period", async () => {
    externalApi.mockResolvedValue([
      row({ costCents: 25 }),
      row({ provider: "elevenlabs", model: "tts-v3", agentName: "Writer", costCents: 150, eventCount: 3, estimatedEventCount: 3 }),
      row({ provider: "gemini", model: "imagen", agentId: null, agentName: null, costCents: 0, unpricedEventCount: 1 }),
    ]);
    await render();
    expect(externalApi).toHaveBeenCalledWith("company-1", "2026-11-01T00:00:00.000Z");
    const rows = [...container.querySelectorAll("tbody tr")];
    expect(rows.map(r => r.querySelector("th")?.textContent)).toEqual(["elevenlabs", "serpapi", "gemini"]);
    expect([...rows[0]!.querySelectorAll("td")].map(c => c.textContent)).toEqual(["tts-v3", "Writer", "3", "$1.50Estimated"]);
    expect(rows[2]!.textContent).toContain("No agent");
    expect(rows[2]!.textContent).toContain("1 cost unavailable");
    expect(container.querySelector("h4")?.parentElement?.textContent).toContain("$1.75");
    expect(container.textContent).toContain("Not counted in any project's usage or budget");
  });

  it("states an empty period and surfaces a load failure", async () => {
    externalApi.mockResolvedValueOnce([]);
    await render();
    expect(container.textContent).toContain("No self-reported external API spend in this period.");

    externalApi.mockRejectedValueOnce(new Error("boom"));
    await act(async () => { await client.resetQueries(); });
    await act(async () => vi.waitFor(() => expect(container.textContent).toContain("Could not load external API spend.")));
  });
});
