// @vitest-environment jsdom
import { act, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { QueryClient, QueryClientProvider, useQuery } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Agent, AttentionFeed, AttentionItem, IssueSummary, Project } from "@paperclipai/shared";
import { buildPinnedNavigationItems, CoordinatorSidebar } from "./CoordinatorSidebar";
import { TooltipProvider } from "./ui/tooltip";
import { coordinatorAttentionQueryKey, coordinatorAttentionSummaryQueryKey, coordinatorAttentionTasksQueryKey } from "@/lib/coordinator-attention";
import { attentionApi } from "@/api/attention";
import { queryKeys } from "@/lib/queryKeys";
import { PrimaryAgentPresentationProvider } from "./primary-agent/PrimaryAgentPresentation";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
type FixtureAgent = { id: string; name: string; role: Agent["role"]; urlKey?: string; icon?: string | null; status: string; adapterType?: string };
const fixture = vi.hoisted(() => { const openWork = vi.fn(); return ({ attention: vi.fn(), summary: vi.fn(), openNewIssue: vi.fn(), ensureChat: vi.fn(), listMemberships: vi.fn(), refetchAgents: vi.fn(), liveRuns: vi.fn(), openWork, projectTasks: openWork, pathname: "/COO/issues", collapsed: false, userId: "reviewer" as string | null, search: "", recentTasks: [] as Array<Record<string, unknown>>, taskSummaries: [] as Array<Record<string, unknown>>, projects: [] as Array<Record<string, unknown>>, enableCases: false, enableResponsibilities: false,
  pmWorkspaces: vi.fn(), preferences: vi.fn(), pushToast: vi.fn(),
  chats: [] as Array<{ id?: string; isUnreadForMe: boolean; conversationAgentId?: string; conversationState?: "active" | "waiting" | null; updatedAt?: string; hasLiveChildTasks?: boolean; hasRunningSubagents?: boolean; runningSubagentsUntil?: string | null }>,
  primaryAgentId: null as string | null, primaryCompanyId: "company",
  agents: [] as FixtureAgent[], agentsState: {} as { isError?: boolean; isPending?: boolean; fetchStatus?: string } }); });

vi.mock("@/hooks/useAgentChatNavigation", () => ({ useAgentChatNavigation: () => ({
  companyId: "company", userId: fixture.userId,
  agents: { data: fixture.agentsState.isError || fixture.agentsState.isPending ? undefined : fixture.agents, refetch: fixture.refetchAgents, ...fixture.agentsState },
  chats: { data: fixture.chats }, session: { isSuccess: true },
}) }));
vi.mock("@/api/resourceMemberships", () => ({ resourceMembershipsApi: { listMine: fixture.listMemberships } }));
vi.mock("@/api/agentChats", () => ({ agentChatsApi: { ensure: fixture.ensureChat } }));
vi.mock("@/api/heartbeats", () => ({ heartbeatsApi: { liveRunsForCompany: fixture.liveRuns } }));
vi.mock("@/api/agents", () => ({ agentsApi: { listPmWorkspaces: fixture.pmWorkspaces } }));
vi.mock("@/api/sidebarPreferences", () => ({ sidebarPreferencesApi: { getProjectOrder: fixture.preferences } }));
vi.mock("@/context/ToastContext", () => ({ useToastActions: () => ({ pushToast: fixture.pushToast }) }));
vi.mock("@/api/issues", () => ({ issuesApi: { list: fixture.projectTasks, listCompact: fixture.openWork } }));
vi.mock("@/hooks/useRecentTasks", () => ({ useRecentTasks: ({ pinnedTaskIds }: { pinnedTaskIds: string[] }) => ({ entries: fixture.recentTasks, pinnedTasks: fixture.taskSummaries.filter(task => pinnedTaskIds.includes(String(task.id))) }) }));
vi.mock("@/hooks/useCoordinatorWorkspaceEnabled", () => ({ useCoordinatorWorkspaceEnabled: () => ({ enabled: true, userId: fixture.userId }) }));
const taskPrefetch = vi.hoisted(() => vi.fn(() => Promise.resolve()));
vi.mock("@/lib/issueDetailCache", async (importOriginal) => ({
  ...await importOriginal<typeof import("@/lib/issueDetailCache")>(),
  prefetchIssueDetailForNavigation: taskPrefetch,
}));

vi.mock("@/context/DialogContext", () => ({ useDialogActions: () => ({ openNewIssue: fixture.openNewIssue }) }));
vi.mock("@/context/SidebarContext", () => ({ useSidebar: () => ({ isMobile: false, setSidebarOpen: vi.fn() }) }));
vi.mock("@/api/attention", () => ({ attentionApi: { list: fixture.attention, summary: fixture.summary } }));
vi.mock("@/api/instanceSettings", () => ({ instanceSettingsApi: { getExperimental: async () => ({ enableCases: fixture.enableCases, enableResponsibilities: fixture.enableResponsibilities }) } }));
vi.mock("@/api/projects", () => ({ projectsApi: { list: async () => fixture.projects } }));
vi.mock("./SidebarCompanyMenu", () => ({ SidebarCompanyMenu: () => null }));
vi.mock("@/lib/router", () => ({
  useLocation: () => ({ pathname: fixture.pathname, search: fixture.search }),
  Link: ({ to, children, ...props }: { to: string; children: ReactNode }) => <a href={to} {...props}>{children}</a>,
  NavLink: ({ to, children, className, state: _state, end: _end, ...props }: {
    to: string; children: ReactNode; className?: string | ((state: { isActive: boolean }) => string); state?: unknown; end?: boolean;
  }) => <a href={to} className={typeof className === "function" ? className({ isActive: false }) : className} {...props}>{children}</a>,
}));

const pending = (id: string) => ({ id, sourceKind: "issue_thread_interaction", subject: { id, kind: "interaction", status: "pending" },
  createdAt: "2026-10-20T12:00:00Z", activityAt: "2026-10-20T12:00:00Z" }) as AttentionItem;
function feed(items: AttentionItem[], mineCount = items.length): AttentionFeed {
  return { companyId: "company", generatedAt: "2026-10-27T12:00:00Z", totalCount: items.length, deskBadgeCount: mineCount,
    viewCounts: { mine: mineCount, unassigned: 0, company: 0, archived: 0, all: items.length }, nextCursor: null, countsBySourceKind: {} as AttentionFeed["countsBySourceKind"], items };
}

function summary(items: AttentionItem[], mineCount = items.length) {
  const { items: _items, nextCursor: _cursor, ...counts } = feed(items, mineCount);
  return counts;
}

let root: Root, container: HTMLDivElement, client: QueryClient;
beforeEach(() => {
  vi.clearAllMocks(); localStorage.clear(); fixture.collapsed = false; fixture.userId = "reviewer"; fixture.pathname = "/COO/issues";
  fixture.chats = []; fixture.agents = []; fixture.agentsState = {};
  fixture.primaryAgentId = null; fixture.primaryCompanyId = "company";
  fixture.listMemberships.mockResolvedValue({ agentMemberships: {}, projectMemberships: {} });
  fixture.liveRuns.mockResolvedValue([]); fixture.openWork.mockResolvedValue([]);
  fixture.pmWorkspaces.mockResolvedValue([]);
  fixture.preferences.mockResolvedValue({ orderedIds: [], excludedPmStatusAgentIds: [], updatedAt: null });
  fixture.attention.mockResolvedValue(feed([]));
  fixture.chats = []; fixture.recentTasks = []; fixture.projects = []; fixture.enableCases = false; fixture.enableResponsibilities = false; fixture.agents = [];
  fixture.search = ""; fixture.taskSummaries = [];

  fixture.summary.mockResolvedValue(summary([pending("question"), pending("review")]));
  container = document.createElement("div"); document.body.appendChild(container); root = createRoot(container);
  client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
});

describe("Coordinator task creation", () => {
  it("shows opened parent and child tasks as independent rows in recent order", async () => {
    fixture.recentTasks = [
      { id: "parent", companyId: "company", identifier: "TASK-1", title: "Parent", status: "todo", recordedAt: 1, subtaskCount: 2 },
      { id: "child", companyId: "company", identifier: "TASK-2", title: "Opened child", status: "todo", recordedAt: 2, parentId: "parent", isUnreadForMe: true },
    ];
    fixture.projectTasks.mockResolvedValue([
      { ...fixture.recentTasks[1] },
      { id: "unopened", companyId: "company", identifier: "TASK-3", title: "Unopened child", status: "todo", parentId: "parent" },
    ]);
    await renderSidebar();
    const region = container.querySelector('[aria-label="Recents"]')!;
    const links = [...region.querySelectorAll("a")];
    expect(links.map(link => link.getAttribute("href"))).toEqual(["/issues/TASK-2", "/issues/TASK-1"]);
    expect(links[0]!.parentElement?.parentElement).toBe(links[1]!.parentElement?.parentElement);
    expect(links[0]!.querySelector('[aria-label="Unread"]')).not.toBeNull();
    expect(links[1]!.querySelector('[aria-label="Unread"]')).toBeNull();
    expect(region.querySelector('button[aria-expanded]')).toBeNull();
    expect(fixture.projectTasks).not.toHaveBeenCalled();
  });
  it("keeps hundreds of mixed recent rows in visit order with bounded input reads", async () => {
    const baseTime = Date.parse("2026-11-18T08:00:00Z");
    const tasks = Array.from({ length: 300 }, (_, index) => ({
      id: `task-${index}`, companyId: "company", identifier: `TASK-${index}`, title: `Recent task ${index}`,
      status: "todo", recordedAt: baseTime + 2 * index,
      parentId: index > 0 ? `task-${index - 1}` : null, subtaskCount: 1,
    }));
    const agents = Array.from({ length: 100 }, (_, index) => ({
      id: `agent-${index}`, companyId: "company", name: `Agent ${index}`, urlKey: `agent-${index}`, role: "engineer", status: "idle",
    } as Agent));
    const chats = agents.map((agent, index) => ({
      id: `chat-${index}`, conversationAgentId: agent.id,
      updatedAt: new Date(baseTime + 6 * index + 3).toISOString(), isUnreadForMe: false,
    }));
    const projects = Array.from({ length: 60 }, (_, index) => ({
      id: `project-${index}`, companyId: "company", name: `Project ${index}`, urlKey: `project-${index}`,
    }));
    const inputCount = tasks.length + agents.length + chats.length + projects.length;
    let reads = 0;
    function bounded<T>(items: T[]) {
      return new Proxy(items, { get(target, property, receiver) {
        if (typeof property === "string" && /^\d+$/.test(property) && ++reads > 4 * inputCount) {
          throw new Error("Recents scans growing lists repeatedly");
        }
        return Reflect.get(target, property, receiver);
      } });
    }

    fixture.projects = bounded(projects);
    const now = vi.spyOn(Date, "now").mockReturnValue(baseTime + 601);
    try {
      fixture.pathname = "/COO/projects/project-0";
      await renderSidebar();
      now.mockReturnValue(baseTime + 602);
      fixture.pathname = "/COO/projects/project-1";
      await renderSidebar();
    } finally {
      now.mockRestore();
    }

    fixture.recentTasks = bounded(tasks);
    fixture.agents = bounded(agents);
    fixture.chats = bounded(chats);
    await renderSidebar();

    const region = container.querySelector('[role="region"][aria-label="Recents"]')!;
    const links = Array.from(region.querySelectorAll("a"), link => link.getAttribute("href"));
    expect(links).toHaveLength(tasks.length + chats.length + 2);
    expect(links.slice(0, 4)).toEqual(["/projects/project-1/issues", "/projects/project-0/issues", "/issues/TASK-299", "/chats/agent-99"]);
    expect(links.at(-1)).toBe("/issues/TASK-0");
    expect(new Set(links).size).toBe(links.length);
    expect(fixture.projectTasks).not.toHaveBeenCalled();
    expect(reads).toBeGreaterThanOrEqual(inputCount);
  });
  it("moves the child ahead of newer rows when reopened", async () => {
    const parent = { id: "parent", companyId: "company", identifier: "TASK-1", title: "Parent", status: "todo", recordedAt: 1, subtaskCount: 1 };
    const child = { id: "child", companyId: "company", identifier: "TASK-2", title: "Child", status: "todo", recordedAt: 2, parentId: parent.id };
    const other = { id: "other", companyId: "company", identifier: "TASK-3", title: "Other", status: "todo", recordedAt: 3 };
    fixture.recentTasks = [other, child, parent];
    fixture.projectTasks.mockResolvedValue([child]);
    await renderSidebar();
    const order = () => Array.from(container.querySelectorAll('[aria-label="Recents"] a'), link => link.getAttribute("href"));
    expect(order()).toEqual(["/issues/TASK-3", "/issues/TASK-2", "/issues/TASK-1"]);
    fixture.pathname = "/COO/issues/TASK-2";
    fixture.recentTasks = [{ ...child, recordedAt: 4 }, other, parent];
    await renderSidebar();
    expect(order()).toEqual(["/issues/TASK-2", "/issues/TASK-3", "/issues/TASK-1"]);
  });
  it("opens global search from the organization header", async () => {
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
  it("opens the task form from New task above Chat", async () => {
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
  it("pins tasks, chats, and projects from Recents and restores them above More in saved order", async () => {
    const task = { id: "e4acf42d-422f-44b8-84b8-9d678f8b7c7c", companyId: "company", identifier: "TASK-1", title: "Release task", status: "todo", recordedAt: 1 };
    fixture.agents = [{ id: "cto", companyId: "company", name: "CTO", urlKey: "cto", role: "cto", status: "idle" } as Agent];
    fixture.chats = [{ id: "chat", conversationAgentId: "cto", updatedAt: "2026-11-11T12:00:00Z", isUnreadForMe: false }];
    fixture.projects = [{ id: "project", companyId: "company", name: "Launch", urlKey: "launch" }];
    fixture.pathname = "/COO/projects/launch";
    fixture.taskSummaries = [task];
    fixture.recentTasks = [task];
    await renderSidebar();
    const recents = container.querySelector('[aria-label="Recents"]')!;
    const pinnedLinks = () => Array.from(navigation().querySelectorAll(".group\\/coordinator-pin a"), link => link.getAttribute("href"));
    for (const label of ["Release task", "CTO", "Launch"]) {
      const button = recents.querySelector<HTMLButtonElement>(`button[aria-label="Pin ${label}"]`)!;
      expect(button).not.toBeNull();
      expect(button.closest("a")).toBeNull();
      await act(async () => button.click());
      expect(button.getAttribute("aria-pressed")).toBe("true");
    }
    expect(pinnedLinks()).toEqual(["/issues/TASK-1", "/chats/cto", "/projects/launch/issues"]);
    fixture.pathname = "/COO/issues";
    fixture.recentTasks = [];
    fixture.chats = [];
    fixture.taskSummaries = [{ ...task, title: "Renamed release task" }];
    await act(async () => root.unmount());
    root = createRoot(container);
    await renderSidebar();
    expect(container.querySelector('[aria-label="Recents"]')).toBeNull();
    expect(pinnedLinks()).toEqual(["/issues/TASK-1", "/chats/cto", "/projects/launch/issues"]);
    expect(pinnedPage("/issues/TASK-1")?.textContent).toContain("Renamed release task");
    await click("Unpin Renamed release task");
    expect(pinnedLinks()).toEqual(["/chats/cto", "/projects/launch/issues"]);
  });
  it("matches pinned and recent agent avatar dimensions to task status icons", async () => {
    fixture.agents = [{ id: "cto", companyId: "company", name: "CTO", urlKey: "cto", role: "cto", status: "idle" } as Agent];
    const chat = { id: "chat-cto", conversationAgentId: "cto", updatedAt: "2026-11-11T12:00:00Z", isUnreadForMe: false };
    fixture.chats = [chat];
    fixture.recentTasks = [{ id: "task", companyId: "company", identifier: "TASK-1", title: "Recent task", status: "todo", recordedAt: 1 }];
    localStorage.setItem("paperclip.coordinator.pinned-nav.v1:reviewer", JSON.stringify(["agent-chat:company:cto"]));

    await renderSidebar();

    const avatars = [...container.querySelectorAll<HTMLImageElement>('a[href="/chats/cto"] [data-slot="agent-avatar"] img')];
    const taskIcon = container.querySelector('a[href="/issues/TASK-1"] [data-slot="sidebar-nav-icon"] svg');
    expect(avatars).toHaveLength(2);
    expect(taskIcon).not.toBeNull();
    const width = Number(taskIcon!.getAttribute("width"));
    const height = Number(taskIcon!.getAttribute("height"));
    expect(width).toBeGreaterThan(0);
    expect(height).toBeGreaterThan(0);
    for (const avatar of avatars) {
      expect(avatar.width).toBe(width);
      expect(avatar.height).toBe(height);
    }
  });
  it("builds hundreds of mixed pins with input reads proportional to list size", () => {
    const agents = Array.from({ length: 200 }, (_, index) => ({ id: `agent-${index}`, companyId: "company", name: `Agent ${index}`, urlKey: `agent-${index}` } as Agent));
    const tasks = Array.from({ length: 200 }, (_, index): IssueSummary => ({ id: `task-${index}`, companyId: "company", title: `Task ${index}`, identifier: `TASK-${index}`, status: "todo", updatedAt: new Date(0), externalConversationState: null }));
    const projects = Array.from({ length: 200 }, (_, index) => ({ id: `project-${index}`, companyId: "company", name: `Project ${index}`, urlKey: `project-${index}` } as Project));
    const pins = agents.flatMap((agent, index) => [`agent-chat:company:${agent.id}`, `project:company:${projects[index]!.id}`, `task:company:${tasks[index]!.id}`]).reverse();
    let reads = 0;
    function bounded<T>(items: T[]) {
      return new Proxy(items, { get(target, property, receiver) {
        if (typeof property === "string" && /^\d+$/.test(property) && ++reads > 4 * pins.length) throw new Error("Pin construction scans growing lists repeatedly");
        return Reflect.get(target, property, receiver);
      } });
    }
    const items = buildPinnedNavigationItems(bounded(pins), bounded(agents), [], bounded(tasks), bounded(projects));
    expect(items.map(item => item.key)).toEqual(pins);
    expect(reads).toBeLessThanOrEqual(4 * pins.length);
    expect(items.slice(0, 3).map(item => item.to)).toEqual(["/issues/TASK-199", "/projects/project-199/issues", "/chats/agent-199"]);
  });
  it("keeps mixed pins above More in stored order and prevents native link dragging", async () => {
    fixture.agents = [{ id: "cto", companyId: "company", name: "CTO", urlKey: "cto", role: "cto", status: "idle" } as Agent];
    const saved = ["agent-chat:company:cto", "agent-chat:another-company:hidden", "/artifacts", "/dashboard"];
    localStorage.setItem("paperclip.coordinator.pinned-nav.v1:reviewer", JSON.stringify(saved));
    await renderSidebar();
    const links = [...navigation().querySelectorAll<HTMLAnchorElement>("a")].slice(3);
    expect(links.map(link => link.textContent)).toEqual(["CTO", "Artifacts", "Dashboard"]);
    const more = navigation().querySelector('button[aria-label="More workspace pages"]')!;
    expect(links.at(-1)!.compareDocumentPosition(more) & Node.DOCUMENT_POSITION_FOLLOWING).not.toBe(0);
    expect(JSON.parse(localStorage.getItem("paperclip.coordinator.pinned-nav.v1:reviewer")!)).toEqual(saved);
    const nativeDrag = new Event("dragstart", { bubbles: true, cancelable: true });
    act(() => links[1].dispatchEvent(nativeDrag));
    expect(nativeDrag.defaultPrevented).toBe(true);
  });
  it("reorders mixed pins with the keyboard while preserving hidden slots and saved order", async () => {
    const storageKey = "paperclip.coordinator.pinned-nav.v1:reviewer";
    const saved = ["/artifacts", "agent-chat:another-company:hidden", "/dashboard"];
    localStorage.setItem(storageKey, JSON.stringify(saved));
    await renderSidebar();
    const order = () => [...navigation().querySelectorAll(".group\\/coordinator-pin a")].map(link => link.getAttribute("href"));
    const nativeRect = HTMLElement.prototype.getBoundingClientRect;
    const rect = vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockImplementation(function (this: HTMLElement) {
      const rows = [...container.querySelectorAll(".group\\/coordinator-pin")];
      const index = rows.indexOf(this);
      if (index < 0) return nativeRect.call(this);
      const top = index * 40;
      return { x: 0, y: top, top, bottom: top + 40, left: 0, right: 240, width: 240, height: 40, toJSON() {} };
    });
    const key = async (target: Element, code: string) => {
      await act(async () => {
        target.dispatchEvent(new KeyboardEvent("keydown", { code, key: code === "Space" ? " " : code, bubbles: true, cancelable: true }));
        await new Promise(resolve => setTimeout(resolve, 0));
      });
    };
    try {
      const handle = navigation().querySelector<HTMLButtonElement>('[aria-label="Reorder pinned Artifacts"]')!;
      handle.focus();
      await key(handle, "Space");
      await key(handle, "ArrowDown");
      await key(handle, "Escape");
      expect(order()).toEqual(["/artifacts", "/dashboard"]);
      expect(JSON.parse(localStorage.getItem(storageKey)!)).toEqual(saved);
      await key(handle, "Space");
      await key(handle, "ArrowDown");
      await key(handle, "Space");
      expect(order()).toEqual(["/dashboard", "/artifacts"]);
      expect(JSON.parse(localStorage.getItem(storageKey)!)).toEqual([saved[2], saved[1], saved[0]]);
      await act(async () => root.unmount()); root = createRoot(container);
      await renderSidebar();
      expect(order()).toEqual(["/dashboard", "/artifacts"]);
    } finally { rect.mockRestore(); }
  });
  it.each([false, true])("keeps Cases reachable in More only when enabled (%s)", async enabled => {
    fixture.enableCases = enabled;
    await renderSidebar();
    await act(async () => container.querySelector<HTMLButtonElement>('button[aria-label="More workspace pages"]')!.click());
    expect(document.querySelector('a[href="/cases"]') !== null).toBe(enabled);
  });
  it("announces unread chat totals", async () => {
    fixture.chats = [{ isUnreadForMe: true }, { isUnreadForMe: false }, { isUnreadForMe: true }];
    await renderSidebar();
    expect(container.querySelector('a[href="/chats"] [aria-label="2 unread chats"]')).not.toBeNull();
  });
  const navigation = () => container.querySelector('nav[aria-label="Workspace navigation"]')!;
  const pinnedPage = (to: string) => navigation().querySelector(`a[href="${to}"]`);
  async function click(label: string) {
    const button = document.querySelector<HTMLButtonElement>(`button[aria-label="${label}"]`);
    expect(button).not.toBeNull();
    await act(async () => button!.click());
    await flush();
  }

  it("keeps pins above More without a separate section, restores and unpins", async () => {
    await renderSidebar();
    expect(pinnedPage("/projects")).toBeNull();
    await click("More workspace pages");
    expect(document.activeElement).toBe(document.querySelector('[data-slot="popover-content"]'));
    await click("Pin Projects");
    expect(document.querySelector('[role="dialog"]')).not.toBeNull();
    expect(pinnedPage("/projects")?.textContent).toBe("Projects");
    expect(navigation().querySelector('[aria-label="Pinned pages"]')).toBeNull();
    expect(navigation().querySelector('[data-slot="sidebar-group-label"]')).toBeNull();
    const more = navigation().querySelector('button[aria-label="More workspace pages"]')!;
    expect(pinnedPage("/projects")!.compareDocumentPosition(more) & Node.DOCUMENT_POSITION_FOLLOWING).not.toBe(0);
    await act(async () => root.unmount());
    root = createRoot(container);
    await renderSidebar();
    expect(pinnedPage("/projects")).not.toBeNull();
    await click("Unpin Projects");
    expect(pinnedPage("/projects")).toBeNull();
  });

  it("keeps pins personal and only renders known destinations", async () => {
    localStorage.setItem("paperclip.coordinator.pinned-nav.v1:reviewer", JSON.stringify(["/routines", "/projects", "/unknown", "https://example.com"]));
    await renderSidebar();
    expect(Array.from(navigation().querySelectorAll("a")).map(link => link.getAttribute("href")))
      .toEqual(["/chats", "/issues", "/decisions", "/routines", "/projects"]);
    fixture.userId = "other-user";
    await renderSidebar();
    expect(pinnedPage("/projects")).toBeNull();
    fixture.userId = "reviewer";
    await renderSidebar();
    expect(pinnedPage("/projects")?.textContent).toBe("Projects");
  });

  it("reflects pins changed in another browser tab", async () => {
    await renderSidebar();
    const key = "paperclip.coordinator.pinned-nav.v1:reviewer";
    await act(async () => {
      localStorage.setItem(key, JSON.stringify(["/agents/all"]));
      window.dispatchEvent(new StorageEvent("storage", { key }));
    });
    expect(pinnedPage("/agents/all")?.textContent).toBe("Agents");
  });
});
afterEach(async () => { await act(async () => root.unmount()); client.clear(); container.remove(); });
async function flush() { await act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)); }); }
async function renderSidebar(children?: ReactNode) {
  await act(async () => root.render(<QueryClientProvider client={client}><PrimaryAgentPresentationProvider value={{
    companyId: fixture.primaryCompanyId, primaryAgentId: fixture.primaryAgentId, primaryAgent: null, onChange: () => {},
  }}><TooltipProvider><CoordinatorSidebar />{children}</TooltipProvider></PrimaryAgentPresentationProvider></QueryClientProvider>));
  await flush();
}
const decisionLink = () => container.querySelector('a[href="/decisions"]')!;

describe("Coordinator agents section", () => {
  it("attributes a shared worker run to its project PM in the actual Coordinator entry", async () => {
    fixture.agents = [{ id: "pm-a", name: "Project PM", role: "pm", status: "idle", urlKey: "project-pm" }];
    fixture.pmWorkspaces.mockResolvedValue([{ agentId: "pm-a", projectId: "project-a", status: "active" }]);
    fixture.liveRuns.mockResolvedValue([{ id: "run-a", agentId: "shared-worker", status: "running", projectId: "project-a" }]);
    await renderSidebar();
    await flush();
    await flush();
    expect(container.querySelector('.design-sidebar-agents a')?.getAttribute("data-agent-status")).toBe("working");
  });
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

  it("lists agents the person starred alongside CEO and PM roles, keeping unstarred workers hidden", async () => {
    fixture.agents = [
      ...roster,
      { id: "a-main", name: "Billing main agent", role: "engineer", urlKey: "billing", status: "idle", adapterType: "ccpocket_bridge" },
      { id: "a-gone", name: "Starred retired", role: "engineer", status: "terminated" },
      { id: "a-cmd", name: "Starred command", role: "engineer", status: "idle", adapterType: "process" },
      { id: "a-out", name: "Starred left", role: "engineer", status: "idle" },
    ];
    fixture.listMemberships.mockResolvedValue({ agentMemberships: { "a-out": "left" }, projectMemberships: {},
      starredAgentIds: ["a-main", "a-gone", "a-cmd", "a-out"] });
    await renderSidebar();
    expect(rows().map(row => [row.textContent, row.getAttribute("href")])).toEqual([
      ["amy", "/chats/amy"], ["Billing main agent", "/chats/billing"], ["Left", "/chats/left"], ["momo", "/chats/momo"],
      ["Space Name", `/chats/${encodeURIComponent("space name")}`], ["Zed", "/chats/zed"],
    ]);
    expect(section()?.textContent).not.toContain("worker");
    expect(section()?.textContent).not.toContain("Starred");
    expect(section()?.querySelector('[aria-expanded]')).toBeNull();
  });

  it("explicit chat unpin hides primary, role-default and starred agents without changing identity", async () => {
    fixture.primaryAgentId = "a-ceo";
    fixture.listMemberships.mockResolvedValue({ agentMemberships: {}, projectMemberships: {},
      starredAgentIds: ["a-ceo"], agentChatPins: { "a-ceo": false, "a-amy": false } });
    await renderSidebar();
    expect(rows().map(row => row.textContent)).not.toContain("momo");
    expect(rows().map(row => row.textContent)).not.toContain("amy");
    expect(fixture.primaryAgentId).toBe("a-ceo");
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

  it("shows a native plan as pending on a working non-PM chat, then restores working", async () => {
    fixture.agents = roster;
    fixture.liveRuns.mockResolvedValue([{ id: "r", agentId: "a-zed", status: "running" }]);
    fixture.attention.mockResolvedValue(feed([{ ...pending("native-plan"), project: null,
      subject: { ...pending("native-plan").subject, metadata: { createdByAgentId: "a-zed", kind: "request_confirmation" } },
    } as AttentionItem]));
    await renderSidebar(); await flush(); await flush();
    const row = () => rows().find(row => row.textContent?.startsWith("Zed"))!;
    expect(row().textContent).toContain("pending");
    expect(row().textContent).not.toContain("working");
    expect(row().className).toContain("ring-orange");
    expect(row().querySelector(".bg-orange-500")).not.toBeNull();
    await act(async () => { client.setQueryData(coordinatorAttentionQueryKey("company"), feed([])); });
    await flush(); await flush();
    expect(row().textContent).toContain("working");
    expect(row().className).not.toContain("ring-orange");
  });

  describe("project PM status", () => {
    const byLabel = (label: string) => rows().find(row => row.textContent?.startsWith(label))!;
    const status = () => byLabel("Zed")?.getAttribute("data-agent-status");
    const binding = [{ agentId: "a-zed", projectId: "project-z", status: "active" }];
    const preference = { orderedIds: [], excludedPmStatusAgentIds: [], updatedAt: null };
    const request = { ...pending("input"), project: { id: "project-z" } } as AttentionItem;
    beforeEach(() => {
      fixture.agents = roster;
      fixture.pmWorkspaces.mockResolvedValue(binding);
      fixture.liveRuns.mockResolvedValue([{ id: "run-1", agentId: "shared-worker", projectId: "project-z", status: "running" }]);
    });
    async function settle() { await flush(); await flush(); await flush(); }

    it("gives Owner input priority over work and honors stored exclusions", async () => {
      fixture.attention.mockResolvedValue(feed([request]));
      await renderSidebar(); await settle();
      expect(status()).toBe("needs_input");
      expect(byLabel("Zed").textContent).toContain("pending");
      fixture.preferences.mockResolvedValue({ ...preference, excludedPmStatusAgentIds: ["a-zed"] });
      await act(async () => { await client.invalidateQueries({ queryKey: queryKeys.sidebarPreferences.projectOrder("company", "reviewer") }); });
      await settle();
      expect(status()).toBeNull();
    });

    it("never infers status from agent status, unlisted agents' runs, open tasks or chat-only state", async () => {
      // a-amy's agent record says running, but it has no live run; the worker run is outside every project.
      fixture.liveRuns.mockResolvedValue([{ id: "run-1", agentId: "a-worker", status: "running" }]);
      fixture.chats = [{ id: "chat-zed", isUnreadForMe: false, conversationAgentId: "a-zed", conversationState: "active" }];
      await renderSidebar(); await settle();
      expect(section()?.querySelector("[data-agent-status]")).toBeNull();
      expect(fixture.openWork).not.toHaveBeenCalled();
      expect(rows().some(row => row.className.includes("ring-(--dashboard-run-accent)"))).toBe(false);
    });

    it("shows an unbound listed agent working only while its own run is live", async () => {
      fixture.liveRuns.mockResolvedValue([{ id: "run-1", agentId: "a-amy", status: "running" }]);
      await renderSidebar(); await settle();
      expect(byLabel("amy").getAttribute("data-agent-status")).toBe("working");
      expect(byLabel("amy").textContent).toContain("working");
      expect(status()).toBeNull();
      fixture.liveRuns.mockResolvedValue([]);
      await act(async () => { await client.invalidateQueries({ queryKey: queryKeys.liveRuns("company") }); }); await settle();
      expect(byLabel("amy").getAttribute("data-agent-status")).toBeNull();
    });

    it("lets PM pending and working outrank waiting for task", async () => {
      fixture.chats = [{ id: "chat-zed", isUnreadForMe: false, conversationAgentId: "a-zed", hasLiveChildTasks: true }];
      fixture.attention.mockResolvedValue(feed([request]));
      await renderSidebar(); await settle();
      expect(status()).toBe("needs_input");
      fixture.attention.mockResolvedValue(feed([]));
      await act(async () => { await client.invalidateQueries({ queryKey: coordinatorAttentionQueryKey("company") }); }); await settle();
      expect(status()).toBe("working");
      // A queued project run is not work, so the chat shows it is waiting for its task.
      fixture.liveRuns.mockResolvedValue([{ id: "run-1", agentId: "shared-worker", projectId: "project-z", status: "queued" }]);
      await act(async () => { await client.invalidateQueries({ queryKey: queryKeys.liveRuns("company") }); }); await settle();
      expect(status()).toBe("waiting_for_task");
    });

    it("keeps unread and selected state on a working row without the legacy ring", async () => {
      fixture.pathname = "/COO/chats/zed";
      fixture.chats = [{ id: "chat-zed", isUnreadForMe: true, conversationAgentId: "a-zed" }];
      await renderSidebar(); await settle();
      expect(status()).toBe("working");
      expect(byLabel("Zed").className).toContain("bg-sidebar-accent text-sidebar-accent-foreground");
      expect(byLabel("Zed").className).not.toContain("ring-(--dashboard-run-accent)");
      expect(byLabel("Zed").querySelector('[aria-label="1 unread chat"]')).not.toBeNull();
    });

    const sources = ["binding", "preference", "attention"] as const;
    function source(name: typeof sources[number]) {
      if (name === "binding") return { mock: fixture.pmWorkspaces, value: binding, key: queryKeys.pmWorkspaces("company") };
      if (name === "preference") return { mock: fixture.preferences, value: preference, key: queryKeys.sidebarPreferences.projectOrder("company", "reviewer") };
      return { mock: fixture.attention, value: feed([]), key: coordinatorAttentionQueryKey("company") };
    }
    it.each(sources)("waits quietly for the first %s snapshot", async name => {
      const read = source(name);
      let resolve!: (value: unknown) => void;
      read.mock.mockReturnValue(new Promise(r => { resolve = r; }));
      await renderSidebar(); await settle();
      expect(status()).toBeNull();
      expect(fixture.pushToast).not.toHaveBeenCalled();
      await act(async () => resolve(read.value)); await settle();
      expect(status()).toBe("working");
    });
    it.each(sources)("reports a first %s failure without claiming status", async name => {
      source(name).mock.mockRejectedValue(new Error("unavailable"));
      await renderSidebar(); await settle();
      expect(status()).toBeNull();
      expect(fixture.pushToast).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({
        dedupeKey: "sidebar-pm-status-" + name + ":company", body: "unavailable", tone: "error",
      }));
      await renderSidebar(); await settle();
      expect(fixture.pushToast).toHaveBeenCalledTimes(1);
    });
    it.each(sources)("retains the loaded %s snapshot after a failed refresh", async name => {
      await renderSidebar(); await settle();
      expect(status()).toBe("working");
      const read = source(name); read.mock.mockRejectedValue(new Error("offline"));
      await act(async () => { await client.invalidateQueries({ queryKey: read.key }); }); await settle();
      expect(status()).toBe("working");
      expect(fixture.pushToast).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ body: "offline" }));
    });

    it.each([false, true])("shares one page feed and invalidation with delayed bindings=%s", async delayed => {
      function FullFeedPage() {
        const { data } = useQuery({ queryKey: coordinatorAttentionQueryKey("company"),
          queryFn: () => attentionApi.list("company", { all: true }) });
        return <output>{data?.items.length}</output>;
      }
      let resolve!: (value: unknown) => void;
      if (delayed) fixture.pmWorkspaces.mockReturnValue(new Promise(r => { resolve = r; }));
      else client.setQueryData(queryKeys.pmWorkspaces("company"), binding);
      await renderSidebar(<FullFeedPage />); await settle();
      if (delayed) {
        expect(fixture.attention).toHaveBeenCalledTimes(1);
        await act(async () => resolve(binding)); await settle();
      }
      expect(fixture.attention).toHaveBeenCalledExactlyOnceWith("company", { all: true });
      fixture.attention.mockResolvedValue(feed([request]));
      await act(async () => { await client.invalidateQueries({ queryKey: queryKeys.attention("company") }); }); await settle();
      expect(fixture.attention).toHaveBeenCalledTimes(2);
      expect(status()).toBe("needs_input");
      expect(container.querySelector("output")?.textContent).toBe("1");
    });

    it("retries only live runs after live-run failure", async () => {
      fixture.liveRuns.mockRejectedValue(new Error("boom"));
      await renderSidebar(); await settle();
      const alert = section()?.querySelector('[role="alert"]');
      expect(alert?.textContent).toContain("Couldn’t load agent activity");
      const bindingsReads = fixture.pmWorkspaces.mock.calls.length;
      const attentionReads = fixture.attention.mock.calls.length;
      fixture.liveRuns.mockResolvedValue([{ id: "run-1", agentId: "a-zed", status: "running" }]);
      await act(async () => alert!.querySelector("button")!.click()); await settle();
      expect(section()?.querySelector('[role="alert"]')).toBeNull();
      expect(status()).toBe("working");
      expect(fixture.pmWorkspaces).toHaveBeenCalledTimes(bindingsReads);
      expect(fixture.attention).toHaveBeenCalledTimes(attentionReads);
      expect(fixture.openWork).not.toHaveBeenCalled();
    });
  });

  describe("project main agent status without PM bindings", () => {
    // Project main agents have no project_pm binding and are listed because the person starred them.
    const mains: FixtureAgent[] = [
      { id: "a-main", name: "All-Set", role: "engineer", urlKey: "all-set", status: "running", adapterType: "ccpocket_bridge" },
      { id: "a-ceo", name: "momo", role: "ceo", urlKey: "momo", status: "running", adapterType: "paperclip_runner" },
      { id: "a-worker", name: "Shared worker", role: "engineer", urlKey: "worker", status: "running" },
    ];
    const byLabel = (label: string) => rows().find(row => row.textContent?.startsWith(label))!;
    async function settle() { await flush(); await flush(); await flush(); }
    beforeEach(() => {
      fixture.agents = mains;
      fixture.listMemberships.mockResolvedValue({ agentMemberships: {}, projectMemberships: {}, starredAgentIds: ["a-main"] });
      fixture.liveRuns.mockResolvedValue([
        { id: "run-main", agentId: "a-main", status: "running", projectId: "project-a", execution: { phase: "working" } },
        { id: "run-momo", agentId: "a-ceo", status: "running", execution: { phase: "working" } },
        { id: "run-worker", agentId: "a-worker", status: "running", projectId: "project-a" },
      ]);
    });

    it("marks the main agent working from its own run, honors exclusions and shares the Owner attention feed", async () => {
      fixture.preferences.mockResolvedValue({ orderedIds: [], excludedPmStatusAgentIds: ["a-ceo"], updatedAt: null });
      await renderSidebar(); await settle();
      expect(rows().map(row => row.getAttribute("href"))).toEqual(["/chats/all-set", "/chats/momo"]);
      expect(byLabel("All-Set").getAttribute("data-agent-status")).toBe("working");
      expect(byLabel("momo").getAttribute("data-agent-status")).toBeNull();
      expect(fixture.preferences).toHaveBeenCalled();
      expect(fixture.attention).toHaveBeenCalledWith("company", { all: true });
    });

    it("claims no status while the exclusion list is unknown and reports the failure", async () => {
      fixture.preferences.mockRejectedValue(new Error("unavailable"));
      await renderSidebar(); await settle();
      expect(section()?.querySelector("[data-agent-status]")).toBeNull();
      expect(fixture.pushToast).toHaveBeenCalledWith(expect.objectContaining({ dedupeKey: "sidebar-pm-status-preference:company" }));
    });

    it("frames a chat waiting for its tasks in violet until they finish, without changing the row", async () => {
      // The main agent ended its own turn; a task it created runs on a shared worker.
      fixture.liveRuns.mockResolvedValue([{ id: "run-worker", agentId: "a-worker", status: "running", projectId: "project-a" }]);
      fixture.chats = [{ id: "chat-main", isUnreadForMe: true, conversationAgentId: "a-main", hasLiveChildTasks: true }];
      fixture.pathname = "/COO/chats/all-set";
      await renderSidebar(); await settle();
      const row = byLabel("All-Set");
      expect(row.getAttribute("data-agent-status")).toBe("waiting_for_task");
      expect(row.textContent).toContain("waiting for task");
      expect(row.className).toContain("ring-(--sidebar-waiting-frame)");
      expect(row.getAttribute("href")).toBe("/chats/all-set");
      expect(row.querySelector('[aria-label="1 unread chat"]')).not.toBeNull();
      expect(byLabel("momo").getAttribute("data-agent-status")).toBeNull();
      fixture.chats = [{ id: "chat-main", isUnreadForMe: false, conversationAgentId: "a-main", hasLiveChildTasks: false }];
      fixture.pathname = "/COO/issues";
      await renderSidebar(); await settle();
      expect(byLabel("All-Set").getAttribute("data-agent-status")).toBeNull();
      expect(byLabel("All-Set").className).not.toContain("sidebar-waiting");
      expect(byLabel("All-Set").textContent).toBe("All-Set");
    });

    it("tints an unselected waiting row and keeps the working indicator while the main agent runs itself", async () => {
      fixture.chats = [{ id: "chat-main", isUnreadForMe: false, conversationAgentId: "a-main", hasLiveChildTasks: true }];
      await renderSidebar(); await settle();
      expect(byLabel("All-Set").getAttribute("data-agent-status")).toBe("working");
      fixture.liveRuns.mockResolvedValue([]);
      await act(async () => { await client.invalidateQueries({ queryKey: queryKeys.liveRuns("company") }); }); await settle();
      expect(byLabel("All-Set").getAttribute("data-agent-status")).toBe("waiting_for_task");
      expect(byLabel("All-Set").className).toContain("bg-(--sidebar-waiting-background)");
    });

    it("shows working while the chat's native subagents run after the main run ended, and clears with them", async () => {
      fixture.liveRuns.mockResolvedValue([]);
      const until = new Date(Date.now() + 30 * 60_000).toISOString();
      // Both a running subagent and a live task: working outranks waiting for task.
      fixture.chats = [{ id: "chat-main", isUnreadForMe: false, conversationAgentId: "a-main", hasLiveChildTasks: true, hasRunningSubagents: true, runningSubagentsUntil: until }];
      await renderSidebar(); await settle();
      const row = byLabel("All-Set");
      expect(row.getAttribute("data-agent-status")).toBe("working");
      expect(row.textContent).toContain("working");
      expect(row.className).toContain("ring-blue-600/60");
      expect(byLabel("momo").getAttribute("data-agent-status")).toBeNull();
      // The server clears the flag once the subagents are done or proven gone.
      fixture.chats = [{ id: "chat-main", isUnreadForMe: false, conversationAgentId: "a-main", hasRunningSubagents: false, runningSubagentsUntil: null }];
      await renderSidebar(); await settle();
      expect(byLabel("All-Set").getAttribute("data-agent-status")).toBeNull();
      // A flag past its bound never stays blue, even if the list was not refetched.
      fixture.chats = [{ id: "chat-main", isUnreadForMe: false, conversationAgentId: "a-main", hasRunningSubagents: true, runningSubagentsUntil: new Date(Date.now() - 1_000).toISOString() }];
      await renderSidebar(); await settle();
      expect(byLabel("All-Set").getAttribute("data-agent-status")).toBeNull();
    });

    it("clears when the main agent's run fails or waits for an answer", async () => {
      await renderSidebar(); await settle();
      expect(byLabel("All-Set").getAttribute("data-agent-status")).toBe("working");
      fixture.liveRuns.mockResolvedValue([{ id: "run-main", agentId: "a-main", status: "running", execution: { phase: "waiting_for_answer" } }]);
      await act(async () => { await client.invalidateQueries({ queryKey: queryKeys.liveRuns("company") }); }); await settle();
      expect(byLabel("All-Set").getAttribute("data-agent-status")).toBeNull();
      fixture.liveRuns.mockResolvedValue([{ id: "run-main", agentId: "a-main", status: "failed" }]);
      await act(async () => { await client.invalidateQueries({ queryKey: queryKeys.liveRuns("company") }); }); await settle();
      expect(byLabel("All-Set").getAttribute("data-agent-status")).toBeNull();
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

  it("renders no agents section without agents", async () => {
    await renderSidebar();
    expect(section()).toBeNull();
  });
});

describe("Coordinator Needs You badge", () => {
  it("counts every canonical outstanding decision even when none arrived today", async () => {
    // Personal page filters and completed receipts are separate cache entries.
    client.setQueryData([...coordinatorAttentionQueryKey("company", "reviewer", "mine"), { search: "no match" }], feed([]));
    client.setQueryData([...queryKeys.attention("company"), "history", "recent"], { items: [{ id: "answered-question" }] });
    await renderSidebar();
    expect(fixture.attention).not.toHaveBeenCalled();
    expect(client.getQueryData(coordinatorAttentionQueryKey("company", "reviewer", "mine"))).toBeUndefined();
    expect(fixture.summary).toHaveBeenCalledWith("company");
    expect(decisionLink().querySelector('[data-slot="badge"]')?.textContent).toBe("2");
  });

  it("counts only For you, excluding other people, unassigned cards and company alerts", async () => {
    fixture.summary.mockResolvedValue(summary([
      pending("for-reviewer"), pending("for-someone-else"), pending("unassigned"), pending("company-alert"),
    ], 1));
    await renderSidebar();
    expect(decisionLink().querySelector('[data-slot="badge"]')?.textContent).toBe("1");
  });

  it("hides the badge when only other people's decisions remain", async () => {
    fixture.summary.mockResolvedValue(summary([pending("for-someone-else")], 0));
    await renderSidebar();
    expect(decisionLink().querySelector('[data-slot="badge"]')).toBeNull();
  });

  it("never reuses another account's count when the signed-in user changes", async () => {
    for (const [userId, mineCount] of [["reviewer", 2], ["other-user", 1]] as const) {
      const key = coordinatorAttentionSummaryQueryKey("company", userId);
      client.setQueryDefaults(key, { staleTime: Infinity });
      client.setQueryData(key, summary([pending("one"), pending("two")], mineCount));
    }
    await renderSidebar();
    expect(decisionLink().querySelector('[data-slot="badge"]')?.textContent).toBe("2");
    fixture.userId = "other-user";
    await renderSidebar();
    expect(decisionLink().querySelector('[data-slot="badge"]')?.textContent).toBe("1");
    expect(fixture.summary).not.toHaveBeenCalled();
  });

  it("waits for the signed-in user before reading or displaying a count", async () => {
    fixture.userId = null;
    await renderSidebar();
    expect(fixture.summary).not.toHaveBeenCalled();
    expect(decisionLink().querySelector('[data-slot="badge"]')).toBeNull();
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
    expect(decisionLink().textContent).toBe("Inbox");
  });

  it("announces only your outstanding count", async () => {
    fixture.summary.mockResolvedValue(summary([pending("for-reviewer"), pending("for-someone-else")], 1));
    await renderSidebar();
    expect(decisionLink().querySelector('[aria-label="1 decisions"]')).not.toBeNull();
  });
});


describe("Coordinator collection reads", () => {
  it("does not replace a resolved count with an older summary that arrives later", async () => {
    const key = coordinatorAttentionSummaryQueryKey("company", "reviewer");
    client.setQueryDefaults(key, { staleTime: Infinity });
    client.setQueryData(key, { ...summary([pending("old")]), generatedAt: "2026-10-27T12:00:00Z" }, { updatedAt: 20 });
    client.setQueryData(coordinatorAttentionQueryKey("company", "reviewer", "mine"), { ...feed([]), generatedAt: "2026-10-27T12:01:00Z" }, { updatedAt: 10 });
    await renderSidebar();
    expect(decisionLink().querySelector('[data-slot="badge"]')).toBeNull();
  });

  it("keeps a newer resolved count when returning to a cached navigation summary", async () => {
    const key = coordinatorAttentionSummaryQueryKey("company", "reviewer");
    client.setQueryDefaults(key, { staleTime: Infinity });
    client.setQueryData(key, summary([pending("old")]), { updatedAt: 1 });
    client.setQueryData(coordinatorAttentionQueryKey("company", "reviewer", "mine"), feed([]), { updatedAt: 2 });
    await renderSidebar();
    expect(decisionLink().querySelector('[data-slot="badge"]')).toBeNull();
    expect(fixture.summary).not.toHaveBeenCalled();
    expect(fixture.attention).not.toHaveBeenCalled();
  });

  it("reuses the page-owned complete feed on Inbox without a second summary read", async () => {
    fixture.pathname = "/COO/decisions";
    const key = coordinatorAttentionQueryKey("company", "reviewer", "mine");
    client.setQueryData(key, feed([pending("review"), pending("review-evidence")], 1));
    await renderSidebar();
    expect(fixture.summary).not.toHaveBeenCalled();
    expect(fixture.attention).not.toHaveBeenCalled();
    expect(decisionLink().querySelector('[data-slot="badge"]')?.textContent).toBe("1");
    await act(async () => client.setQueryData(key, feed([])));
    await flush();
    expect(decisionLink().querySelector('[data-slot="badge"]')).toBeNull();
  });

  it("reuses your count from the Tasks attention index without counting everyone", async () => {
    fixture.search = "?view=needs_attention";
    const key = coordinatorAttentionTasksQueryKey("company", "reviewer");
    client.setQueryData(key, { ...summary([pending("for-reviewer"), pending("for-someone-else")], 1), taskIds: [] });
    await renderSidebar();
    expect(fixture.summary).not.toHaveBeenCalled();
    expect(fixture.attention).not.toHaveBeenCalled();
    expect(decisionLink().querySelector('[data-slot="badge"]')?.textContent).toBe("1");
    await act(async () => client.setQueryData(key, { ...summary([pending("for-someone-else")], 0), taskIds: [] }));
    await flush();
    expect(decisionLink().querySelector('[data-slot="badge"]')).toBeNull();
  });
});

describe("Coordinator task status glyphs (BUG-07)", () => {
  const covered = {
    state: "covered", reason: "active_child", unresolvedBlockerCount: 1, coveredBlockerCount: 1,
    attentionBlockerCount: 0, stalledBlockerCount: 0, sampleBlockerIdentifier: "ONB-3", sampleStalledBlockerIdentifier: null,
  };
  const glyph = (href: string) => container.querySelector<SVGElement>(`a[href="${href}"] svg[role="img"]`);

  it("shows a covered-blocked recent task with the same queued glyph and label as the task pane", async () => {
    fixture.recentTasks = [{ id: "task-1", companyId: "company", identifier: "ONB-1", title: "Paperclip onboarding",
      status: "blocked", displayStatus: "blocked", externalConversationState: null, blockerAttention: covered, recordedAt: 1 }];
    await renderSidebar();
    expect(glyph("/issues/ONB-1")?.style.color).toBe("var(--status-task-icon-in_queue)");
    expect(glyph("/issues/ONB-1")?.getAttribute("aria-label")).toBe("Blocked · waiting on active sub-task ONB-3");
  });

  it("opens a recent project on Tasks and keeps its task query lazy", async () => {
    fixture.projects = [{ id: "project-1", companyId: "company", name: "Onboarding", urlKey: "onboarding" }];
    fixture.pathname = "/COO/projects/onboarding";
    await renderSidebar();
    const region = container.querySelector('[aria-label="Recents"]')!;
    expect(region.querySelector('a[href="/projects/onboarding/issues"]')?.textContent).toBe("Onboarding");
    expect(region.querySelector('button[aria-expanded="false"]')).not.toBeNull();
    expect(fixture.projectTasks).not.toHaveBeenCalled();
  });
});

describe("Coordinator project tasks", () => {
  async function projectRow(pinned: boolean) {
    fixture.projects = [{ id: "project-1", companyId: "company", name: "Onboarding", urlKey: "onboarding" }];
    if (pinned) {
      localStorage.setItem("paperclip.coordinator.pinned-nav.v1:reviewer", JSON.stringify(["project:company:project-1"]));
    } else {
      fixture.pathname = "/COO/projects/onboarding/configuration";
    }
    await renderSidebar();
    return container.querySelector(pinned ? ".group\\/coordinator-pin" : '[aria-label="Recents"]')!;
  }

  it.each([false, true])("opens Tasks and expands tasks beneath the project (pinned: %s)", async pinned => {
    const task = { id: "project-task", companyId: "company", projectId: "project-1", identifier: "TASK-42", title: "Prepare launch",
      status: "in_progress", displayStatus: "monitoring", isUnreadForMe: true };
    fixture.projectTasks.mockResolvedValue([task]);
    const row = await projectRow(pinned);
    expect(row.querySelector('a[href="/projects/onboarding/issues"]')?.textContent).toBe("Onboarding");
    expect(fixture.projectTasks).not.toHaveBeenCalled();
    const expand = row.querySelector<HTMLButtonElement>('button[aria-label="Expand Onboarding"]')!;
    expect(expand.closest("a")).toBeNull();
    await act(async () => expand.click());
    await flush();
    expect(expand.getAttribute("aria-expanded")).toBe("true");
    const tasks = document.getElementById(expand.getAttribute("aria-controls")!)!;
    expect(tasks.querySelector('a[href="/issues/TASK-42"]')?.textContent).toContain("Prepare launch");
    expect(tasks.querySelector('[aria-label="Unread"]')).not.toBeNull();
    expect(tasks.querySelector('svg[role="img"]')?.getAttribute("aria-label")).toBe("Monitoring");
    expect(fixture.projectTasks).toHaveBeenCalledWith("company", {
      projectId: "project-1", includeReadState: true, limit: 12, sortField: "updated", sortDir: "desc",
    }, { signal: expect.any(AbortSignal) });
    if (pinned) {
      expect(row.querySelector('[aria-label="Reorder pinned Onboarding"]')?.parentElement)
        .toBe(row.querySelector('[aria-label="Unpin Onboarding"]')?.parentElement);
    }
    await act(async () => expand.click());
    expect(expand.getAttribute("aria-expanded")).toBe("false");
    expect(row.querySelector('a[href="/issues/TASK-42"]')).toBeNull();
  });

  it("keeps an expanded project's task links when it is pinned and unpinned", async () => {
    fixture.projectTasks.mockResolvedValue([{ id: "task", companyId: "company", projectId: "project-1", identifier: "TASK-42", title: "Prepare launch", status: "todo" }]);
    const recent = await projectRow(false);
    await act(async () => recent.querySelector<HTMLButtonElement>('[aria-label="Expand Onboarding"]')!.click());
    await flush();
    await act(async () => recent.querySelector<HTMLButtonElement>('[aria-label="Pin Onboarding"]')!.click());
    const pinned = container.querySelector(".group\\/coordinator-pin")!;
    await act(async () => pinned.querySelector<HTMLButtonElement>('[aria-label="Expand Onboarding"]')!.click());
    await flush();
    expect(pinned.querySelector('a[href="/issues/TASK-42"]')).not.toBeNull();
    await act(async () => pinned.querySelector<HTMLButtonElement>('[aria-label="Unpin Onboarding"]')!.click());
    expect(container.querySelector(".group\\/coordinator-pin")).toBeNull();
    expect(recent.querySelector('a[href="/issues/TASK-42"]')).not.toBeNull();
  });

  it("shows loading followed by the empty state", async () => {
    let resolve!: (tasks: never[]) => void;
    fixture.projectTasks.mockReturnValue(new Promise<never[]>(done => { resolve = done; }));
    const row = await projectRow(true);
    await act(async () => row.querySelector<HTMLButtonElement>('[aria-label="Expand Onboarding"]')!.click());
    expect(row.querySelector('[role="status"]')?.textContent).toBe("Loading tasks…");
    await act(async () => resolve([]));
    await flush();
    expect(row.textContent).toContain("No tasks yet.");
  });

  it("reorders an expanded pinned project with the keyboard and keeps its tasks underneath", async () => {
    fixture.projects = [{ id: "project-1", companyId: "company", name: "Onboarding", urlKey: "onboarding" }];
    fixture.projectTasks.mockResolvedValue([{ id: "task", companyId: "company", projectId: "project-1", identifier: "TASK-42", title: "Prepare launch", status: "todo" }]);
    localStorage.setItem("paperclip.coordinator.pinned-nav.v1:reviewer", JSON.stringify(["project:company:project-1", "/artifacts"]));
    await renderSidebar();
    await act(async () => container.querySelector<HTMLButtonElement>('[aria-label="Expand Onboarding"]')!.click());
    await flush();
    const nativeRect = HTMLElement.prototype.getBoundingClientRect;
    const rect = vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockImplementation(function (this: HTMLElement) {
      const rows = [...container.querySelectorAll(".group\\/coordinator-pin")];
      const index = rows.indexOf(this);
      if (index < 0) return nativeRect.call(this);
      const top = index * 80;
      return { x: 0, y: top, top, bottom: top + 80, left: 0, right: 240, width: 240, height: 80, toJSON() {} };
    });
    try {
      const handle = container.querySelector<HTMLButtonElement>('[aria-label="Reorder pinned Onboarding"]')!;
      handle.focus();
      for (const code of ["Space", "ArrowDown", "Space"]) {
        await act(async () => {
          handle.dispatchEvent(new KeyboardEvent("keydown", { code, key: code === "Space" ? " " : code, bubbles: true, cancelable: true }));
          await new Promise(resolve => setTimeout(resolve, 0));
        });
      }
      const rows = [...container.querySelectorAll(".group\\/coordinator-pin")];
      expect(rows.map(row => row.querySelector("a")?.getAttribute("href"))).toEqual(["/artifacts", "/projects/onboarding/issues"]);
      expect(rows[1]!.querySelector('a[href="/issues/TASK-42"]')).not.toBeNull();
      expect(rows[1]!.querySelector('[aria-label="Collapse Onboarding"]')).not.toBeNull();
    } finally { rect.mockRestore(); }
  });

  it("shows a failed task read without removing project navigation", async () => {
    fixture.projectTasks.mockRejectedValue(new Error("Forbidden"));
    const row = await projectRow(true);
    await act(async () => row.querySelector<HTMLButtonElement>('[aria-label="Expand Onboarding"]')!.click());
    await flush();
    expect(row.querySelector('[role="alert"]')?.textContent).toBe("Couldn’t load tasks.");
    expect(row.querySelector('a[href="/projects/onboarding/issues"]')).not.toBeNull();
  });

  it("does not reuse another person's expanded task cache", async () => {
    fixture.projectTasks.mockResolvedValue([{ id: "task", companyId: "company", projectId: "project-1", identifier: "TASK-42", title: "First person's task", status: "todo" }]);
    const row = await projectRow(false);
    await act(async () => row.querySelector<HTMLButtonElement>('[aria-label="Expand Onboarding"]')!.click());
    await flush();
    expect(row.querySelector('a[href="/issues/TASK-42"]')).not.toBeNull();
    fixture.userId = "another-person";
    fixture.projectTasks.mockResolvedValue([]);
    await renderSidebar();
    const recent = container.querySelector('[aria-label="Recents"]')!;
    expect(recent.querySelector('a[href="/issues/TASK-42"]')).toBeNull();
    await act(async () => recent.querySelector<HTMLButtonElement>('[aria-label="Expand Onboarding"]')!.click());
    await flush();
    expect(recent.querySelector('a[href="/issues/TASK-42"]')).toBeNull();
    expect(recent.textContent).toContain("No tasks yet.");
  });
});

describe("Coordinator with Responsibilities", () => {
  const primaryLinks = () =>
    [...container.querySelectorAll('nav[aria-label="Workspace navigation"] .design-sidebar-primary.my-2 > a, nav[aria-label="Workspace navigation"] .design-sidebar-primary.my-2 > div > a')]
      .map(link => link.getAttribute("href"));
  it("leads Chat, Tasks and Inbox with the Responsibilities home, named Dashboard, and leaves the classic dashboard out of More", async () => {
    fixture.enableResponsibilities = true;
    await renderSidebar();
    expect(primaryLinks()).toEqual(["/responsibilities", "/chats", "/issues", "/decisions"]);
    expect(container.querySelector('a[href="/responsibilities"] svg')?.classList.contains("lucide-compass")).toBe(true);
    expect(container.querySelector('a[href="/responsibilities"]')?.textContent).toBe("Dashboard");
    expect(container.querySelector('a[href="/dashboard"]')).toBeNull();
    await act(async () => container.querySelector<HTMLButtonElement>('button[aria-label="More workspace pages"]')!.click());
    expect(document.querySelector('a[href="/projects"]')).not.toBeNull();
    expect(document.querySelector('a[href="/dashboard"]')).toBeNull();
  });
  it("keeps Chat first with no Responsibilities row while the flag is off", async () => {
    await renderSidebar();
    expect(primaryLinks()).toEqual(["/chats", "/issues", "/decisions"]);
    expect(container.querySelector('a[href="/responsibilities"]')).toBeNull();
  });
});
