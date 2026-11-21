import { isAgentChatVisible } from "@/lib/agent-chat-visibility";
import { useEffect, useMemo, useRef, useState, type ReactNode, useLayoutEffect } from "react";
import { useQuery } from "@tanstack/react-query";
import { Inbox, Bell, Boxes, ChevronRight, CircleCheck, FolderOpen, History, LayoutDashboard, MessageCircle, Mic, MoreHorizontal, Network, Pin, PinOff, Plus, Repeat, Search, Settings, SquarePen, Unplug, Compass, type LucideIcon } from "lucide-react";
import type { Project, Agent, IssueSummary } from "@paperclipai/shared";
import { useCoordinatorAttentionCount } from "@/hooks/useCoordinatorAttentionCount";
import { heartbeatsApi } from "@/api/heartbeats";
import { issuesApi } from "@/api/issues";

import { instanceSettingsApi } from "@/api/instanceSettings";
import { useAgentChatNavigation } from "@/hooks/useAgentChatNavigation";
import { useResponsibilitiesEnabled } from "@/hooks/useResponsibilitiesEnabled";
import { useRecentTasks } from "@/hooks/useRecentTasks";
import { useResourceMemberships } from "@/hooks/useResourceMemberships";
import { useRecentTaskOpenWarmup } from "@/hooks/useRecentTaskOpenWarmup";
import { usePinnedNavigation } from "@/hooks/usePinnedNavigation";
import { usePublishSharedQueryData, useSharedPollingQuery } from "@/hooks/useSharedPolling";
import { useDialogActions } from "@/context/DialogContext";
import { useSidebar } from "@/context/SidebarContext";
import { useProjectPmSidebarStatus } from "@/hooks/useProjectPmSidebarStatus";
import { deriveChatRunningSubagentAgentIds, deriveChatWaitingForTaskAgentIds, nextRunningSubagentsExpiry } from "@/lib/agent-sidebar-status";
import { queryKeys } from "@/lib/queryKeys";
import type { RecentTaskEntry } from "@/lib/recent-tasks";
import { Link, useLocation } from "@/lib/router";
import { agentRouteRef, cn, projectRouteRef } from "@/lib/utils";
import { AgentAvatar } from "./AgentAvatar";
import { SidebarCompanyMenu } from "./SidebarCompanyMenu";
import { SidebarNavItem } from "./SidebarNavItem";
import { RecentTaskNavItem, recentTaskPathRef } from "./RecentTaskNavItem";
import { SidebarSection } from "./SidebarSection";
import { TruncatedTextMarqueeProvider } from "./TruncatedText";
import { useScrollbarWhileScrolling } from "./side-panel/use-scrollbar-while-scrolling";
import { Flyout, FlyoutContent, FlyoutTrigger, FlyoutAppearanceProvider } from "./ui/flyout";
import { Button } from "./ui/button";
import { Tooltip, TooltipContent, TooltipTrigger } from "./ui/tooltip";
import { StatusIcon } from "./StatusIcon";
import { taskStatusIconProps } from "@/lib/task-status-presentation";
import { agentChatPinKey } from "./AgentChatPin";
import { PinnedNavigationList, type PinnedNavigationItem } from "./PinnedNavigationList";
import { companyProjectsQuery } from "@/lib/company-projects-query";
import { SidebarProjectTasks } from "./SidebarProjectTasks";

import { usePrimaryAgentPresentation } from "./primary-agent/PrimaryAgentPresentation";

const NO_RECENT_TASKS: never[] = [];
const TASK_PIN_ID_PATTERN = /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i;
const taskPinKey = (companyId: string, id: string) => `task:${companyId}:${id}`;
const projectPinKey = (project: Project) => `project:${project.companyId}:${project.id}`;

const moreDestinations = [
  { label: "Search", to: "/search", icon: Search },
  { label: "Dashboard", to: "/dashboard", icon: LayoutDashboard },
  { label: "Projects", to: "/projects", icon: FolderOpen },
  { label: "Routines", to: "/routines", icon: Repeat },
  { label: "Artifacts", to: "/artifacts", icon: Boxes },
  { label: "Agents", to: "/agents/all", icon: Network },
  { label: "Voice", to: "/voice", icon: Mic },
  { label: "Skills", to: "/skills", icon: Boxes },
  { label: "Connectors", to: "/apps", icon: Unplug },
  { label: "Audit", to: "/activity", icon: History },
  { label: "Settings", to: "/settings", icon: Settings },
] as const;

export function buildPinnedNavigationItems(
  pins: readonly string[],
  agents: readonly Agent[],
  destinations: readonly { to: string; label: string; icon: LucideIcon }[],
  tasks: readonly IssueSummary[] = [],
  projects: readonly Project[] = [],
): PinnedNavigationItem[] {
  if (!pins.length) return [];
  const keys = new Set(pins);
  const items = new Map<string, PinnedNavigationItem>(destinations.map(item => [item.to, { key: item.to, to: item.to, label: item.label, icon: <item.icon className="size-4" /> }]));
  for (const agent of agents) {
    const key = agentChatPinKey(agent.companyId, agent.id);
    if (keys.has(key)) items.set(key, { key, to: `/chats/${encodeURIComponent(agentRouteRef(agent))}`, label: agent.name, icon: <AgentAvatar agent={agent} size={16} /> });
  }
  for (const task of tasks) {
    const key = taskPinKey(task.companyId, task.id);
    if (keys.has(key)) items.set(key, { key, to: `/issues/${recentTaskPathRef(task)}`, label: task.title, icon: <StatusIcon {...taskStatusIconProps(task)} />, task });
  }
  for (const project of projects) {
    const key = projectPinKey(project);
    if (keys.has(key)) items.set(key, { key, to: `/projects/${projectRouteRef(project)}/issues`, label: project.name, icon: <FolderOpen className="size-4" />, project });
  }
  return pins.flatMap(key => {
    const item = items.get(key);
    return item ? [item] : [];
  });
}

type PinControls = { keys: ReadonlySet<string>; canPin: boolean; toggle: (key: string) => void };
type RecentTaskLink = Omit<RecentTaskEntry, "recordedAt">;

function NavigationPinButton({ pinKey, label, pins, className }: { pinKey: string; label: string; pins: PinControls; className: string }) {
  const pinned = pins.keys.has(pinKey);
  const Icon = pinned ? PinOff : Pin;
  const actionLabel = `${pinned ? "Unpin" : "Pin"} ${label}`;
  return <button type="button" aria-label={actionLabel} title={actionLabel} aria-pressed={pinned} disabled={!pins.canPin}
    onClick={() => pins.toggle(pinKey)} className={cn("absolute top-1/2 flex -translate-y-1/2 items-center justify-center rounded-md outline-none focus-visible:ring-2 focus-visible:ring-ring hover:text-foreground", pinned ? "text-foreground" : "text-muted-foreground", className)}>
    <Icon aria-hidden className="size-3.5" />
  </button>;
}

function RecentPinRow({ pinKey, label, pins, children }: { pinKey: string; label: string; pins: PinControls; children: ReactNode }) {
  if (!pins.canPin) return <>{children}</>;
  return <div className="design-sidebar-pin-target relative min-w-0">
    {children}
    <NavigationPinButton pinKey={pinKey} label={label} pins={pins} className="right-3 size-7" />
  </div>;
}

function RecentTaskPinRow({ task, pins }: { task: RecentTaskLink; pins: PinControls }) {
  return <RecentPinRow pinKey={taskPinKey(task.companyId, task.id)} label={task.title} pins={pins}>
    <RecentTaskNavItem className="design-sidebar-item" task={task} label={task.title} iconNode={<StatusIcon {...taskStatusIconProps(task)} />} />
  </RecentPinRow>;
}

function RecentNavigationList({ children }: { children: ReactNode }) {
  const scrollRef = useRef<HTMLDivElement>(null);
  const contentRef = useRef<HTMLDivElement>(null);
  const handleScroll = useScrollbarWhileScrolling();
  useLayoutEffect(() => {
    const viewport = scrollRef.current;
    if (!viewport) return;
    const measure = () => {
      viewport.dataset.overflowTop = String(viewport.scrollTop > 1);
      viewport.dataset.overflowBottom = String(viewport.scrollHeight - viewport.clientHeight - viewport.scrollTop > 1);
    };
    measure();
    viewport.addEventListener("scroll", measure, { passive: true });
    const observer = typeof ResizeObserver === "undefined" ? null : new ResizeObserver(measure);
    observer?.observe(viewport);
    if (contentRef.current) observer?.observe(contentRef.current);
    return () => { viewport.removeEventListener("scroll", measure); observer?.disconnect(); };
  }, []);
  return <div ref={scrollRef} className="design-sidebar-recent-list scrollbar-while-scrolling" onScroll={handleScroll} role="region" aria-label="Recents" tabIndex={0}>
    <div ref={contentRef} className="design-sidebar-recent-content">{children}</div>
  </div>;
}

/** The navigation is a view of the existing records; it never creates a chat
 * or task just because someone visits or switches agents. */
export function CoordinatorSidebar({ children }: { children?: ReactNode }) {
  const { companyId, userId, agents, chats, session } = useAgentChatNavigation();
  const primaryAgentId = usePrimaryAgentPresentation(companyId)?.primaryAgentId;
  const unreadChatCount = chats.data?.filter(chat => chat.isUnreadForMe).length ?? 0;
  const pinnedNavigation = usePinnedNavigation(userId);
  const pinKeys = useMemo(() => new Set(pinnedNavigation.pins), [pinnedNavigation.pins]);
  const pins = { keys: pinKeys, canPin: pinnedNavigation.canPin, toggle: pinnedNavigation.toggle };
  const pinnedTaskIds = useMemo(() => {
    if (!companyId || !session.isSuccess) return [];
    const prefix = taskPinKey(companyId, "");
    return pinnedNavigation.pins.flatMap(key => {
      if (!key.startsWith(prefix)) return [];
      const id = key.slice(prefix.length);
      return TASK_PIN_ID_PATTERN.test(id) ? [id] : [];
    });
  }, [companyId, pinnedNavigation.pins, session.isSuccess]);
  const { data: experimental } = useQuery({
    queryKey: queryKeys.instance.experimentalSettings,
    queryFn: () => instanceSettingsApi.getExperimental(),
  });
  // Responsibilities (experimental) is home, named Dashboard, and leads Chat,
  // Tasks and Inbox. The classic dashboard leaves More: one Dashboard at a time.
  const { enabled: responsibilitiesHome } = useResponsibilitiesEnabled();
  const destinations = useMemo(() => {
    const base = responsibilitiesHome
      ? moreDestinations.filter((item) => item.to !== "/dashboard")
      : moreDestinations;
    return experimental?.enableCases ? [...base, { label: "Cases", to: "/cases", icon: Boxes }] : base;
  }, [experimental?.enableCases, responsibilitiesHome]);
  const [moreOpen, setMoreOpen] = useState(false);
  const [recentsOpen, setRecentsOpen] = useState(true);
  const moreContentRef = useRef<HTMLDivElement>(null);
  const { entries: recentTasks, pinnedTasks } = useRecentTasks({ companyId, userId, pinnedTaskIds });
  const { isMobile, setSidebarOpen } = useSidebar();
  // Warm opens only while the Recents list is on screen.
  const location = useLocation();
  useRecentTaskOpenWarmup({ companyId, userId, tasks: session.isSuccess ? recentTasks : NO_RECENT_TASKS, navigationKey: location.pathname });
  const { openNewIssue } = useDialogActions();
  const attentionCount = useCoordinatorAttentionCount(companyId);
  const { data: projects } = useQuery({ ...companyProjectsQuery(companyId!), enabled: !!companyId });
  const orderedPins = useMemo(() => buildPinnedNavigationItems(pinnedNavigation.pins, agents.data ?? [], destinations,
    pinnedTasks, session.isSuccess ? projects : undefined), [pinnedNavigation.pins, agents.data, destinations, pinnedTasks, projects, session.isSuccess]);
  // Only project IDs and visit times are kept in memory. Labels and task lists
  // always come from the authorized API, scoped to the current person/company.
  const scope = `${companyId}:${userId}`;
  const [projectVisits, setProjectVisits] = useState<{ scope: string; entries: Record<string, number> }>({ scope, entries: {} });
  useEffect(() => {
    const ref = location.pathname.match(/\/projects\/([^/]+)/)?.[1];
    const project = projects?.find(item => item.id === ref || projectRouteRef(item) === ref);
    if (!project) return;
    setProjectVisits(previous => ({ scope, entries: { ...(previous.scope === scope ? previous.entries : {}), [project.id]: Date.now() } }));
  }, [location.pathname, projects, scope]);
  const agentMemberships = useResourceMemberships(companyId);
  // Live-run ownership remains with this navigation entry.
  const liveRunsQueryKey = queryKeys.liveRuns(companyId!);
  const sharedLiveRuns = useSharedPollingQuery({ companyId, resourceKey: "live-runs", queryKey: liveRunsQueryKey, enabled: !!companyId,
    // Event-sourced via LiveUpdatesProvider; no interval poll needed.
    refetchInterval: false, leaderOnly: true });
  const liveRuns = useQuery({ queryKey: liveRunsQueryKey, queryFn: () => heartbeatsApi.liveRunsForCompany(companyId!),
    enabled: sharedLiveRuns.enabled, refetchInterval: sharedLiveRuns.refetchInterval });
  usePublishSharedQueryData(sharedLiveRuns, liveRuns.data, liveRuns.dataUpdatedAt);
  const listedAgents = useMemo(() => (agents.data ?? [])
    // Explicit chat pins override primary/role/star defaults, without changing identity.
    .filter(agent => isAgentChatVisible(agent, agentMemberships.data, primaryAgentId))
    .sort((left, right) => Number(right.id === primaryAgentId) - Number(left.id === primaryAgentId)
      || left.name.localeCompare(right.name, undefined, { sensitivity: "base" })),
  [agents.data, agentMemberships.data, agentMemberships.isSuccess, primaryAgentId]);
  // Listed agents that are not project PMs (project main agents) work in their
  // own runs, including native subagents inside that run, so their own running
  // run marks them working. PM-bound agents keep the project rules.
  const listedAgentIds = useMemo(() => listedAgents.map(agent => agent.id), [listedAgents]);
  const pmStatusByAgent = useProjectPmSidebarStatus(companyId, userId, liveRuns.data, { selfRunAgentIds: listedAgentIds });
  // Purple "waiting for task": the chat list (refreshed by run lifecycle events)
  // says a task this chat created is still live, and the agent is not working
  // itself. Working and needs-input keep their existing indicators.
  const waitingAgentIds = useMemo(() => deriveChatWaitingForTaskAgentIds({ chats: chats.data, liveRuns: liveRuns.data }),
    [chats.data, liveRuns.data]);
  // Blue "working" while native subagents the chat started still run after its own run ended. The server only
  // vouches for them until a bound, so a clock tick at that bound clears the row even if the list is not refetched.
  const [subagentClock, setSubagentClock] = useState(() => Date.now());
  const subagentExpiry = useMemo(() => nextRunningSubagentsExpiry(chats.data, subagentClock), [chats.data, subagentClock]);
  useEffect(() => {
    if (subagentExpiry === null) return;
    const timer = setTimeout(() => setSubagentClock(Date.now()), Math.max(0, subagentExpiry - Date.now()) + 50);
    return () => clearTimeout(timer);
  }, [subagentExpiry]);
  const subagentAgentIds = useMemo(() => deriveChatRunningSubagentAgentIds({ chats: chats.data, liveRuns: liveRuns.data, now: subagentClock }),
    [chats.data, liveRuns.data, subagentClock]);
  const agentRows = useMemo(() => {
    const unreadAgentIds = new Set((chats.data ?? []).flatMap(chat => chat.isUnreadForMe && chat.conversationAgentId ? [chat.conversationAgentId] : []));
    // Owner input (`needs_input`) outranks subagent work, which outranks waiting for a task.
    return listedAgents.map(agent => ({ agent, unread: unreadAgentIds.has(agent.id),
      status: pmStatusByAgent.get(agent.id) ?? (subagentAgentIds.has(agent.id) ? "working" as const
        : waitingAgentIds.has(agent.id) ? "waiting_for_task" as const : undefined) }));
  }, [listedAgents, chats.data, pmStatusByAgent, waitingAgentIds, subagentAgentIds]);
  const activeChatRef = location.pathname.match(/\/chats\/([^/]+)/)?.[1];
  const agentsFailed = agents.isError;
  const agentsLoading = agents.isPending && agents.fetchStatus === "fetching";
  const recents = useMemo(() => {
    const roster = new Map((agents.data ?? []).map(agent => [agent.id, agent]));
    const taskRows = recentTasks.map(task => ({ kind: "task" as const, id: task.id, time: task.recordedAt, task }));
    const chatRows = (chats.data ?? []).flatMap(chat => {
      const agent = chat.conversationAgentId ? roster.get(chat.conversationAgentId) : null;
      return agent ? [{ kind: "chat" as const, id: chat.id, time: new Date(chat.updatedAt).getTime(), agent }] : [];
    });
    const projectRows = (projects ?? []).flatMap(project => projectVisits.scope === scope && projectVisits.entries[project.id]
      ? [{ kind: "project" as const, id: project.id, time: projectVisits.entries[project.id]!, project }] : []);
    return [...taskRows, ...chatRows, ...projectRows].sort((a, b) => b.time - a.time);
  }, [agents.data, chats.data, recentTasks, projects, projectVisits, scope]);
  const newTaskButton = <Button type="button" variant="ghost" className="design-sidebar-new-task rounded-lg" aria-label="New task" onClick={() => openNewIssue()}>
    <SquarePen aria-hidden />
    <span className="truncate">New task</span>
  </Button>;
  return <FlyoutAppearanceProvider><TruncatedTextMarqueeProvider><aside className="coordinator-sidebar design-sidebar w-full">
    <div className="design-sidebar-brand">
      <SidebarCompanyMenu showChevron={false} />
      <Tooltip><TooltipTrigger asChild><Button variant="ghost" size="icon-sm" className="design-sidebar-search" aria-label="Global search" onClick={() => document.dispatchEvent(new KeyboardEvent("keydown", { key: "k", metaKey: true, bubbles: true, cancelable: true }))}><Search aria-hidden /></Button></TooltipTrigger><TooltipContent side="right">Search tasks, agents, projects</TooltipContent></Tooltip>
    </div>
    <nav className="design-sidebar-navigation" aria-label="Workspace navigation">
      <div className="design-sidebar-primary">
        {newTaskButton}
        <div className="design-sidebar-primary my-2">
          {responsibilitiesHome && <SidebarNavItem className="design-sidebar-item" to="/responsibilities" label="Dashboard" icon={Compass} />}
          <SidebarNavItem className="design-sidebar-item" to="/chats" label="Chat" icon={MessageCircle} badge={unreadChatCount} badgeLabel="unread chats" />
          <div className="group/coordinator-new relative">
            <SidebarNavItem to="/issues" label="Tasks" icon={CircleCheck} className="design-sidebar-item pr-9" />
            <button type="button" aria-label="New task" title="New task" onClick={() => openNewIssue()}
              className="absolute right-3 top-1/2 -translate-y-1/2 rounded-md p-1 text-muted-foreground opacity-0 transition-opacity group-hover/coordinator-new:opacity-100 group-focus-within/coordinator-new:opacity-100 pointer-coarse:opacity-100 hover:bg-sidebar-accent focus-visible:ring-2 focus-visible:ring-ring"><Plus className="size-4" /></button>
          </div>
          <SidebarNavItem className="design-sidebar-item" to="/decisions" label="Inbox" icon={Inbox} badge={attentionCount} badgeLabel="decisions" />
          {orderedPins.length > 0 && <PinnedNavigationList key={`${companyId}:${userId}`} items={orderedPins} userId={userId} onReorder={pinnedNavigation.reorder} onUnpin={pinnedNavigation.toggle} />}
        </div>
        <Flyout open={moreOpen} onOpenChange={setMoreOpen}>
          <FlyoutTrigger asChild><button type="button" aria-label="More workspace pages" className="design-sidebar-item flex w-auto items-center gap-2.5 rounded-lg py-1.5 text-left transition-colors focus-visible:ring-2 focus-visible:ring-ring"><MoreHorizontal className="size-4 shrink-0" /><span>More</span></button></FlyoutTrigger>
          <FlyoutContent ref={moreContentRef} tabIndex={-1} onOpenAutoFocus={(event) => { event.preventDefault(); moreContentRef.current?.focus(); }} side={isMobile ? "bottom" : "right"} align="start" className="w-56 p-1" aria-label="More workspace pages">
            {destinations.map(({ label, to, icon: Icon }, index) => <div key={to}>
                {index === 6 || index === 10 ? <div role="separator" className="my-1 border-t border-border" /> : null}
                <div className="group/navigation-pin relative flex items-center rounded-sm transition-colors hover:bg-accent">
                  <Link to={to} onClick={() => { setMoreOpen(false); if (isMobile) setSidebarOpen(false); }} className="flex min-w-0 flex-1 items-center gap-2 rounded-sm px-2 py-1.5 pr-10 text-sm outline-none focus-visible:ring-2 focus-visible:ring-ring">
                    <Icon className="size-4 shrink-0 text-muted-foreground" />{label}
                  </Link>
                  <NavigationPinButton pinKey={to} label={label} pins={pins} className="right-0.5 size-8 rounded-sm opacity-0 transition-opacity group-hover/navigation-pin:opacity-100 group-focus-within/navigation-pin:opacity-100 pointer-coarse:opacity-100" />
                </div>
              </div>)}
          </FlyoutContent>
        </Flyout>
      </div>
      {pinnedNavigation.error && <p role="alert" className="px-4 py-2 text-xs text-destructive">{pinnedNavigation.error}</p>}
      {(agentRows.length > 0 || agentsFailed || agentsLoading) && <div className="design-sidebar-agents"><SidebarSection label="Agents">
        {agentsFailed && !agentRows.length
          ? <p role="alert" className="px-4 py-1.5 text-xs text-destructive">Couldn’t load agents. <button type="button" className="underline focus-visible:ring-2 focus-visible:ring-ring" onClick={() => { void agents.refetch(); }}>Retry</button></p>
          : agentsLoading && !agentRows.length
            ? <p role="status" className="px-4 py-1.5 text-xs text-muted-foreground">Loading agents…</p>
            : agentRows.map(({ agent, unread, status }) => <SidebarNavItem className="design-sidebar-item" key={agent.id}
              to={`/chats/${encodeURIComponent(agentRouteRef(agent))}`} label={agent.name}
              iconNode={<AgentAvatar agent={agent} size={20} />}
              active={activeChatRef !== undefined && (activeChatRef === agent.id || activeChatRef === encodeURIComponent(agentRouteRef(agent)))}
              status={status}
              badge={unread ? 1 : undefined} badgeLabel="unread chat" />)}
        {liveRuns.isError && agentRows.length > 0 && <p role="alert" className="px-4 py-1.5 text-xs text-destructive">Couldn’t load agent activity. <button type="button" className="underline focus-visible:ring-2 focus-visible:ring-ring" onClick={() => { void liveRuns.refetch(); }}>Retry</button></p>}
      </SidebarSection></div>}
      {session.isSuccess && recents.length > 0 && <div className="design-sidebar-recents"><SidebarSection label="Recents" collapsible={{ open: recentsOpen, onOpenChange: setRecentsOpen }}>
        <RecentNavigationList>
        {recents.map(item => item.kind === "task"
          ? <RecentTaskPinRow key={`${scope}:${item.id}`} task={item.task} pins={pins} />
          : item.kind === "chat"
            ? <RecentPinRow key={item.id} pinKey={agentChatPinKey(item.agent.companyId, item.agent.id)} label={item.agent.name} pins={pins}>
                <SidebarNavItem className="design-sidebar-item" to={`/chats/${encodeURIComponent(agentRouteRef(item.agent))}`} label={item.agent.name} iconNode={<AgentAvatar agent={item.agent} size={16} />} />
              </RecentPinRow>
            : <SidebarProjectTasks key={`${scope}:${item.id}`} project={item.project} userId={userId}
                renderTask={task => <RecentTaskPinRow task={task} pins={pins} />}>
                <RecentPinRow pinKey={projectPinKey(item.project)} label={item.project.name} pins={pins}>
                  <SidebarNavItem className="design-sidebar-item" to={`/projects/${projectRouteRef(item.project)}/issues`} label={item.project.name} icon={FolderOpen} />
                </RecentPinRow>
              </SidebarProjectTasks>)}
        </RecentNavigationList>
      </SidebarSection></div>}
      {children}
    </nav>
  </aside></TruncatedTextMarqueeProvider></FlyoutAppearanceProvider>;
}
