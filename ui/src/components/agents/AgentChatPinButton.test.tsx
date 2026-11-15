// @vitest-environment jsdom
import { act, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { Agent, ResourceMemberships, ResourceMembershipUpdateResult, UpdateAgentResourceMembership } from "@paperclipai/shared";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AgentChatPinButton } from "./AgentChatPinButton";
import { CoordinatorSidebar } from "../CoordinatorSidebar";
import { TooltipProvider } from "../ui/tooltip";
import { queryKeys } from "@/lib/queryKeys";

const fixture = vi.hoisted(() => ({
  enabled: true,
  primaryAgentId: null as string | null,
  listMine: vi.fn(),
  updateAgent: vi.fn(),
  pushToast: vi.fn(),
  navigate: vi.fn(),
  agents: [] as Agent[],
}));
vi.mock("@/api/resourceMemberships", () => ({ resourceMembershipsApi: {
  listMine: fixture.listMine, updateAgent: fixture.updateAgent,
} }));
vi.mock("@/context/ToastContext", () => ({ useToastActions: () => ({ pushToast: fixture.pushToast }) }));
vi.mock("@/hooks/useAgentChatEnabled", () => ({ useAgentChatEnabled: () => ({ enabled: fixture.enabled, loaded: true }) }));
vi.mock("../primary-agent/PrimaryAgentPresentation", () => ({ usePrimaryAgentPresentation: () => ({ primaryAgentId: fixture.primaryAgentId, loading: false }) }));
// Keep the actual sidebar selection and membership hooks; isolate unrelated feeds.
vi.mock("@/hooks/useAgentChatNavigation", () => ({ useAgentChatNavigation: () => ({
  companyId: "company", userId: "viewer", agents: { data: fixture.agents }, chats: { data: [] }, session: { isSuccess: true },
}) }));
vi.mock("@/hooks/useCoordinatorAttentionCount", () => ({ useCoordinatorAttentionCount: () => 0 }));
vi.mock("@/hooks/useProjectPmSidebarStatus", () => ({ useProjectPmSidebarStatus: () => new Map() }));
vi.mock("@/hooks/useRecentTasks", () => ({ useRecentTasks: () => ({ entries: [] }) }));
vi.mock("@/hooks/useSharedPolling", () => ({
  useSharedPollingQuery: () => ({ enabled: false, refetchInterval: false }), usePublishSharedQueryData: () => {},
}));
vi.mock("@/context/DialogContext", () => ({ useDialogActions: () => ({ openNewIssue: vi.fn() }) }));
vi.mock("@/context/SidebarContext", () => ({ useSidebar: () => ({ collapsed: false, peeking: false, isMobile: false, setSidebarOpen: vi.fn() }) }));
vi.mock("@/api/projects", () => ({ projectsApi: { list: async () => [] } }));
vi.mock("../SidebarCompanyMenu", () => ({ SidebarCompanyMenu: () => null }));
vi.mock("@/lib/router", () => ({
  useLocation: () => ({ pathname: "/agents/all", search: "" }),
  Link: ({ to, children, ...props }: { to: string; children: ReactNode }) => <a href={to} {...props}>{children}</a>,
  NavLink: ({ to, children, className, state: _state, end: _end, ...props }: {
    to: string; children: ReactNode; className?: string | ((state: { isActive: boolean }) => string); state?: unknown; end?: boolean;
  }) => <a href={to} className={typeof className === "function" ? className({ isActive: false }) : className} {...props}>{children}</a>,
}));

const agent = { id: "research-agent", companyId: "company", name: "Career research", role: "researcher",
  status: "idle", adapterType: "paperclip_runner", urlKey: "career-research", icon: null } as Agent;
const membershipKey = queryKeys.resourceMemberships.mine("company");
const emptyMemberships = (): ResourceMemberships => ({
  projectMemberships: {}, agentMemberships: {}, starredProjectIds: [], starredAgentIds: [], starredDocumentIds: [],
  projectStarredAt: {}, agentStarredAt: {}, documentStarredAt: {}, updatedAt: null,
});
const result = (chatPinned: boolean): ResourceMembershipUpdateResult => ({
  resourceId: agent.id, resourceType: "agent", state: "joined", starredAt: null, chatPinned, updatedAt: new Date(),
});
function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: Error) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

let root: Root, container: HTMLDivElement, client: QueryClient, server: ResourceMemberships;
async function flush() {
  await act(async () => { await new Promise(resolve => setTimeout(resolve, 0)); });
}
async function render(item = agent, sidebar = false) {
  await act(async () => root.render(<QueryClientProvider client={client}><TooltipProvider>
    <a href="/agents/career-research" data-testid="agent-row" onClick={fixture.navigate}><AgentChatPinButton agent={item} /></a>
    {sidebar && <CoordinatorSidebar />}
  </TooltipProvider></QueryClientProvider>));
  await flush();
}
function pinButton() {
  return container.querySelector<HTMLButtonElement>('[data-testid="agent-row"] button')!;
}
function sidebarLink() {
  return container.querySelector('.design-sidebar-agents a[href="/chats/career-research"]');
}
async function clickPin() {
  const event = new MouseEvent("click", { bubbles: true, cancelable: true });
  await act(async () => { pinButton().dispatchEvent(event); });
  await flush();
  return event;
}
function storePin(chatPinned: boolean) {
  server = { ...server, agentMemberships: { ...server.agentMemberships, [agent.id]: "joined" },
    agentChatPins: { ...server.agentChatPins, [agent.id]: chatPinned } };
}

beforeEach(() => {
  vi.resetAllMocks();
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.stubGlobal("ResizeObserver", class { observe() {} unobserve() {} disconnect() {} });
  localStorage.clear();
  fixture.enabled = true;
  fixture.primaryAgentId = null;
  fixture.agents = [agent];
  server = emptyMemberships();
  fixture.listMine.mockImplementation(async () => server);
  fixture.updateAgent.mockImplementation(async (_company: string, _agent: string, change: UpdateAgentResourceMembership) => {
    storePin(change.chatPinned === true);
    return result(change.chatPinned === true);
  });
  client = new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: Infinity }, mutations: { retry: false } } });
  client.setQueryData(membershipKey, server);
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});
afterEach(async () => {
  await act(async () => root.unmount());
  client.clear();
  container.remove();
  vi.unstubAllGlobals();
});

describe("AgentChatPinButton", () => {
  it("pins and unpins through the membership API, updating the real sidebar without navigating", async () => {
    await render(agent, true);
    expect(pinButton().getAttribute("aria-pressed")).toBe("false");
    expect(sidebarLink()).toBeNull();
    const event = await clickPin();
    expect(event.defaultPrevented).toBe(true);
    expect(fixture.navigate).not.toHaveBeenCalled();
    expect(fixture.updateAgent).toHaveBeenLastCalledWith("company", agent.id, { chatPinned: true, starred: undefined, state: undefined });
    expect(pinButton().getAttribute("aria-label")).toBe("Unpin Career research chat");
    expect(sidebarLink()).not.toBeNull();
    expect(client.getQueryData<ResourceMemberships>(membershipKey)?.agentChatPins?.[agent.id]).toBe(true);
    expect(client.getQueryData<ResourceMemberships>(membershipKey)?.starredAgentIds).toEqual([]);

    await clickPin();
    expect(fixture.updateAgent).toHaveBeenLastCalledWith("company", agent.id, { chatPinned: false, starred: undefined, state: undefined });
    expect(pinButton().getAttribute("aria-pressed")).toBe("false");
    expect(sidebarLink()).toBeNull();
    expect(client.getQueryData<ResourceMemberships>(membershipKey)?.agentMemberships[agent.id]).toBe("joined");
    expect(fixture.navigate).not.toHaveBeenCalled();
  });

  it("unpins the automatic primary entry without changing primary identity, stars or membership", async () => {
    fixture.primaryAgentId = agent.id;
    await render(agent, true);
    expect(pinButton().getAttribute("aria-pressed")).toBe("true");
    expect(sidebarLink()).not.toBeNull();
    await clickPin();
    expect(sidebarLink()).toBeNull();
    expect(fixture.primaryAgentId).toBe(agent.id);
    expect(fixture.updateAgent).toHaveBeenLastCalledWith("company", agent.id, { chatPinned: false, starred: undefined, state: undefined });
    expect(client.getQueryData<ResourceMemberships>(membershipKey)?.agentMemberships[agent.id]).toBe("joined");
    // A fresh server read keeps the explicit false, despite the primary fallback.
    await act(async () => { await client.invalidateQueries({ queryKey: membershipKey }); });
    await flush();
    expect(sidebarLink()).toBeNull();
    await clickPin();
    expect(sidebarLink()).not.toBeNull();
    expect(fixture.primaryAgentId).toBe(agent.id);
  });

  it("optimistically rejoins a left agent and blocks repeated clicks while the request is pending", async () => {
    server.agentMemberships[agent.id] = "left";
    client.setQueryData(membershipKey, server);
    const pending = deferred<ResourceMembershipUpdateResult>();
    fixture.updateAgent.mockReturnValueOnce(pending.promise);
    await render(agent, true);
    await clickPin();
    expect(pinButton().disabled).toBe(true);
    expect(pinButton().getAttribute("aria-busy")).toBe("true");
    expect(pinButton().getAttribute("aria-pressed")).toBe("true");
    expect(sidebarLink()).not.toBeNull();
    expect(client.getQueryData<ResourceMemberships>(membershipKey)?.agentMemberships[agent.id]).toBe("joined");
    await act(async () => pinButton().click());
    expect(fixture.updateAgent).toHaveBeenCalledTimes(1);
    storePin(true);
    await act(async () => pending.resolve(result(true)));
    await flush();
    expect(pinButton().disabled).toBe(false);
  });

  it("rolls back the optimistic pin and sidebar entry and reports a failed save", async () => {
    const pending = deferred<ResourceMembershipUpdateResult>();
    fixture.updateAgent.mockReturnValueOnce(pending.promise);
    await render(agent, true);
    await clickPin();
    expect(sidebarLink()).not.toBeNull();
    await act(async () => pending.reject(new Error("Cannot save preference")));
    await flush();
    expect(pinButton().getAttribute("aria-pressed")).toBe("false");
    expect(pinButton().disabled).toBe(false);
    expect(sidebarLink()).toBeNull();
    expect(client.getQueryData<ResourceMemberships>(membershipKey)?.starredAgentIds).toEqual([]);
    expect(fixture.pushToast).toHaveBeenCalledWith(expect.objectContaining({
      title: "Couldn't pin Career research.", body: "Cannot save preference", tone: "error",
    }));
  });

  it("restores the primary chat entry when unpin saving fails", async () => {
    fixture.primaryAgentId = agent.id;
    const pending = deferred<ResourceMembershipUpdateResult>();
    fixture.updateAgent.mockReturnValueOnce(pending.promise);
    await render(agent, true);
    await clickPin();
    expect(sidebarLink()).toBeNull();
    await act(async () => pending.reject(new Error("Cannot save visibility")));
    await flush();
    expect(sidebarLink()).not.toBeNull();
    expect(pinButton().getAttribute("aria-pressed")).toBe("true");
    expect(fixture.primaryAgentId).toBe(agent.id);
    expect(fixture.pushToast).toHaveBeenCalledWith(expect.objectContaining({ title: "Couldn't unpin Career research." }));
  });

  it("disables pinning until memberships load and shows the load error", async () => {
    client.removeQueries({ queryKey: membershipKey });
    const pending = deferred<ResourceMemberships>();
    fixture.listMine.mockReturnValue(pending.promise);
    await render();
    expect(pinButton().disabled).toBe(true);
    await act(async () => pinButton().click());
    expect(fixture.updateAgent).not.toHaveBeenCalled();
    await act(async () => pending.reject(new Error("Memberships unavailable")));
    await flush();
    expect(pinButton().disabled).toBe(true);
    expect(pinButton().title).toContain("Cannot load chat pins");
  });

  it.each([
    { status: "terminated" as const },
    { status: "pending_approval" as const },
    { adapterType: "process" as const },
  ])("does not offer a chat pin for an unavailable agent: %j", async override => {
    await render({ ...agent, ...override });
    expect(pinButton()).toBeNull();
    expect(fixture.updateAgent).not.toHaveBeenCalled();
  });

  it("hides chat pins when Agent Chat is disabled", async () => {
    fixture.enabled = false;
    await render();
    expect(pinButton()).toBeNull();
  });
});
