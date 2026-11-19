import { useMemo, useState, type ReactNode } from "react";
import { useMutation, useQueries, useQueryClient } from "@tanstack/react-query";
import { Ban, CheckCircle2, Circle, CircleDot, Clock3, Hand, Target } from "lucide-react";
import type { Issue } from "@paperclipai/shared";
import { issuesApi } from "@/api/issues";
import { MarkdownBody } from "@/components/MarkdownBody";
import { StatusBadge } from "@/components/StatusBadge";
import { Button } from "@/components/ui/button";
import { useIssueTodoDocument } from "@/hooks/useIssueTodoDocument";
import { queryKeys } from "@/lib/queryKeys";
import { Link } from "@/lib/router";
import {
  parseTodoDocument,
  todoCancelComment,
  todoDisplayText,
  todoView,
  TODO_OPEN_VISIBLE,
  type TodoItem,
} from "@/lib/todo-document";
import { cn, relativeTime } from "@/lib/utils";

/**
 * The conversation's TODO as the Owner reads it: the goal, what needs the Owner, the open items in order with the
 * live status of their tasks, and what finished recently. The agent owns the list; the only action here is asking
 * the agent to cancel an item, which posts a comment in the conversation.
 */

const LINKED_TASK_LIMIT = 12;
const SETTLED_TASK_STATUSES = new Set(["done", "cancelled"]);
type LinkedTask = Pick<Issue, "id" | "identifier" | "title" | "status">;
type OpenState = "next" | "waiting" | "queued";

function SectionTitle({ children, count, className }: { children: ReactNode; count?: number; className?: string }) {
  return (
    <h3 className={cn("flex items-center gap-1.5 text-xs font-medium uppercase tracking-(--tracking-caps) text-muted-foreground", className)}>
      {children}
      {count !== undefined && <span className="rounded-full bg-muted px-1.5 font-mono text-xs normal-case tracking-normal">{count}</span>}
    </h3>
  );
}

/** Long text is clamped to two lines; a click shows all of it. */
function ItemText({ value, className }: { value: string; className?: string }) {
  const [open, setOpen] = useState(false);
  const display = todoDisplayText(value);
  const long = display.length > 96;
  return (
    <p className={cn("text-sm leading-snug [overflow-wrap:anywhere]", className)}>
      <span className={cn(long && !open && "line-clamp-2")}>{display}</span>
      {long && (
        <button type="button" className="ml-1 text-xs text-muted-foreground underline-offset-2 hover:underline" onClick={() => setOpen(!open)}>
          {open ? "less" : "more"}
        </button>
      )}
    </p>
  );
}

function TaskChip({ reference, task }: { reference: string; task: LinkedTask | undefined }) {
  return (
    <Link
      to={`/issues/${task?.identifier ?? reference}`}
      title={task?.title ?? reference}
      className="inline-flex max-w-full items-center gap-1 rounded-full border bg-background py-0.5 pl-2 pr-0.5 hover:bg-accent"
    >
      <span className="font-mono">{task?.identifier ?? reference}</span>
      {task ? <StatusBadge status={task.status} className="px-1.5 py-0" /> : <span className="pr-1.5" />}
    </Link>
  );
}

function OpenGlyph({ state }: { state: OpenState }) {
  if (state === "next") return <CircleDot className="h-4 w-4 shrink-0 text-blue-600 dark:text-blue-400" aria-label="Next" />;
  if (state === "waiting") return <Clock3 className="h-4 w-4 shrink-0 text-amber-600 dark:text-amber-400" aria-label="Waiting on its task" />;
  return <Circle className="h-4 w-4 shrink-0 text-muted-foreground/60" aria-label="Queued" />;
}

function FinishedRow({ item }: { item: TodoItem }) {
  const cancelled = item.status === "cancelled";
  return (
    <li className="flex items-start gap-2.5 px-3 py-2" data-testid={`todo-finished-${item.id}`}>
      {cancelled
        ? <Ban className="mt-0.5 h-4 w-4 shrink-0 text-muted-foreground/70" aria-label="Cancelled" />
        : <CheckCircle2 className="mt-0.5 h-4 w-4 shrink-0 text-emerald-600 dark:text-emerald-400" aria-label="Done" />}
      <div className="min-w-0 flex-1">
        <ItemText value={item.text} className={cn("text-muted-foreground", cancelled && "line-through decoration-muted-foreground/50")} />
        {item.note && <p className="mt-0.5 text-xs text-muted-foreground [overflow-wrap:anywhere]">{todoDisplayText(item.note)}</p>}
      </div>
      {item.closedAt && <time dateTime={item.closedAt} className="shrink-0 pt-0.5 text-xs text-muted-foreground">{relativeTime(item.closedAt)}</time>}
    </li>
  );
}

export function TaskTodoPanel({ issue }: { issue: Pick<Issue, "id"> & Partial<Pick<Issue, "identifier">> }) {
  const queryClient = useQueryClient();
  const todoQuery = useIssueTodoDocument(issue.id);
  const document = todoQuery.data ?? null;
  const parsed = useMemo(() => (document ? parseTodoDocument(document.body) : null), [document]);
  const view = useMemo(() => (parsed ? todoView(parsed) : null), [parsed]);
  const [showAllOpen, setShowAllOpen] = useState(false);
  const [confirming, setConfirming] = useState<number | null>(null);
  const [requested, setRequested] = useState<ReadonlySet<number>>(() => new Set());

  // An item that names this conversation itself ("attach it to HOM-265") is not waiting on another task.
  const linkedTask = (item: TodoItem) => (item.task && item.task !== issue.identifier ? item.task : null);
  const references = useMemo(() => {
    const all = [...(view?.open ?? []), ...(view?.owner ?? [])]
      .map((item) => (item.task && item.task !== issue.identifier ? item.task : null))
      .filter((task): task is string => Boolean(task));
    return [...new Set(all)].slice(0, LINKED_TASK_LIMIT);
  }, [view, issue.identifier]);
  const taskQueries = useQueries({
    queries: references.map((reference) => ({
      queryKey: queryKeys.issues.detail(reference),
      queryFn: () => issuesApi.get(reference),
      staleTime: 30_000,
      retry: false,
    })),
  });
  const tasks = new Map<string, LinkedTask>();
  references.forEach((reference, index) => {
    const task = taskQueries[index]?.data;
    if (task) tasks.set(reference, task);
  });

  const cancel = useMutation({
    mutationFn: (item: TodoItem) => issuesApi.addComment(issue.id, todoCancelComment(item)),
    onSuccess: (_comment, item) => {
      setRequested((current) => new Set(current).add(item.id));
      setConfirming(null);
      void queryClient.invalidateQueries({ queryKey: queryKeys.issues.comments(issue.id) });
    },
  });

  if (todoQuery.isPending) return <p role="status" className="text-sm text-muted-foreground">Loading TODO…</p>;
  if (todoQuery.isError) return <p role="alert" className="text-sm text-destructive">Could not load the TODO.</p>;
  if (!document) {
    return (
      <div className="rounded-xl border border-dashed p-4 text-sm text-muted-foreground" data-testid="todo-empty">
        <p className="font-medium text-foreground">No TODO yet</p>
        <p className="mt-1">The agent writes its goal and checklist here when it takes on work.</p>
      </div>
    );
  }
  if (!parsed || !view) {
    return (
      <div className="space-y-3" data-testid="todo-legacy">
        <p className="rounded-lg border bg-muted/40 px-3 py-2 text-xs text-muted-foreground">
          This TODO is in the earlier text format. It becomes a structured list the next time the agent edits it.
        </p>
        <MarkdownBody>{document.body}</MarkdownBody>
      </div>
    );
  }

  // The first open item whose task is not still running is what the agent does next; items with a running task wait.
  let nextAssigned = false;
  const openState = (item: TodoItem): OpenState => {
    const reference = linkedTask(item);
    const task = reference ? tasks.get(reference) : undefined;
    if (task && !SETTLED_TASK_STATUSES.has(task.status)) return "waiting";
    if (nextAssigned) return "queued";
    nextAssigned = true;
    return "next";
  };
  const openRows = view.open.map((item) => ({ item, state: openState(item) }));
  const visibleOpen = showAllOpen ? openRows : openRows.slice(0, TODO_OPEN_VISIBLE);
  const percent = view.created > 0 ? Math.round((view.closed / view.created) * 100) : 0;

  return (
    <div className="space-y-4" data-testid="todo-panel">
      <section aria-label="Goal" className="rounded-xl border bg-card p-3">
        <div className="flex items-center justify-between gap-3">
          <SectionTitle><Target className="h-3.5 w-3.5" />Goal</SectionTitle>
          {view.created > 0 && (
            <div className="flex items-center gap-2 text-xs text-muted-foreground" data-testid="todo-progress">
              <span className="font-mono">{view.closed}/{view.created}</span>
              <span className="h-1.5 w-16 overflow-hidden rounded-full bg-muted" role="progressbar" aria-valuemin={0} aria-valuemax={view.created} aria-valuenow={view.closed}>
                <span className="block h-full rounded-full bg-emerald-500" style={{ width: `${percent}%` }} />
              </span>
            </div>
          )}
        </div>
        {parsed.goal
          ? <ItemText value={parsed.goal} className="mt-2 font-medium" />
          : <p className="mt-2 text-sm text-muted-foreground">The agent has not written a goal yet.</p>}
        {parsed.stop && (
          <p className="mt-2 text-xs text-muted-foreground [overflow-wrap:anywhere]">
            <span className="font-medium text-foreground/80">Stop when</span> {todoDisplayText(parsed.stop)}
          </p>
        )}
        <p className="mt-2 text-xs text-muted-foreground">Updated {relativeTime(document.updatedAt)}</p>
      </section>

      {view.owner.length > 0 && (
        <section aria-label="Needs you" className="rounded-xl border border-amber-500/40 bg-amber-500/[0.07] p-3" data-testid="todo-owner">
          <SectionTitle count={view.owner.length} className="text-amber-700 dark:text-amber-300"><Hand className="h-3.5 w-3.5" />Needs you</SectionTitle>
          <ul className="mt-2 space-y-2">
            {view.owner.map((item) => (
              <li key={item.id} className="flex items-start gap-2">
                <span className="pt-0.5 font-mono text-xs text-muted-foreground">#{item.id}</span>
                <div className="min-w-0 flex-1 space-y-1">
                  <ItemText value={item.text} />
                  {linkedTask(item) && <div className="text-xs text-muted-foreground"><TaskChip reference={item.task!} task={tasks.get(item.task!)} /></div>}
                </div>
              </li>
            ))}
          </ul>
        </section>
      )}

      <section aria-label="To do" className="space-y-2">
        <SectionTitle count={view.open.length}>To do</SectionTitle>
        {view.open.length === 0 ? (
          <p className="rounded-xl border border-dashed px-3 py-3 text-sm text-muted-foreground">Nothing open. The agent picks the next direction from here.</p>
        ) : (
          <ul className="divide-y rounded-xl border bg-card">
            {visibleOpen.map(({ item, state }) => (
              <li key={item.id} className="px-3 py-2.5" data-testid={`todo-open-${item.id}`} data-state={state}>
                <div className="flex items-start gap-2.5">
                  <span className="pt-0.5"><OpenGlyph state={state} /></span>
                  <div className="min-w-0 flex-1">
                    <ItemText value={item.text} className={cn(state === "next" && "font-medium")} />
                    <div className="mt-1 flex flex-wrap items-center gap-1.5 text-xs text-muted-foreground">
                      <span className="font-mono">#{item.id}</span>
                      {state === "next" && <span className="rounded-full bg-blue-500/10 px-1.5 py-0.5 font-medium text-blue-700 dark:text-blue-300">Next</span>}
                      {linkedTask(item) && <TaskChip reference={item.task!} task={tasks.get(item.task!)} />}
                    </div>
                  </div>
                  {requested.has(item.id) ? (
                    <span className="shrink-0 pt-0.5 text-xs text-muted-foreground">Cancel requested</span>
                  ) : (
                    <Button
                      type="button"
                      variant="ghost"
                      size="xs"
                      className="shrink-0 text-muted-foreground hover:text-destructive"
                      aria-expanded={confirming === item.id}
                      onClick={() => setConfirming(confirming === item.id ? null : item.id)}
                    >
                      Cancel
                    </Button>
                  )}
                </div>
                {confirming === item.id && (
                  <div className="ml-6.5 mt-2 rounded-lg border bg-muted/40 p-2.5 text-xs" role="group" aria-label={`Cancel item ${item.id}`}>
                    <p className="text-muted-foreground">
                      Ask the agent to cancel this item? It stops {linkedTask(item) ? <span className="font-mono text-foreground">{item.task}</span> : "the work"} behind it and carries on with the rest.
                    </p>
                    {cancel.isError && <p role="alert" className="mt-1 text-destructive">Could not send the request. Try again.</p>}
                    <div className="mt-2 flex gap-2">
                      <Button type="button" variant="destructive" size="xs" disabled={cancel.isPending} onClick={() => cancel.mutate(item)}>
                        {cancel.isPending ? "Sending…" : "Cancel item"}
                      </Button>
                      <Button type="button" variant="outline" size="xs" disabled={cancel.isPending} onClick={() => setConfirming(null)}>Keep</Button>
                    </div>
                  </div>
                )}
              </li>
            ))}
          </ul>
        )}
        {openRows.length > TODO_OPEN_VISIBLE && (
          <Button type="button" variant="ghost" size="xs" className="text-muted-foreground" onClick={() => setShowAllOpen(!showAllOpen)}>
            {showAllOpen ? "Show fewer" : `Show ${openRows.length - TODO_OPEN_VISIBLE} more`}
          </Button>
        )}
      </section>

      {view.recent.length > 0 && (
        <section aria-label="Recently finished" className="space-y-2" data-testid="todo-recent">
          <SectionTitle>Recently finished</SectionTitle>
          <ul className="divide-y rounded-xl border bg-card">{view.recent.map((item) => <FinishedRow key={item.id} item={item} />)}</ul>
        </section>
      )}

      {view.earlier.length > 0 && (
        <details className="group" data-testid="todo-earlier">
          <summary className="cursor-pointer select-none text-xs font-medium text-muted-foreground hover:text-foreground">
            {view.earlier.length} finished earlier
          </summary>
          <ul className="mt-2 divide-y rounded-xl border bg-card">{view.earlier.map((item) => <FinishedRow key={item.id} item={item} />)}</ul>
        </details>
      )}
    </div>
  );
}
