import { useEffect, useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Bot, CheckCircle2, CircleDashed, CircleX, Loader2, Wrench } from "lucide-react";
import type { HeartbeatRun } from "@paperclipai/shared";
import { agentsApi } from "@/api/agents";
import { heartbeatsApi } from "@/api/heartbeats";
import { issuesApi } from "@/api/issues";
import { StatusBadge } from "@/components/StatusBadge";
import { useLiveRunTranscripts, type RunTranscriptSource } from "@/components/transcript/useLiveRunTranscripts";
import { deriveMainAgentWork, type MainAgentSubagent, type MainAgentWorkStatus } from "@/lib/main-agent-work";
import { useVisibilityRefetchInterval } from "@/lib/polling";
import { queryKeys } from "@/lib/queryKeys";
import { Link } from "@/lib/router";
import { cn, formatDurationMs, formatTokens, relativeTime } from "@/lib/utils";

/**
 * Live view of what a chat agent is doing: the top card is the agent's current
 * (or most recent) run — its task, checklist step, last tool and elapsed time —
 * and the cards below are the native subagents that run opened. It reads the
 * same run transcript as the chat, so any adapter that emits `plan` and
 * `delegation` provider activities is supported.
 */

const RECENT_RUN_LIMIT = 5;
const ACTIVE_STATUSES = new Set(["queued", "running"]);

function toIso(value: Date | string | null | undefined): string | null {
  if (!value) return null;
  return typeof value === "string" ? value : value.toISOString();
}

export function pickMainAgentRun(runs: readonly HeartbeatRun[]): HeartbeatRun | null {
  const byNewest = [...runs].sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime());
  return byNewest.find((run) => ACTIVE_STATUSES.has(run.status)) ?? byNewest[0] ?? null;
}

function useElapsed(startedAt: string | null, running: boolean, finishedAt: string | null): string | null {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!running) return;
    const timer = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(timer);
  }, [running]);
  if (!startedAt) return null;
  const end = running ? now : finishedAt ? new Date(finishedAt).getTime() : null;
  return end === null ? null : formatDurationMs(end - new Date(startedAt).getTime());
}

function SubagentStatusIcon({ status }: { status: MainAgentWorkStatus }) {
  if (status === "running") return <Loader2 className="h-3.5 w-3.5 shrink-0 animate-spin text-blue-600 dark:text-blue-400" aria-label="Running" />;
  if (status === "completed") return <CheckCircle2 className="h-3.5 w-3.5 shrink-0 text-emerald-600 dark:text-emerald-400" aria-label="Completed" />;
  if (status === "failed") return <CircleX className="h-3.5 w-3.5 shrink-0 text-destructive" aria-label="Failed" />;
  return <CircleDashed className="h-3.5 w-3.5 shrink-0 text-muted-foreground" aria-label="Interrupted" />;
}

function SubagentCard({ subagent }: { subagent: MainAgentSubagent }) {
  const meta = [
    subagent.subagentType,
    subagent.toolUses ? `${subagent.toolUses} tools` : null,
    subagent.totalTokens ? `${formatTokens(subagent.totalTokens)} tokens` : null,
  ].filter(Boolean).join(" · ");
  return (
    <li data-testid="main-agent-subagent" className="rounded-lg border border-border bg-card p-3">
      <div className="flex min-w-0 items-start gap-2">
        <span className="mt-0.5"><SubagentStatusIcon status={subagent.status} /></span>
        <span className="min-w-0 flex-1 line-clamp-2 text-sm font-medium">{subagent.title}</span>
      </div>
      {meta && <div className="mt-1 pl-5.5 text-xs text-muted-foreground">{meta}</div>}
      {subagent.status === "running" && subagent.lastToolName && (
        <div className="mt-1 flex items-center gap-1 pl-5.5 text-xs text-muted-foreground">
          <Wrench className="h-3 w-3" /> <span className="font-mono">{subagent.lastToolName}</span>
        </div>
      )}
      {subagent.summary && (
        <details className="mt-1 pl-5.5 text-xs">
          <summary className="cursor-pointer text-muted-foreground">Result</summary>
          <p className="mt-1 whitespace-pre-wrap break-words text-foreground/90">{subagent.summary}</p>
        </details>
      )}
    </li>
  );
}

export function MainAgentLiveWorkPanel({ companyId, agentId }: { companyId: string; agentId: string }) {
  const refetchInterval = useVisibilityRefetchInterval({ visibleMs: 3000 });
  const agentQuery = useQuery({
    queryKey: queryKeys.agents.detail(agentId),
    queryFn: () => agentsApi.get(agentId, companyId),
  });
  const runsQuery = useQuery({
    queryKey: [...queryKeys.heartbeats(companyId, agentId), "main-agent-live-work"],
    queryFn: () => heartbeatsApi.list(companyId, agentId, RECENT_RUN_LIMIT),
    refetchInterval,
  });
  const run = useMemo(() => pickMainAgentRun(runsQuery.data ?? []), [runsQuery.data]);
  const adapterType = agentQuery.data?.adapterType ?? null;
  const sources = useMemo<RunTranscriptSource[]>(() => (run && adapterType ? [{
    id: run.id,
    status: run.status,
    adapterType,
    createdAt: toIso(run.createdAt) ?? undefined,
    logBytes: run.logBytes,
    lastOutputBytes: run.lastOutputBytes,
    logRef: run.logRef,
  }] : []), [adapterType, run]);
  const { transcriptByRun } = useLiveRunTranscripts({ runs: sources, companyId });
  const transcript = run ? transcriptByRun.get(run.id) ?? [] : [];
  const work = useMemo(() => deriveMainAgentWork(transcript), [transcript]);
  const issueQuery = useQuery({
    queryKey: queryKeys.issues.detail(run?.issueId ?? ""),
    queryFn: () => issuesApi.get(run!.issueId!),
    enabled: !!run?.issueId,
    staleTime: 30_000,
  });

  const active = !!run && ACTIVE_STATUSES.has(run.status);
  const elapsed = useElapsed(toIso(run?.startedAt), run?.status === "running", toIso(run?.finishedAt));
  if (runsQuery.isPending) return <p role="status" className="text-sm text-muted-foreground">Loading agent activity…</p>;
  if (!run) return null;

  const issue = issueQuery.data;
  const doing = active
    ? work.currentStep ?? run.currentStatusMessage ?? (work.lastToolName ? `Using ${work.lastToolName}` : "Working…")
    : work.lastAssistantText ?? run.error ?? null;
  const lastTool = active ? run.currentToolName ?? work.lastToolName : null;
  const doneSteps = work.steps.filter((step) => step.status === "completed").length;
  const runningSubagents = work.subagents.filter((subagent) => subagent.status === "running").length;

  return (
    <section aria-label="Agent live work" className="space-y-3">
      <div
        data-testid="main-agent-current"
        className={cn("rounded-xl border p-3", active ? "border-blue-500/30 bg-blue-500/[0.04]" : "border-border bg-card")}
      >
        <div className="flex items-center gap-2 text-xs text-muted-foreground">
          <Bot className="h-3.5 w-3.5" />
          <span className="font-medium uppercase tracking-(--tracking-caps)">{active ? "Now" : "Last run"}</span>
          <StatusBadge status={run.status} />
          {elapsed && <span>{elapsed}</span>}
          {!active && run.finishedAt && <span>· {relativeTime(run.finishedAt)}</span>}
        </div>
        {issue && (
          <Link
            to={`/issues/${issue.identifier ?? issue.id}`}
            disableIssueQuicklook
            className="mt-2 block text-sm font-medium hover:underline"
          >
            <span className="font-mono text-xs text-muted-foreground">{issue.identifier ?? issue.id.slice(0, 8)}</span>{" "}
            {issue.title}
          </Link>
        )}
        {doing && <p className={cn("mt-1 text-sm", active ? "text-foreground" : "line-clamp-4 text-muted-foreground")}>{doing}</p>}
        <div className="mt-2 flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-muted-foreground">
          {work.steps.length > 0 && <span>{doneSteps}/{work.steps.length} steps</span>}
          {lastTool && <span className="inline-flex items-center gap-1"><Wrench className="h-3 w-3" /><span className="font-mono">{lastTool}</span></span>}
          {work.subagents.length > 0 && <span>{runningSubagents > 0 ? `${runningSubagents} subagents running` : `${work.subagents.length} subagents`}</span>}
          <Link to={`/agents/${agentId}/runs/${run.id}`} className="font-mono hover:underline">{run.id.slice(0, 8)}</Link>
        </div>
      </div>
      {work.subagents.length > 0 && (
        <ul aria-label="Subagents" className="space-y-2 pl-3">
          {work.subagents.map((subagent) => <SubagentCard key={subagent.id} subagent={subagent} />)}
        </ul>
      )}
    </section>
  );
}
