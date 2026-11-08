import type { TranscriptEntry } from "../adapters";

/**
 * Live work of a project main agent, derived from one run transcript.
 *
 * Adapters report the main agent's checklist as a `plan` provider activity
 * (ccpocket maps Claude `TodoWrite` to `planId: "todo"`) and each native
 * subagent as a `delegation` activity keyed by `payload.delegationId`. Every
 * delegation emission carries the subagent's full state, so the latest entry
 * per id wins while the first appearance keeps the card order stable.
 */

export type MainAgentWorkStatus = "running" | "completed" | "failed" | "interrupted";

export interface MainAgentPlanStep {
  id: string;
  body: string;
  status: "pending" | "in_progress" | "completed";
}

export interface MainAgentSubagent {
  id: string;
  title: string;
  subagentType: string | null;
  status: MainAgentWorkStatus;
  lastToolName: string | null;
  /** Latest progress text of a running subagent (Claude task_progress). */
  activity: string | null;
  summary: string | null;
  totalTokens: number | null;
  toolUses: number | null;
  startedAt: string;
  updatedAt: string;
}

/** Main session context fill (ccpocket `context` / `context.usage` activity). */
export interface MainAgentContextUsage {
  used: number;
  window: number;
  percent: number;
}

export interface MainAgentWork {
  steps: MainAgentPlanStep[];
  currentStep: string | null;
  lastToolName: string | null;
  lastAssistantText: string | null;
  subagents: MainAgentSubagent[];
  context: MainAgentContextUsage | null;
}

const STEP_STATUSES = new Set(["pending", "in_progress", "completed"]);

function text(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function count(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : null;
}

function workStatus(value: string): MainAgentWorkStatus {
  return value === "completed" || value === "failed" || value === "interrupted" ? value : "running";
}

function planSteps(payload: Record<string, unknown>): MainAgentPlanStep[] {
  if (!Array.isArray(payload.steps)) return [];
  return payload.steps.flatMap((raw, index) => {
    if (!raw || typeof raw !== "object") return [];
    const step = raw as Record<string, unknown>;
    const body = text(step.body);
    if (!body) return [];
    const status = typeof step.status === "string" && STEP_STATUSES.has(step.status) ? step.status : "pending";
    return [{ id: text(step.stepId) ?? `step:${index}`, body, status: status as MainAgentPlanStep["status"] }];
  });
}

export function deriveMainAgentWork(entries: readonly TranscriptEntry[]): MainAgentWork {
  let steps: MainAgentPlanStep[] = [];
  let lastToolName: string | null = null;
  let lastAssistantText: string | null = null;
  const subagents = new Map<string, MainAgentSubagent>();
  let context: MainAgentContextUsage | null = null;

  for (const entry of entries) {
    if (entry.kind === "tool_call") {
      lastToolName = entry.name;
    } else if (entry.kind === "assistant" && !entry.delta) {
      lastAssistantText = text(entry.text) ?? lastAssistantText;
    } else if (entry.kind === "provider_activity" && entry.family === "plan") {
      steps = planSteps(entry.payload);
    } else if (entry.kind === "provider_activity" && entry.family === "context" && entry.eventType === "context.usage") {
      const used = count(entry.payload.currentTokens);
      const window = count(entry.payload.modelContextWindow);
      if (used !== null && window !== null) context = { used, window, percent: Math.min(100, Math.round((used / window) * 100)) };
    } else if (entry.kind === "provider_activity" && entry.family === "delegation") {
      const payload = entry.payload;
      const id = text(payload.delegationId);
      if (!id) continue;
      const usage = payload.usage && typeof payload.usage === "object" ? payload.usage as Record<string, unknown> : {};
      const prior = subagents.get(id);
      subagents.set(id, {
        id,
        title: text(payload.description) ?? text(entry.title) ?? "Subagent",
        subagentType: text(payload.subagentType),
        status: workStatus(entry.status),
        lastToolName: text(payload.lastToolName),
        activity: entry.status === "running" ? text(payload.activity) : null,
        summary: entry.status === "running" ? null : text(entry.summary),
        totalTokens: count(usage.totalTokens),
        toolUses: count(usage.toolUses),
        startedAt: prior?.startedAt ?? entry.ts,
        updatedAt: entry.ts,
      });
    }
  }

  const current = steps.find((step) => step.status === "in_progress");
  return {
    steps,
    currentStep: current?.body ?? null,
    lastToolName,
    lastAssistantText,
    subagents: [...subagents.values()],
    context,
  };
}
