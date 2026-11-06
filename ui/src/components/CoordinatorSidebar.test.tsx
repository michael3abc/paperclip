// @vitest-environment jsdom
import { act, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AttentionFeed, AttentionItem } from "@paperclipai/shared";
import { CoordinatorSidebar } from "./CoordinatorSidebar";
import { TooltipProvider } from "./ui/tooltip";
import { coordinatorAttentionQueryKey, coordinatorAttentionSummaryQueryKey } from "@/lib/coordinator-attention";
import { queryKeys } from "@/lib/queryKeys";
import { PrimaryAgentPresentationProvider } from "./primary-agent/PrimaryAgentPresentation";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
type FixtureAgent = { id: string; name: string; role: "ceo" | "pm" | "engineer" | "general"; urlKey?: string; icon?: string | null; status: string; adapterType?: string };
const fixture = vi.hoisted(() => ({ attention: vi.fn(), summary: vi.fn(), openNewIssue: vi.fn(), ensureChat: vi.fn(), listMemberships: vi.fn(), refetchAgents: vi.fn(), liveRuns: vi.fn(), openWork: vi.fn(), pathname: "/COO/issues", collapsed: false, userId: "reviewer",
  chats: [] as Array<{ id?: string; isUnreadForMe: boolean; conversationAgentId?: string; conversationState?: "active" | "waiting" | null; updatedAt?: string }>,
  primaryAgentId: null as string | null, primaryCompanyId: "company",
  agents: [] as FixtureAgent[], agentsState: {} as { isError?: boolean; isPending?: boolean; fetchStatus?: string } }));
vi.mock("@/hooks/useAgentChatNavigation", () => ({ useAgentChatNavigation: () => ({
  companyId: "company", userId: fixture.userId,
  agents: { data: fixture.agentsState.isError || fixture.agentsState.isPending ? undefined : fixture.agents, refetch: fixture.refetchAgents, ...fixture.agentsState },
  chats: { data: fixture.chats }, session: { isSuccess: true },
}) }));
vi.mock("@/api/resourceMemberships", () => ({ resourceMembershipsApi: { listMine: fixture.listMemberships } }));
vi.mock("@/api/agentChats", () => ({ agentChatsApi: { ensure: fixture.ensureChat } }));
vi.mock("@/api/heartbeats", () => ({ heartbeatsApi: { liveRunsForCompany: fixture.liveRuns } }));
vi.mock("@/api/issues", () => ({ issuesApi: { listCompact: fixture.openWork } }));
vi.mock("@/hooks/useRecentTasks", () => ({ useRecentTasks: () => ({ entries: [] }) }));
vi.mock("@/context/DialogContext", () => ({ useDialogActions: () => ({ openNewIssue: fixture.openNewIssue }) }));
vi.mock("@/context/SidebarContext", () => ({ useSidebar: () => ({ collapsed: fixture.collapsed, peeking: false, isMobile: false, setSidebarOpen: vi.fn() }) }));
vi.mock("@/api/attention", () => ({ attentionApi: { list: fixture.attention, summary: fixture.summary } }));
vi.mock("@/api/projects", () => ({ projectsApi: { list: async () => [] } }));
vi.mock("./SidebarCompanyMenu", () => ({ SidebarCompanyMenu: () => null }));
vi.mock("@/lib/router", () => ({
  useLocation: () => ({ pathname: fixture.pathname, search: "" }),
  Link: ({ to, children, ...props }: { to: string; children: ReactNode }) => <a href={to} {...props}>{children}</a>,
  NavLink: ({ to, children, className, state: _state, end: _end, ...props }: {
    to: string; children: ReactNode; className?: string | ((state: { isActive: boolean }) => string); state?: unknown; end?: boolean;
  }) => <a href={to} className={typeof className === "function" ? className({ isActive: false }) : className} {...props}>{children}</a>,
}));

const pending = (id: string) => ({ id, sourceKind: "issue_thread_interaction", subject: { id, kind: "interaction", status: "pending" },
  createdAt: "2026-10-20T12:00:00Z", activityAt: "2026-10-20T12:00:00Z" }) as AttentionItem;
function feed(items: AttentionItem[]): AttentionFeed {
  return { companyId: "company", generatedAt: "2026-10-27T12:00:00Z", totalCount: items.length, deskBadgeCount: 0,
    nextCursor: null, countsBySourceKind: {} as AttentionFeed["countsBySourceKind"], items };
}

function summary(items: AttentionItem[]) {
  const { items: _items, nextCursor: _cursor, ...counts } = feed(items);
  return counts;
}

let root: Root, container: HTMLDivElement, client: QueryClient;
beforeEach(() => {
  vi.clearAllMocks(); localStorage.clear(); fixture.collapsed = false; fixture.userId = "reviewer"; fixture.pathname = "/COO/issues";
  fixture.chats = []; fixture.agents = []; fixture.agentsState = {};
  fixture.primaryAgentId = null; fixture.primaryCompanyId = "company";
  fixture.listMemberships.mockResolvedValue({ agentMemberships: {}, projectMemberships: {} });
  fixture.liveRuns.mockResolvedValue([]); fixture.openWork.mockResolvedValue([]);
  fixture.summary.mockResolvedValue(summary([pending("question"), pending("review")]));
  container = document.createElement("div"); document.body.appendChild(container); root = createRoot(container);
  client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
});

describe("Coordinator task creation", () => {
  it.each([false, true])("opens global search from the organization header when collapsed is %s", async collapsed => {
    fixture.collapsed = collapsed;
    await renderSidebar();
    const listener = vi.fn();
    document.addEventListener("keydown", listener);
    try {
      const button = container.querySelector<HTMLButtonElement>('.design-sidebar-brand button[aria-label="Global search"]');
      expect(button).not.toBeNull();
      await act(async () => button!.click());
      expect(listener).toHaveBeenCalledWith(expect.objectContaining({ key: "k", metaKey: true }));
    } finally { document.removeEventListener("keydown", listener); }
  });
  it.each([false, true])("opens the task form from New task above Chat when collapsed is %s", async (collapsed) => {
    fixture.collapsed = collapsed;
    await renderSidebar();
    const button = container.querySelector<HTMLButtonElement>('button[aria-label="New task"]');
    const chat = container.querySelector('a[href="/chats"]');
    expect(button).not.toBeNull();
    expect(chat).not.toBeNull();
    expect(button!.compareDocumentPosition(chat!) & Node.DOCUMENT_POSITION_FOLLOWING).not.toBe(0);
    expect(fixture.openNewIssue).not.toHaveBeenCalled();
    await act(async () => button!.click());
    expect(fixture.openNewIssue).toHaveBeenCalledOnce();
  });
});

describe("Coordinator pinned pages", () => {
  it("announces unread chat totals in expanded and collapsed navigation", async () => {
    fixture.chats = [{ isUnreadForMe: true }, { isUnreadForMe: false }, { isUnreadForMe: true }];
    await renderSidebar();
    expect(container.querySelector('a[href="/chats"] [aria-label="2 unread chats"]')).not.toBeNull();
    fixture.collapsed = true;
    await renderSidebar();
    expect(container.querySelector('a[href="/chats"]')?.getAttribute("aria-label")).toBe("Chat, 2 unread chats");
  });
  const pinnedPages = () => container.querySelector('[aria-label="Pinned pages"]');
  async function click(label: string) {
    const button = document.querySelector<HTMLButtonElement>(`button[aria-label="${label}"]`);
    expect(button).not.toBeNull();
    await act(async () => button!.click());
    await flush();
  }

  it("pins from More without navigating, restores after remount, and unpins from the sidebar", async () => {
    await renderSidebar();
    expect(pinnedPages()).toBeNull();
    await click("More workspace pages");
    expect(document.activeElement).toBe(document.querySelector('[data-slot="popover-content"]'));
    await click("Pin Projects");
    expect(document.querySelector('[role="dialog"]')).not.toBeNull();
    expect(pinnedPages()?.querySelector('a[href="/projects"]')?.textContent).toBe("Projects");
    await act(async () => root.unmount());
    root = createRoot(container);
    await renderSidebar();
    expect(pinnedPages()?.querySelector('a[href="/projects"]')).not.toBeNull();
    await click("Unpin Projects");
    expect(pinnedPages()).toBeNull();
  });

  it("keeps pins personal and only renders known destinations", async () => {
    localStorage.setItem("paperclip.coordinator.pinned-nav.v1:reviewer", JSON.stringify(["/projects", "/unknown", "https://example.com"]));
    await renderSidebar();
    expect(pinnedPages()?.querySelectorAll("a")).toHaveLength(1);
    fixture.userId = "other-user";
    await renderSidebar();
    expect(pinnedPages()).toBeNull();
    fixture.userId = "reviewer";
    await renderSidebar();
    expect(pinnedPages()?.textContent).toContain("Projects");
  });

  it("reflects pins changed in another browser tab", async () => {
    await renderSidebar();
    const key = "paperclip.coordinator.pinned-nav.v1:reviewer";
    await act(async () => {
      localStorage.setItem(key, JSON.stringify(["/agents/all"]));
      window.dispatchEvent(new StorageEvent("storage", { key }));
    });
    expect(pinnedPages()?.querySelector('a[href="/agents/all"]')?.textContent).toBe("Agents");
  });
});
afterEach(async () => { await act(async () => root.unmount()); client.clear(); container.remove(); });
async function flush() { await act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)); }); }
async function renderSidebar() {
  await act(async () => root.render(<QueryClientProvider client={client}><PrimaryAgentPresentationProvider value={{
    companyId: fixture.primaryCompanyId, primaryAgentId: fixture.primaryAgentId, primaryAgent: null, onChange: () => {},
  }}><TooltipProvider><CoordinatorSidebar /></TooltipProvider></PrimaryAgentPresentationProvider></QueryClientProvider>));
  await flush();
}
const decisionLink = () => container.querySelector('a[href="/decisions"]')!;

describe("Coordinator agents section", () => {
  const roster: FixtureAgent[] = [
    { id: "a-zed", name: "Zed", role: "pm", urlKey: "zed", icon: "bot", status: "idle" },
    { id: "a-amy", name: "amy", role: "pm", urlKey: "amy", icon: "bot", status: "running" },
    { id: "a-old", name: "Retired", role: "ceo", urlKey: "retired", status: "terminated" },
    { id: "a-left", name: "Left", role: "pm", urlKey: "left", status: "idle" },
    { id: "a-sp", name: "Space Name", role: "pm", urlKey: "space name", status: "paused" },
    { id: "a-svc", name: "Delivery", role: "ceo", urlKey: "delivery", status: "idle", adapterType: "process" },
    { id: "a-ceo", name: "momo", role: "ceo", urlKey: "momo", status: "idle", adapterType: "paperclip_runner" },
    { id: "a-worker", name: "PM coding worker", role: "engineer", urlKey: "worker", status: "running" },
  ];
  const section = () => container.querySelector('.design-sidebar-agents');
  const rows = () => [...section()?.querySelectorAll("a") ?? []];

  it("lists CEO and PM roles between More and Recents, including paused PMs, with no worker expansion", async () => {
    fixture.agents = roster;
    fixture.listMemberships.mockResolvedValue({ agentMemberships: { "a-left": "left" }, projectMemberships: {} });
    fixture.chats = [{ id: "chat-zed", isUnreadForMe: false, conversationAgentId: "a-zed", updatedAt: "2026-11-05T01:00:00Z" }];
    await renderSidebar();
    expect(section()?.textContent).toContain("Agents");
    // Each row carries that agent's own avatar rather than a generic role icon.
    expect(rows().every(row => row.querySelector('[data-slot="agent-avatar"] img') !== null)).toBe(true);
    expect(rows().map(row => [row.textContent, row.getAttribute("href")])).toEqual([
      ["amy", "/chats/amy"], ["momo", "/chats/momo"], ["Space Name", `/chats/${encodeURIComponent("space name")}`], ["Zed", "/chats/zed"],
    ]);
    expect(section()?.textContent).not.toContain("worker");
    expect(section()?.querySelector('[aria-expanded]')).toBeNull();
    const more = container.querySelector('button[aria-label="More workspace pages"]')!;
    const recents = container.querySelector('[aria-label="Recents"]')!;
    expect(more.compareDocumentPosition(section()!) & Node.DOCUMENT_POSITION_FOLLOWING).not.toBe(0);
    expect(recents.compareDocumentPosition(section()!) & Node.DOCUMENT_POSITION_PRECEDING).not.toBe(0);
  });

  it("keeps a general-role primary agent visible without exposing other general agents or workers", async () => {
    fixture.agents = [
      ...roster.map(agent => agent.id === "a-ceo" ? { ...agent, role: "general" as const } : agent),
      { id: "a-helper", name: "Other general agent", role: "general", status: "idle" },
    ];
    fixture.primaryAgentId = "a-ceo";
    await renderSidebar();
    expect(rows().map(row => row.textContent)).toEqual(["momo", "amy", "Left", "Space Name", "Zed"]);
    expect(section()?.textContent).not.toContain("Other general agent");
    expect(section()?.textContent).not.toContain("worker");
    expect(section()?.querySelector('[aria-expanded]')).toBeNull();

    fixture.primaryCompanyId = "another-company";
    await renderSidebar();
    expect(rows().map(row => row.textContent)).not.toContain("momo");
    fixture.primaryCompanyId = "company";
    fixture.primaryAgentId = null;
    await renderSidebar();
    expect(rows().map(row => row.textContent)).not.toContain("momo");
  });

  it.each(["terminated", "process", "left"])("does not bypass the %s visibility restriction for a primary agent", async restriction => {
    fixture.agents = [{ id: "a-primary", name: "Primary", role: "general", status: restriction === "terminated" ? "terminated" : "idle", adapterType: restriction === "process" ? "process" : "paperclip_runner" }];
    fixture.primaryAgentId = "a-primary";
    if (restriction === "left") fixture.listMemberships.mockResolvedValue({ agentMemberships: { "a-primary": "left" }, projectMemberships: {} });
    await renderSidebar();
    expect(rows()).toHaveLength(0);
  });

  it("keeps terminated agents out and does not create a chat when a row is opened", async () => {
    fixture.agents = roster;
    await renderSidebar();
    expect(rows().map(row => row.textContent)).not.toContain("Retired");
    // Command-only service agents are not chat partners; the CEO runner agent still is.
    expect(rows().map(row => row.textContent)).not.toContain("Delivery");
    await act(async () => rows()[0]!.click());
    expect(fixture.ensureChat).not.toHaveBeenCalled();
  });

  it("marks the open chat and flags unread conversations per agent", async () => {
    fixture.agents = roster;
    fixture.pathname = "/COO/chats/amy";
    fixture.chats = [
      { id: "chat-amy", isUnreadForMe: false, conversationAgentId: "a-amy" },
      { id: "chat-zed", isUnreadForMe: true, conversationAgentId: "a-zed" },
    ];
    await renderSidebar();
    const byLabel = (label: string) => rows().find(row => row.textContent?.startsWith(label))!;
    expect(byLabel("amy").className).toContain("bg-sidebar-accent text-sidebar-accent-foreground");
    expect(byLabel("Zed").className).not.toContain("bg-sidebar-accent text-sidebar-accent-foreground");
    expect(byLabel("Zed").querySelector('[aria-label="1 unread chat"]')).not.toBeNull();
    expect(byLabel("amy").querySelector('[data-slot="badge"]')).toBeNull();
  });

  describe("working outline", () => {
    const WORKING_RING = "ring-(--dashboard-run-accent)";
    const byLabel = (label: string) => rows().find(row => row.textContent?.startsWith(label))!;
    const workingLabels = () => rows().filter(row => row.className.includes(WORKING_RING)).map(row => row.textContent!.replace(/working$/, ""));

    it("outlines no one when nothing is running", async () => {
      fixture.agents = roster;
      await renderSidebar();
      expect(workingLabels()).toEqual([]);
      expect(section()?.textContent).not.toContain("working");
    });

    it("outlines an agent with a live run and labels it for assistive tech", async () => {
      fixture.agents = roster;
      fixture.liveRuns.mockResolvedValue([{ id: "run-1", agentId: "a-zed" }]);
      await renderSidebar();
      expect(workingLabels()).toEqual(["Zed"]);
      expect(byLabel("Zed").querySelector(".sr-only")?.textContent).toBe("working");
      expect(byLabel("amy").querySelector(".sr-only")).toBeNull();
    });

    it("outlines the PM above a running worker sub-task while keeping the worker hidden", async () => {
      fixture.agents = roster;
      fixture.openWork.mockResolvedValue([
        { id: "req", status: "blocked", assigneeAgentId: "a-amy", parentId: null },
        { id: "child", status: "in_progress", assigneeAgentId: "a-worker", parentId: "req" },
        { id: "idle", status: "todo", assigneeAgentId: "a-ceo", parentId: null },
      ]);
      await renderSidebar();
      expect(workingLabels()).toEqual(["amy"]);
      expect(fixture.openWork).toHaveBeenCalledWith("company", expect.objectContaining({ projection: "index", status: expect.stringContaining("in_progress") }));
    });

    it("does not treat an open chat conversation as running work", async () => {
      fixture.agents = roster;
      fixture.chats = [{ id: "chat-amy", isUnreadForMe: false, conversationAgentId: "a-amy", conversationState: "waiting" }];
      fixture.openWork.mockResolvedValue([{ id: "chat-amy", status: "in_progress", assigneeAgentId: "a-amy", parentId: null }]);
      await renderSidebar();
      expect(workingLabels()).toEqual([]);
    });

    it("outlines an agent that is answering its chat right now", async () => {
      fixture.agents = roster;
      fixture.chats = [{ id: "chat-amy", isUnreadForMe: false, conversationAgentId: "a-amy", conversationState: "active" }];
      await renderSidebar();
      expect(workingLabels()).toEqual(["amy"]);
    });

    it("keeps the unread badge and the open-chat highlight on a working row", async () => {
      fixture.agents = roster;
      fixture.pathname = "/COO/chats/zed";
      fixture.chats = [{ id: "chat-zed", isUnreadForMe: true, conversationAgentId: "a-zed" }];
      fixture.liveRuns.mockResolvedValue([{ id: "run-1", agentId: "a-zed" }]);
      await renderSidebar();
      const zed = byLabel("Zed");
      expect(zed.className).toContain(WORKING_RING);
      expect(zed.className).toContain("bg-sidebar-accent text-sidebar-accent-foreground");
      expect(zed.querySelector('[aria-label="1 unread chat"]')).not.toBeNull();
    });

    it("says so, with a retry, when activity cannot be loaded", async () => {
      fixture.agents = roster;
      fixture.openWork.mockRejectedValue(new Error("boom"));
      await renderSidebar();
      const alert = section()?.querySelector('[role="alert"]');
      expect(alert?.textContent).toContain("Couldn’t load agent activity");
      expect(rows().length).toBeGreaterThan(0);
      fixture.openWork.mockResolvedValue([{ id: "t", status: "in_progress", assigneeAgentId: "a-zed", parentId: null }]);
      await act(async () => alert!.querySelector("button")!.click());
      await flush();
      expect(section()?.querySelector('[role="alert"]')).toBeNull();
      expect(workingLabels()).toEqual(["Zed"]);
    });
  });

  it("shows a retryable error instead of an empty section when agents fail to load", async () => {
    fixture.agentsState = { isError: true };
    await renderSidebar();
    const alert = section()?.querySelector('[role="alert"]');
    expect(alert?.textContent).toContain("Couldn’t load agents");
    await act(async () => alert!.querySelector("button")!.click());
    expect(fixture.refetchAgents).toHaveBeenCalledOnce();
  });

  it("shows loading while the first agents read is in flight", async () => {
    fixture.agentsState = { isPending: true, fetchStatus: "fetching" };
    await renderSidebar();
    expect(section()?.querySelector('[role="status"]')?.textContent).toContain("Loading agents");
  });

  it("renders nothing without agents and is hidden in the collapsed rail", async () => {
    await renderSidebar();
    expect(section()).toBeNull();
    fixture.agents = roster;
    fixture.collapsed = true;
    await renderSidebar();
    expect(section()).toBeNull();
  });
});

describe("Coordinator Needs You badge", () => {
  it("counts every canonical outstanding decision even when none arrived today", async () => {
    // Personal page filters and completed receipts are separate cache entries.
    client.setQueryData([...coordinatorAttentionQueryKey("company"), { search: "no match" }], feed([]));
    client.setQueryData([...queryKeys.attention("company"), "history", "recent"], { items: [{ id: "answered-question" }] });
    await renderSidebar();
    expect(fixture.attention).not.toHaveBeenCalled();
    expect(client.getQueryData(coordinatorAttentionQueryKey("company"))).toBeUndefined();
    expect(fixture.summary).toHaveBeenCalledWith("company");
    expect(decisionLink().querySelector('[data-slot="badge"]')?.textContent).toBe("2");
  });

  it("updates after canonical attention refreshes and removes the badge once every decision is resolved", async () => {
    await renderSidebar();
    fixture.summary.mockResolvedValue(summary([pending("review")]));
    await act(async () => { await client.invalidateQueries({ queryKey: queryKeys.attention("company") }); });
    await flush();
    expect(decisionLink().querySelector('[data-slot="badge"]')?.textContent).toBe("1");
    fixture.summary.mockResolvedValue(summary([]));
    client.setQueryData([...queryKeys.attention("company"), "history", "recent"], { items: [{ id: "answered-question" }, { id: "accepted-review" }] });
    await act(async () => { await client.invalidateQueries({ queryKey: queryKeys.attention("company") }); });
    await flush();
    expect(decisionLink().querySelector('[data-slot="badge"]')).toBeNull();
    expect(decisionLink().textContent).toBe("Needs you");
  });

  it("announces the full outstanding count when the sidebar is collapsed", async () => {
    fixture.collapsed = true;
    await renderSidebar();
    expect(decisionLink().getAttribute("aria-label")).toBe("Needs you, 2 decisions");
  });
});


describe("Coordinator collection reads", () => {
  it("does not replace a resolved count with an older summary that arrives later", async () => {
    const key = coordinatorAttentionSummaryQueryKey("company");
    client.setQueryDefaults(key, { staleTime: Infinity });
    client.setQueryData(key, { ...summary([pending("old")]), generatedAt: "2026-10-27T12:00:00Z" }, { updatedAt: 20 });
    client.setQueryData(coordinatorAttentionQueryKey("company"), { ...feed([]), generatedAt: "2026-10-27T12:01:00Z" }, { updatedAt: 10 });
    await renderSidebar();
    expect(decisionLink().querySelector('[data-slot="badge"]')).toBeNull();
  });

  it("keeps a newer resolved count when returning to a cached navigation summary", async () => {
    const key = coordinatorAttentionSummaryQueryKey("company");
    client.setQueryDefaults(key, { staleTime: Infinity });
    client.setQueryData(key, summary([pending("old")]), { updatedAt: 1 });
    client.setQueryData(coordinatorAttentionQueryKey("company"), feed([]), { updatedAt: 2 });
    await renderSidebar();
    expect(decisionLink().querySelector('[data-slot="badge"]')).toBeNull();
    expect(fixture.summary).not.toHaveBeenCalled();
    expect(fixture.attention).not.toHaveBeenCalled();
  });

  it("reuses the page-owned complete feed on Needs You without a second summary read", async () => {
    fixture.pathname = "/COO/decisions";
    client.setQueryData(coordinatorAttentionQueryKey("company"), feed([pending("review")]));
    await renderSidebar();
    expect(fixture.summary).not.toHaveBeenCalled();
    expect(fixture.attention).not.toHaveBeenCalled();
    expect(decisionLink().querySelector('[data-slot="badge"]')?.textContent).toBe("1");
    await act(async () => client.setQueryData(coordinatorAttentionQueryKey("company"), feed([])));
    await flush();
    expect(decisionLink().querySelector('[data-slot="badge"]')).toBeNull();
  });
});
