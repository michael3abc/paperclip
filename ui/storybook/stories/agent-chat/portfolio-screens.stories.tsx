import { useMemo, useState, type ReactNode } from "react";
import type { Meta, StoryObj } from "@storybook/react-vite";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { Agent } from "@paperclipai/shared";
import { Bot, MessageSquare, ListTodo, ShieldCheck, Users, ChartPie, Layers, ArrowUp } from "lucide-react";
import { AgentTaskCard } from "@/components/chat/AgentWorkPanels";
import { TaskChatSubagentCard } from "@/components/task-chat/TaskChatSubagentCard";
import { TaskTodoPanel } from "@/components/task-side-panel/TaskTodoPanel";
import { IssueThreadInteractionCard } from "@/components/IssueThreadInteractionCard";
import { PmWorkerSettings } from "@/components/PmWorkerSettings";
import { ModelCostPie } from "@/components/ModelCostPies";
import { ProjectUsageTable } from "@/components/ProjectUsageTable";
import { QuotaBar } from "@/components/QuotaBar";
import { ArtifactPreview } from "@/components/artifacts/ArtifactCard";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { queryKeys } from "@/lib/queryKeys";
import { formatDate } from "@/lib/utils";
import { artifacts, demoPdf, modelCosts, now, projectUsage, questions, tasks, todoBody, workers } from "../portfolio/fixtures";
import "../portfolio/portfolio.css";

type Screen = "chat" | "todo" | "questions" | "workers" | "costs" | "artifacts";
const navigation = [
  ["chat", "Agent Chat", MessageSquare], ["todo", "TODO", ListTodo], ["questions", "Decisions", ShieldCheck],
  ["workers", "Workers", Users], ["costs", "Dashboard", ChartPie], ["artifacts", "Artifacts", Layers],
] as const;
const headings: Record<Screen, [string, string]> = {
  chat: ["Agent Chat", "One conversation. Coordinated work."], todo: ["TODO", "A clear goal and a visible next step."],
  questions: ["Decisions", "Routine decisions move forward. People stay in control."], workers: ["Worker policy", "The right worker for each kind of work."],
  costs: ["Dashboard", "Understand usage across models and projects."], artifacts: ["Artifacts", "From agent work to something you can review."],
};
const agentMap = new Map([...["lead", "worker-a", "worker-b"].map((id, i) => [id, { id, name: ["Main agent", "Worker A", "Worker B"][i] } as Agent] as const)]);

function FixtureScope({ children }: { children: ReactNode }) {
  const client = useMemo(() => {
    const cache = new QueryClient({ defaultOptions: { queries: { enabled: false, retry: false, staleTime: Infinity, refetchOnWindowFocus: false, refetchInterval: false } } });
    cache.setQueryData(queryKeys.auth.session, { user: { id: "demo-owner", name: "Owner" } });
    cache.setQueryData(queryKeys.workspacePreferences.mine("demo-owner"), { userId: "demo-owner", coordinatorWorkspaceEnabled: false });
    cache.setQueryData([...queryKeys.issues.documents("demo-plan"), "todo"], { id: "demo-todo", key: "todo", body: todoBody, updatedAt: now });
    cache.setQueryData(["pm-worker-policy", "lead"], workers);
    cache.setQueryData([...queryKeys.costs("demo-lab", undefined, undefined), "by-project"], projectUsage);
    return cache;
  }, []);
  return <QueryClientProvider client={client}>{children}</QueryClientProvider>;
}

// This override is intentionally strict: portfolio stories never forward an API request.
const fixtureFetch = window.fetch;
window.fetch = async (input, init) => {
  const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url, location.origin);
  if (url.pathname === "/api/attachments/demo-report/content") return new Response(demoPdf(), { headers: { "Content-Type": "application/pdf" } });
  if (url.pathname.startsWith("/api/") && location.search.includes("portfolio-screens")) throw new Error("Unexpected portfolio API request");
  return fixtureFetch(input, init);
};

function Chat() {
  return <div className="portfolio-conversation space-y-5">
    <div className="flex justify-end"><p className="max-w-lg rounded-xl bg-primary px-4 py-3 text-sm text-primary-foreground">Prepare the product preview. Keep me posted on progress and decisions.</p></div>
    <div className="flex items-center gap-2 text-sm font-medium"><Bot className="size-5" />Main agent <span className="font-normal text-muted-foreground">· Claude Opus</span></div>
    <p className="text-sm leading-relaxed">The plan is ready. Worker A is building the workspace; Worker B has finished the data checks.</p>
    <div className="space-y-2">{tasks.map((task, i) => <div key={task.id}><div className="mb-1 flex justify-between text-xs text-muted-foreground"><span>{["Worker A · Codex (GPT)", "Worker B · Claude Sonnet"][i]}</span><span>{i ? "Completed" : "In progress"}</span></div><AgentTaskCard task={task} /></div>)}</div>
    <div className="space-y-2"><p className="text-xs font-medium text-muted-foreground">Native subagent</p><TaskChatSubagentCard defaultExpanded subagent={{ id: "accessibility-review", agentType: "Review", description: "Review keyboard navigation", model: "Claude Opus", status: "completed", activity: [], result: "Focus order and control labels are clear. Ready for the final review.", startedAtMs: Date.parse(now) - 42000, finishedAtMs: Date.parse(now) - 2000 }} /></div>
    <div className="flex items-center justify-between rounded-xl border border-border px-4 py-3 text-sm text-muted-foreground"><span>Message Main agent…</span><Button size="icon" aria-label="Send message"><ArrowUp /></Button></div>
  </div>;
}
function Questions() {
  const [items, setItems] = useState(questions);
  const resolve = (outcome: "accepted" | "rejected") => setItems(current => current.map(item => item.kind === "request_confirmation"
    ? { ...item, status: outcome, resolvedByUserId: "demo-owner", resolvedAt: now, result: { version: 1, outcome } } : item));
  return <div className="space-y-6">
    <div className="space-y-2 rounded-lg border border-border p-4"><p className="text-xs font-medium text-muted-foreground">Worker A → Main agent · Answered by main</p><IssueThreadInteractionCard presentationVariant="coordinator-decision" interaction={items[0]} agentMap={agentMap} currentUserId="demo-owner" /></div>
    <div className="space-y-2 rounded-lg border border-border p-4"><p className="text-xs font-medium text-muted-foreground">Worker A → Owner · Human confirmation</p><IssueThreadInteractionCard presentationVariant="coordinator-decision" interaction={items[1]} agentMap={agentMap} currentUserId="demo-owner" onAcceptInteraction={() => resolve("accepted")} onRejectInteraction={() => resolve("rejected")} /></div>
  </div>;
}
function Costs() {
  return <div className="space-y-5">
    <div className="grid gap-4 md:grid-cols-3">{[["API spend", "$46.85"], ["API estimate", "$128.40"], ["Tasks", "39"]].map(([label, value]) => <Card key={label}><CardHeader><CardTitle className="text-sm text-muted-foreground">{label}</CardTitle></CardHeader><CardContent className="font-mono text-2xl">{value}</CardContent></Card>)}</div>
    <div className="grid gap-5 md:grid-cols-2"><Card><CardHeader><CardTitle>Model cost share</CardTitle></CardHeader><CardContent><ModelCostPie whole={modelCosts} valueLabel="API estimate" ariaLabel="Model cost share" /><p className="mt-3 text-xs text-muted-foreground">API-equivalent estimate · not subscription fees</p></CardContent></Card>
      <Card><CardHeader><CardTitle>Subscription quota</CardTitle></CardHeader><CardContent className="space-y-4"><QuotaBar label="Claude Opus · weekly" percentUsed={32} leftLabel="68% remaining" /><QuotaBar label="Codex (GPT) · weekly" percentUsed={24} leftLabel="76% remaining" /><QuotaBar label="Claude Sonnet · weekly" percentUsed={18} leftLabel="82% remaining" /></CardContent></Card></div>
    <Card><CardContent className="pt-5"><ProjectUsageTable companyId="demo-lab" /></CardContent></Card>
  </div>;
}
function Portfolio({ screen }: { screen: Screen }) {
  return <FixtureScope><div className="portfolio-shell bg-background text-foreground">
    <aside className="portfolio-sidebar flex-col border-r border-border bg-sidebar p-5">
      <div className="mb-8 flex items-center gap-2 text-lg font-semibold"><Layers className="size-6" />Paperclip</div>
      <div className="mb-6 rounded-lg border border-border p-3"><p className="text-sm font-medium">Demo Lab</p><p className="text-xs text-muted-foreground">AI workspace</p></div>
      <nav className="space-y-1">{navigation.map(([key, label, Icon]) => <div key={key} className={`flex items-center gap-3 rounded-md px-3 py-2 text-sm ${screen === key ? "bg-sidebar-accent font-medium" : "text-muted-foreground"}`}><Icon className="size-4" />{label}</div>)}</nav>
      <div className="mt-auto text-xs text-muted-foreground">Demo workspace<br />All data is fictional</div>
    </aside>
    <div className="min-w-0 flex-1"><header className="flex items-center justify-between border-b border-border px-5 py-3 text-xs text-muted-foreground"><span>Demo Lab / {headings[screen][0]}</span><span>Fictional data</span></header>
      <main className={`portfolio-main portfolio-${screen} mx-auto space-y-6 p-5 md:p-8`} data-portfolio-ready={screen}>
        <div className="space-y-1"><p className="text-xs uppercase tracking-wide text-muted-foreground">Demo Lab</p><h1 className="text-2xl font-semibold">{headings[screen][0]}</h1><p className="text-sm text-muted-foreground">{headings[screen][1]}</p></div>
        {screen === "chat" ? <Chat /> : screen === "todo" ? <TaskTodoPanel issue={{ id: "demo-plan", identifier: "DEMO-20" }} /> : screen === "questions" ? <Questions /> : screen === "workers" ? <PmWorkerSettings agentId="lead" /> : screen === "costs" ? <Costs /> : <div className="portfolio-artifact-grid grid grid-cols-2 gap-4">{artifacts.map(artifact => <Card key={artifact.id} className="gap-0 overflow-hidden py-0"><ArtifactPreview artifact={artifact} /><CardContent className="space-y-2 p-3"><h3 className="text-sm font-medium" title={artifact.title}>{artifact.title}</h3><p className="text-xs text-muted-foreground">Last edited {formatDate(artifact.updatedAt)} · Worker B</p></CardContent></Card>)}</div>}
      </main>
    </div>
  </div></FixtureScope>;
}
const meta = {
  id: "portfolio-screens", title: "Tasks and conversations/Agent conversations and project handoff/Portfolio screens", component: Portfolio,
  parameters: { layout: "fullscreen", paperclip: { capabilities: ["agent-chat/history", "budgets-costs/cost-reporting"], status: "mixed", implementation: "mixed", boundary: "fixtures", notes: "Fictional portfolio compositions of shipped task, subagent, TODO, decision, worker, pie, quota and artifact components. The shell and conversation copy are story-only. Not a live backend or provider acceptance test." } },
} satisfies Meta<typeof Portfolio>;
export default meta;
type Story = StoryObj<typeof meta>;
export const AgentChat: Story = { args: { screen: "chat" } };
export const Todo: Story = { args: { screen: "todo" } };
export const QuestionsAndApprovals: Story = { args: { screen: "questions" } };
export const WorkerPolicy: Story = { args: { screen: "workers" } };
export const DashboardCosts: Story = { args: { screen: "costs" } };
export const ArtifactsWall: Story = { args: { screen: "artifacts" } };
