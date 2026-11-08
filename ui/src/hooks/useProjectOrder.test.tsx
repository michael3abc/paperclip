// @vitest-environment jsdom

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { CompanySidebarPreference, Project } from "@paperclipai/shared";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { queryKeys } from "../lib/queryKeys";
import { useProjectOrder } from "./useProjectOrder";

const mockSidebarPreferencesApi = vi.hoisted(() => ({
  getProjectOrder: vi.fn(),
  updateProjectOrder: vi.fn(),
}));

vi.mock("../api/sidebarPreferences", () => ({
  sidebarPreferencesApi: mockSidebarPreferencesApi,
}));

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const COMPANY = "company-1";
const USER = "user-1";
const EXCLUDED = ["agent-excluded-1", "agent-excluded-2"];
const projects = [{ id: "project-1" }, { id: "project-2" }, { id: "project-3" }] as Project[];
const key = queryKeys.sidebarPreferences.projectOrder(COMPANY, USER);

function stored(overrides: Partial<CompanySidebarPreference> = {}): CompanySidebarPreference {
  return {
    orderedIds: ["project-1", "project-2", "project-3"],
    excludedPmStatusAgentIds: EXCLUDED,
    updatedAt: "2026-11-08T00:00:00.000Z" as unknown as CompanySidebarPreference["updatedAt"],
    ...overrides,
  };
}

describe("useProjectOrder and the stored PM status exclusions", () => {
  let root: Root;
  let host: HTMLDivElement;
  let client: QueryClient;
  let persistOrder: (ids: string[]) => void;
  // Every value the exclusion list took in the cache, in order, so a transient
  // clear between the optimistic write and the server answer cannot go unseen.
  let observedExclusions: unknown[];
  let unsubscribe: () => void;

  function Harness() {
    persistOrder = useProjectOrder({ projects, companyId: COMPANY, userId: USER }).persistOrder;
    return null;
  }

  const cached = () => client.getQueryData<Partial<CompanySidebarPreference>>(key);

  async function flush() {
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });
  }

  async function mount() {
    await act(async () => {
      root.render(
        <QueryClientProvider client={client}>
          <Harness />
        </QueryClientProvider>,
      );
    });
    await flush();
  }

  beforeEach(() => {
    host = document.createElement("div");
    document.body.append(host);
    root = createRoot(host);
    client = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
    observedExclusions = [];
    unsubscribe = client.getQueryCache().subscribe((event) => {
      if (event.type === "updated" && JSON.stringify(event.query.queryKey) === JSON.stringify(key)) {
        observedExclusions.push((event.query.state.data as Partial<CompanySidebarPreference> | undefined)?.excludedPmStatusAgentIds);
      }
    });
    mockSidebarPreferencesApi.getProjectOrder.mockReset().mockResolvedValue(stored());
    mockSidebarPreferencesApi.updateProjectOrder.mockReset();
  });

  afterEach(() => {
    unsubscribe();
    act(() => root.unmount());
    client.clear();
    host.remove();
  });

  it("keeps the exclusion list in the cache while an order-only update is in flight", async () => {
    let answer: (value: CompanySidebarPreference) => void = () => {};
    mockSidebarPreferencesApi.updateProjectOrder.mockReturnValue(
      new Promise<CompanySidebarPreference>((resolve) => {
        answer = resolve;
      }),
    );
    await mount();
    expect(cached()?.excludedPmStatusAgentIds).toEqual(EXCLUDED);
    observedExclusions.length = 0;

    await act(async () => {
      persistOrder(["project-3", "project-1", "project-2"]);
    });

    // Optimistic order, untouched exclusions, and a legacy order-only payload.
    expect(cached()).toMatchObject({
      orderedIds: ["project-3", "project-1", "project-2"],
      excludedPmStatusAgentIds: EXCLUDED,
    });
    expect(mockSidebarPreferencesApi.updateProjectOrder).toHaveBeenCalledWith(COMPANY, {
      orderedIds: ["project-3", "project-1", "project-2"],
    });

    // The server answers with the full stored row; it becomes the cache entry.
    await act(async () => {
      answer(stored({ orderedIds: ["project-3", "project-1", "project-2"] }));
    });
    await flush();
    expect(cached()).toMatchObject({
      orderedIds: ["project-3", "project-1", "project-2"],
      excludedPmStatusAgentIds: EXCLUDED,
    });
    expect(observedExclusions.length).toBeGreaterThan(0);
    for (const value of observedExclusions) expect(value).toEqual(EXCLUDED);
  });

  it("keeps the exclusion list when the order update fails; there is no rollback to clear it", async () => {
    mockSidebarPreferencesApi.updateProjectOrder.mockRejectedValue(new Error("write refused"));
    await mount();
    observedExclusions.length = 0;

    await act(async () => {
      persistOrder(["project-2", "project-3", "project-1"]);
    });
    await flush();

    expect(mockSidebarPreferencesApi.updateProjectOrder).toHaveBeenCalledTimes(1);
    expect(cached()?.excludedPmStatusAgentIds).toEqual(EXCLUDED);
    expect(observedExclusions.length).toBeGreaterThan(0);
    for (const value of observedExclusions) expect(value).toEqual(EXCLUDED);
  });

  it("keeps an empty stored list empty rather than inventing exclusions", async () => {
    mockSidebarPreferencesApi.getProjectOrder.mockResolvedValue(stored({ excludedPmStatusAgentIds: [] }));
    mockSidebarPreferencesApi.updateProjectOrder.mockResolvedValue(stored({ excludedPmStatusAgentIds: [] }));
    await mount();

    await act(async () => {
      persistOrder(["project-2", "project-1", "project-3"]);
    });
    await flush();

    expect(cached()?.excludedPmStatusAgentIds).toEqual([]);
  });

  it("writes no exclusion list into a cache that never loaded, so readers treat it as unknown", async () => {
    mockSidebarPreferencesApi.getProjectOrder.mockReturnValue(new Promise(() => {}));
    let answer: (value: CompanySidebarPreference) => void = () => {};
    mockSidebarPreferencesApi.updateProjectOrder.mockReturnValue(
      new Promise<CompanySidebarPreference>((resolve) => {
        answer = resolve;
      }),
    );
    await mount();
    expect(cached()).toBeUndefined();

    await act(async () => {
      persistOrder(["project-2", "project-1", "project-3"]);
    });

    // Not an empty list: the field is absent, which the sidebar reads as "not known".
    expect(cached()?.orderedIds).toEqual(["project-2", "project-1", "project-3"]);
    expect(Array.isArray(cached()?.excludedPmStatusAgentIds)).toBe(false);

    await act(async () => {
      answer(stored({ orderedIds: ["project-2", "project-1", "project-3"] }));
    });
    await flush();
    expect(cached()?.excludedPmStatusAgentIds).toEqual(EXCLUDED);
  });
});
