// @vitest-environment jsdom
import { act } from "react";
import { createRoot } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { expect, it, vi } from "vitest";
import { queryKeys } from "@/lib/queryKeys";
import { useAttentionViewFeed } from "./useAttentionViews";
import { useCoordinatorAttentionCount } from "./useCoordinatorAttentionCount";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
const mocks = vi.hoisted(() => ({ list: vi.fn(), summary: vi.fn(), pathname: "/HOM/dashboard" }));
vi.mock("@/api/attention", () => ({ attentionApi: mocks }));
vi.mock("./useCoordinatorWorkspaceEnabled", () => ({ useCoordinatorWorkspaceEnabled: () => ({ userId: "reader" }) }));
vi.mock("@/lib/router", () => ({ useLocation: () => ({ pathname: mocks.pathname, search: "" }) }));

it("reuses fresh feed and summary after navigation, but invalidates immediately on live changes", async () => {
  const data = { generatedAt: new Date().toISOString(), items: [], deskBadgeCount: 0 };
  mocks.list.mockResolvedValue(data); mocks.summary.mockResolvedValue(data);
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const container = document.createElement("div");
  const root = createRoot(container);
  function Feed() { useAttentionViewFeed("company", "mine"); return null; }
  function Count() { useCoordinatorAttentionCount("company"); return null; }
  const render = async (show: boolean) => act(async () => {
    root.render(<QueryClientProvider client={client}>{show && <><Feed /><Count /></>}</QueryClientProvider>);
    await new Promise(resolve => setTimeout(resolve, 10));
  });
  try {
    await render(true);
    expect(mocks.list).toHaveBeenCalledTimes(1); expect(mocks.summary).toHaveBeenCalledTimes(1);
    await render(false); await render(true);
    expect(mocks.list).toHaveBeenCalledTimes(1); expect(mocks.summary).toHaveBeenCalledTimes(1);
    // Decisions disables summary; returning enables it without another fresh read.
    mocks.pathname = "/HOM/decisions"; await render(true);
    mocks.pathname = "/HOM/dashboard"; await render(true);
    expect(mocks.summary).toHaveBeenCalledTimes(1);
    await act(async () => { await client.invalidateQueries({ queryKey: queryKeys.attention("company") }); });
    expect(mocks.list).toHaveBeenCalledTimes(2); expect(mocks.summary).toHaveBeenCalledTimes(2);
  } finally { await act(async () => root.unmount()); client.clear(); }
});
