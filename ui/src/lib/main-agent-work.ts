import type { TranscriptEntry } from "../adapters";

/**
 * Live work of a project main agent, derived from one run transcript.
 *
 * Adapters report the main agent's checklist as a `plan` provider activity
 * (ccpocket maps Claude `TodoWrite` to `planId: "todo"`) and each native
 * subagent as a `delegation` activity keyed by `payload.delegationId`. Every
 * delegation emission carries the subagent's full state, so the latest entry
 * per id wins while the first appearance keeps the card order stable. When the
 * transcript has Claude's checklist tool calls, the steps are rebuilt from them
 * instead of the (parse-order dependent) plan activity.
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

function stepStatus(value: unknown): MainAgentPlanStep["status"] | null {
  return typeof value === "string" && STEP_STATUSES.has(value) ? value as MainAgentPlanStep["status"] : null;
}

function inputOf(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" ? value as Record<string, unknown> : {};
}

const TASK_CREATED = /Task #(\d+) created/;

/**
 * Claude's own checklist, rebuilt from its stateless tool entries (TodoWrite,
 * or TaskCreate + its "Task #N created" result + TaskUpdate). A sandboxed
 * adapter parser is shared page-wide and caches each line's output, so a
 * `plan` activity first parsed for a tail-only log window can carry a
 * partial list; the tool entries themselves never depend on parse order.
 */
class ChecklistBuilder {
  private tasks = new Map<string, { subject: string; activeForm: string | null; status: MainAgentPlanStep["status"] }>();
  private pendingCreates = new Map<string, string>();
  private todo: MainAgentPlanStep[] = [];
  source: "tasks" | "todo" | null = null;

  call(entry: Extract<TranscriptEntry, { kind: "tool_call" }>, index: number) {
    const input = inputOf(entry.input);
    if (entry.name === "TodoWrite" && Array.isArray(input.todos)) {
      this.source = "todo";
      this.todo = input.todos.flatMap((raw, i) => {
        const todo = inputOf(raw);
        const status = stepStatus(todo.status) ?? "pending";
        const body = text(status === "in_progress" ? todo.activeForm ?? todo.content : todo.content);
        return body ? [{ id: `todo:${i}`, body, status }] : [];
      });
    } else if (entry.name === "TaskCreate") {
      const subject = text(input.subject);
      if (!subject) return;
      this.source = "tasks";
      const key = `pending:${entry.toolUseId ?? index}`;
      this.tasks.set(key, { subject, activeForm: text(input.activeForm), status: "pending" });
      if (entry.toolUseId) this.pendingCreates.set(entry.toolUseId, key);
    } else if (entry.name === "TaskUpdate") {
      const key = typeof input.taskId === "string" || typeof input.taskId === "number" ? String(input.taskId) : "";
      if (!key) return;
      this.source = "tasks";
      if (input.status === "deleted") { this.tasks.delete(key); return; }
      const prior = this.tasks.get(key);
      this.tasks.set(key, {
        subject: text(input.subject) ?? prior?.subject ?? `Task #${key}`,
        activeForm: text(input.activeForm) ?? prior?.activeForm ?? null,
        status: stepStatus(input.status) ?? prior?.status ?? "pending",
      });
    }
  }

  result(entry: Extract<TranscriptEntry, { kind: "tool_result" }>) {
    const key = this.pendingCreates.get(entry.toolUseId);
    if (!key) return;
    this.pendingCreates.delete(entry.toolUseId);
    const created = this.tasks.get(key);
    const id = TASK_CREATED.exec(entry.content)?.[1];
    if (!created || !id || entry.isError) { this.tasks.delete(key); return; }
    // Rename in place so the steps stay in creation order.
    const rebuilt = [...this.tasks].filter(([k]) => k !== id).map(([k, v]): [string, typeof created] => (k === key ? [id, created] : [k, v]));
    this.tasks = new Map(rebuilt);
  }

  steps(): MainAgentPlanStep[] {
    if (this.source === "todo") return this.todo;
    return [...this.tasks].map(([key, task]) => ({
      id: `task:${key}`,
      body: task.status === "in_progress" ? task.activeForm ?? task.subject : task.subject,
      status: task.status,
    }));
  }
}

export function deriveMainAgentWork(entries: readonly TranscriptEntry[]): MainAgentWork {
  let planActivitySteps: MainAgentPlanStep[] = [];
  const checklist = new ChecklistBuilder();
  let lastToolName: string | null = null;
  let lastAssistantText: string | null = null;
  const subagents = new Map<string, MainAgentSubagent>();
  // A subagent's name is its Agent call's description (the `started` event); later progress text never renames it.
  const namedAtStart = new Set<string>();
  let context: MainAgentContextUsage | null = null;

  for (const [index, entry] of entries.entries()) {
    if (entry.kind === "tool_call") {
      lastToolName = entry.name;
      checklist.call(entry, index);
    } else if (entry.kind === "tool_result") {
      checklist.result(entry);
    } else if (entry.kind === "assistant" && !entry.delta) {
      lastAssistantText = text(entry.text) ?? lastAssistantText;
    } else if (entry.kind === "provider_activity" && entry.family === "plan") {
      planActivitySteps = planSteps(entry.payload);
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
      const description = text(payload.description);
      let title: string;
      if (namedAtStart.has(id)) title = prior!.title;
      else if (payload.action === "started" && description) { title = description; namedAtStart.add(id); }
      else title = prior?.title ?? description ?? text(payload.subagentType) ?? text(entry.title) ?? "Subagent";
      subagents.set(id, {
        id,
        title,
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

  const steps = checklist.source ? checklist.steps() : planActivitySteps;
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
