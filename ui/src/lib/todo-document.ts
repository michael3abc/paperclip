/**
 * A conversation's TODO (fork feature, Owner 2026-11-19). The CC Pocket adapter stores it as the issue document
 * `todo`: JSONL, one record per line. Line 1 is the header; the others are items.
 *
 *   {"type":"todo","v":1,"goal":"…","stop":"…","nextId":8}
 *   {"id":3,"text":"…","status":"open|done|cancelled","owner":false,"task":"HOM-389","note":null,
 *    "createdAt":"…","closedAt":null}
 *
 * The agent edits it with its helper; this file only reads it. Ids are never reused, so `nextId - 1` is the
 * number of items ever created even after old finished items were dropped from the document.
 */
export const TODO_DOCUMENT_KEY = "todo";
/** Finished items shown without expanding: at most this many… */
export const TODO_RECENT_LIMIT = 3;
/** …and only those finished within this window. */
export const TODO_RECENT_WINDOW_MS = 6 * 60 * 60 * 1000;
/** Open items shown before "Show more". */
export const TODO_OPEN_VISIBLE = 7;

export type TodoStatus = "open" | "done" | "cancelled";

export interface TodoItem {
  id: number;
  text: string;
  status: TodoStatus;
  /** A matter only the Owner can settle. */
  owner: boolean;
  /** Identifier of the linked task, e.g. HOM-389. */
  task: string | null;
  note: string | null;
  createdAt: string | null;
  closedAt: string | null;
}

export interface TodoDocument {
  goal: string;
  stop: string;
  /** Items ever created, including finished ones no longer kept. */
  created: number;
  items: TodoItem[];
}

function record(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : null;
}
const text = (value: unknown) => typeof value === "string" ? value.replace(/\s+/g, " ").trim() : "";
const time = (value: unknown) => typeof value === "string" && !Number.isNaN(new Date(value).getTime()) ? value : null;

/** Parse the stored JSONL. Null means the body is not this format (for example an older markdown TODO). */
export function parseTodoDocument(body: string | null | undefined): TodoDocument | null {
  const lines = (body ?? "").split("\n").map((line) => line.trim()).filter(Boolean);
  if (lines.length === 0 || !lines[0]!.startsWith("{")) return null;
  let head: Record<string, unknown> | null;
  try { head = record(JSON.parse(lines[0]!)); } catch { return null; }
  if (head?.type !== "todo") return null;
  const items: TodoItem[] = [];
  for (const line of lines.slice(1)) {
    let raw: Record<string, unknown> | null;
    try { raw = record(JSON.parse(line)); } catch { continue; }
    const itemText = text(raw?.text);
    if (!raw || !itemText || typeof raw.id !== "number" || !Number.isSafeInteger(raw.id)) continue;
    const status: TodoStatus = raw.status === "done" || raw.status === "cancelled" ? raw.status : "open";
    items.push({
      id: raw.id,
      text: itemText,
      status,
      owner: raw.owner === true,
      task: text(raw.task) || null,
      note: text(raw.note) || null,
      createdAt: time(raw.createdAt),
      closedAt: status === "open" ? null : time(raw.closedAt),
    });
  }
  const highest = items.reduce((max, item) => Math.max(max, item.id), 0);
  const nextId = typeof head.nextId === "number" && Number.isSafeInteger(head.nextId) ? head.nextId : 1;
  return { goal: text(head.goal), stop: text(head.stop), created: Math.max(nextId - 1, highest), items };
}

export interface TodoView {
  /** Open work in the order it will be done. */
  open: TodoItem[];
  /** Open matters waiting on the Owner. */
  owner: TodoItem[];
  /** Finished within the window, newest first, at most TODO_RECENT_LIMIT. */
  recent: TodoItem[];
  /** The other finished items still kept in the document, newest first. */
  earlier: TodoItem[];
  /** Items closed (done or cancelled) out of all items ever created. */
  closed: number;
  created: number;
}

export function todoView(document: TodoDocument, now: number = Date.now()): TodoView {
  const open = document.items.filter((item) => item.status === "open" && !item.owner);
  const owner = document.items.filter((item) => item.status === "open" && item.owner);
  const finished = document.items
    .filter((item) => item.status !== "open")
    .sort((left, right) => (right.closedAt ?? "").localeCompare(left.closedAt ?? ""));
  const fresh = (item: TodoItem) => item.closedAt !== null && now - new Date(item.closedAt).getTime() <= TODO_RECENT_WINDOW_MS;
  const recent = finished.filter(fresh).slice(0, TODO_RECENT_LIMIT);
  const shown = new Set(recent.map((item) => item.id));
  const created = Math.max(document.created, document.items.length);
  return {
    open,
    owner,
    recent,
    earlier: finished.filter((item) => !shown.has(item.id)),
    closed: Math.max(0, created - open.length - owner.length),
    created,
  };
}

/** Item text as plain words: markdown links become their label, code ticks and emphasis marks are dropped. */
export function todoDisplayText(value: string): string {
  return value
    .replace(/\[([^\]]+)\]\((?:[^)]+)\)/g, "$1")
    .replace(/`([^`]+)`/g, "$1")
    .replace(/\*\*([^*]+)\*\*/g, "$1")
    .trim();
}

/**
 * The task an item is about, or null. The stored `task` is taken from the first identifier in the text, so an item
 * that only mentions a task in passing ("rerun only if HOM-388 passes") carries it too. That is not the item's own
 * task: the row must not borrow its status. The item owns the task when its text starts with the identifier, or
 * when the text does not mention it at all (it was given explicitly).
 */
export function todoOwnTask(item: Pick<TodoItem, "text" | "task">): string | null {
  if (!item.task) return null;
  const display = todoDisplayText(item.text);
  if (!display.includes(item.task)) return item.task;
  return display.startsWith(item.task) ? item.task : null;
}

// A bare URL runs to the next ASCII space in GFM, so "http://host:8931/（235 筆）" would take the full-width bracket
// and what follows into the link. Mark where the address really ends before the markdown renderer sees it.
const BARE_URL = /(^|[^\w(<\[`"'=])(https?:\/\/[\x21-\x7e]+)/g;
const URL_TRAILING = /[.,;:!?)\]}'"*_~]+$/;

/** Item text as markdown for the app's renderer, with bare addresses turned into explicit autolinks. */
export function todoMarkdownText(value: string): string {
  return value.replace(BARE_URL, (_match, before: string, url: string) => {
    const trailing = URL_TRAILING.exec(url)?.[0] ?? "";
    const address = trailing ? url.slice(0, -trailing.length) : url;
    return address.length > "https://".length ? `${before}<${address}>${trailing}` : `${before}${url}`;
  });
}

/**
 * The Owner's cancel request, posted as a comment in the conversation. The agent stops the task or job behind the
 * item and records the cancellation; this UI never cancels a task itself.
 */
export function todoCancelComment(item: Pick<TodoItem, "id" | "text" | "task">): string {
  const subject = todoDisplayText(item.text);
  return `取消 TODO #${item.id}：「${subject}」${item.task && !subject.includes(item.task) ? `（${item.task}）` : ""}。`
    + `請停掉這一項背後的 task 與 job，執行 \`todo cancel ${item.id}\`，然後繼續其他項目。`;
}

/**
 * The stored TODO, or null when this document is not one. Only the `todo` key in the JSONL format counts; an older
 * markdown TODO, or a document under another key, stays an ordinary markdown document.
 */
export function storedTodoDocument(key: string | null | undefined, body: string | null | undefined): TodoDocument | null {
  return key === TODO_DOCUMENT_KEY ? parseTodoDocument(body) : null;
}

/**
 * Read-only markdown for the generic Documents list. Issue documents only have the `markdown` format, so the adapter
 * stores the JSONL under it; showing that body as markdown would run the records together, and editing it there could
 * break the helper's store. This renders the same records as a checklist instead (ids kept, so "#3" matches
 * `todo check 3`), in the order of the TODO tab.
 */
export function todoDocumentMarkdown(document: TodoDocument): string {
  const view = todoView(document, Number.POSITIVE_INFINITY);
  const entry = (item: TodoItem) => {
    const mark = item.status === "done" ? "x" : " ";
    const label = `#${item.id} ${item.status === "cancelled" ? `~~${item.text}~~ (cancelled)` : item.text}`;
    return `- [${mark}] ${label}${item.note ? ` — ${item.note}` : ""}`;
  };
  const lines: string[] = [];
  lines.push(`**Goal:** ${document.goal || "(not written yet)"}`);
  if (document.stop) lines.push("", `**Stop when:** ${document.stop}`);
  const section = (title: string, items: TodoItem[]) => {
    if (items.length === 0) return;
    lines.push("", `**${title}**`, "", ...items.map(entry));
  };
  section("To do", view.open);
  section("Needs you", view.owner);
  section("Finished", view.earlier);
  if (view.open.length === 0 && view.owner.length === 0 && view.earlier.length === 0) lines.push("", "Nothing in the list yet.");
  return `${lines.join("\n")}\n`;
}
