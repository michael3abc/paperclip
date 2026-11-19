// @vitest-environment jsdom
import { act, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ApiError } from "@/api/client";
import { TaskTodoPanel } from "./TaskTodoPanel";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
const mocks = vi.hoisted(() => ({ getDocument: vi.fn(), get: vi.fn(), addComment: vi.fn() }));
vi.mock("@/api/issues", () => ({ issuesApi: { getDocument: mocks.getDocument, get: mocks.get, addComment: mocks.addComment } }));
vi.mock("@/lib/router", () => ({ Link: ({ to, children, ...rest }: { to: string; children: ReactNode }) => <a href={to} {...rest}>{children}</a> }));
vi.mock("@/components/MarkdownBody", () => ({ MarkdownBody: ({ children }: { children: ReactNode }) => <div data-testid="markdown">{children}</div> }));

const NOW = new Date("2026-11-19T12:00:00.000Z");
const ago = (minutes: number) => new Date(NOW.getTime() - minutes * 60_000).toISOString();
const line = (value: unknown) => JSON.stringify(value);
function todoBody(items: unknown[]) {
  return [line({ type: "todo", v: 1, goal: "回答論文兩個主問題", stop: "配方定案", nextId: 12 }), ...items.map(line)].join("\n") + "\n";
}
const ITEMS = [
  { id: 3, text: "[HOM-389](/HOM/issues/HOM-389) aux 出來後照分岔表執行", status: "open", task: "HOM-389" },
  { id: 4, text: "整併紀錄", status: "open" },
  { id: 6, text: "跑 SAM-on／off 配對", status: "open", task: "HOM-390" },
  { id: 9, text: "確認是否對外投稿", status: "open", owner: true },
  { id: 2, text: "深度清理", status: "done", note: "釋放 746 GiB", closedAt: ago(20) },
  { id: 5, text: "舊方向", status: "cancelled", closedAt: ago(90) },
  { id: 1, text: "很久以前完成", status: "done", closedAt: ago(8 * 60) },
];

let root: Root | undefined;
let container: HTMLDivElement;
let client: QueryClient;
beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"] }); vi.setSystemTime(NOW);
  mocks.get.mockImplementation(async (reference: string) => reference === "HOM-389"
    ? { id: "task-389", identifier: "HOM-389", title: "RL and aux", status: "in_progress" }
    : { id: "task-390", identifier: "HOM-390", title: "Pairing", status: "done" });
});
afterEach(async () => {
  if (root) await act(async () => root!.unmount());
  container?.remove(); root = undefined; vi.clearAllMocks(); vi.useRealTimers();
});
// The document loads first, then the linked tasks: let a few macrotasks pass.
const settle = () => act(async () => { for (let i = 0; i < 4; i += 1) await new Promise((resolve) => setTimeout(resolve, 0)); });
async function render() {
  container = document.createElement("div"); document.body.appendChild(container); root = createRoot(container);
  client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  await act(async () => { root!.render(<QueryClientProvider client={client}><TaskTodoPanel issue={{ id: "chat-1" }} /></QueryClientProvider>); });
  await settle();
}
const text = (selector: string) => container.querySelector(selector)?.textContent ?? "";
const button = (label: string, within: ParentNode = container) => Array.from(within.querySelectorAll("button")).find((node) => node.textContent?.trim() === label);

describe("TaskTodoPanel", () => {
  it("shows the goal, progress, what needs the Owner, the open items with live task status, and recent results", async () => {
    mocks.getDocument.mockResolvedValue({ id: "doc", key: "todo", body: todoBody(ITEMS), updatedAt: ago(5) });
    await render();
    expect(mocks.getDocument).toHaveBeenCalledWith("chat-1", "todo");
    expect(text('[aria-label="Goal"]')).toContain("回答論文兩個主問題");
    expect(text('[aria-label="Goal"]')).toContain("Stop when 配方定案");
    // 11 items were ever created; 4 are still open (3 to do, 1 for the Owner).
    expect(text('[data-testid="todo-progress"]')).toContain("7/11");
    expect(text('[data-testid="todo-owner"]')).toContain("確認是否對外投稿");
    // The item whose task is still running waits; the first one without a running task is next.
    expect(container.querySelector('[data-testid="todo-open-3"]')?.getAttribute("data-state")).toBe("waiting");
    expect(container.querySelector('[data-testid="todo-open-4"]')?.getAttribute("data-state")).toBe("next");
    expect(container.querySelector('[data-testid="todo-open-6"]')?.getAttribute("data-state")).toBe("queued");
    expect(text('[data-testid="todo-open-3"]')).toContain("HOM-389 aux 出來後照分岔表執行");
    expect(text('[data-testid="todo-open-3"]')).toContain("in progress");
    expect(container.querySelector('[data-testid="todo-open-3"] a')?.getAttribute("href")).toBe("/issues/HOM-389");
    expect(text('[data-testid="todo-open-4"]')).toContain("Next");
    // Finished: the two within six hours are shown, the eight-hour-old one is behind the fold.
    expect(Array.from(container.querySelectorAll('[data-testid="todo-recent"] li')).map((node) => node.getAttribute("data-testid")))
      .toEqual(["todo-finished-2", "todo-finished-5"]);
    expect(text('[data-testid="todo-finished-2"]')).toContain("釋放 746 GiB");
    expect(text('[data-testid="todo-earlier"] summary')).toBe("1 finished earlier");
    expect(container.querySelector('[data-testid="todo-earlier"]')?.hasAttribute("open")).toBe(false);
  });

  it("asks the agent to cancel an item through a comment, after a confirmation", async () => {
    mocks.getDocument.mockResolvedValue({ id: "doc", key: "todo", body: todoBody(ITEMS), updatedAt: ago(5) });
    mocks.addComment.mockResolvedValue({ id: "comment-1" });
    await render();
    const row = container.querySelector('[data-testid="todo-open-3"]')!;
    await act(async () => button("Cancel", row)!.click());
    expect(mocks.addComment).not.toHaveBeenCalled();
    expect(text('[aria-label="Cancel item 3"]')).toContain("It stops HOM-389 behind it");
    await act(async () => button("Keep", row)!.click());
    expect(container.querySelector('[aria-label="Cancel item 3"]')).toBeNull();
    await act(async () => button("Cancel", row)!.click());
    const invalidate = vi.spyOn(client, "invalidateQueries");
    await act(async () => button("Cancel item", row)!.click());
    await settle();
    expect(mocks.addComment).toHaveBeenCalledTimes(1);
    expect(mocks.addComment).toHaveBeenCalledWith("chat-1", "取消 TODO #3：「HOM-389 aux 出來後照分岔表執行」。請停掉這一項背後的 task 與 job，執行 `todo cancel 3`，然後繼續其他項目。");
    expect(invalidate).toHaveBeenCalledWith({ queryKey: ["issues", "comments", "chat-1"] });
    expect(row.textContent).toContain("Cancel requested");
    expect(button("Cancel", row)).toBeUndefined();
    // Owner matters have no cancel action.
    expect(button("Cancel", container.querySelector('[data-testid="todo-owner"]')!)).toBeUndefined();
  });

  it("keeps the confirmation open when the request fails", async () => {
    mocks.getDocument.mockResolvedValue({ id: "doc", key: "todo", body: todoBody(ITEMS), updatedAt: ago(5) });
    mocks.addComment.mockRejectedValue(new Error("offline"));
    await render();
    const row = container.querySelector('[data-testid="todo-open-4"]')!;
    await act(async () => button("Cancel", row)!.click());
    await act(async () => button("Cancel item", row)!.click());
    await settle();
    expect(row.textContent).toContain("Could not send the request");
    expect(row.textContent).not.toContain("Cancel requested");
  });

  it("does not treat an item that names this conversation itself as waiting on a task", async () => {
    mocks.getDocument.mockResolvedValue({ id: "doc", key: "todo", updatedAt: ago(1),
      body: todoBody([{ id: 14, text: "附 v3 到 HOM-265 並說明", status: "open", task: "HOM-265" }, { id: 15, text: "下一步", status: "open" }]) });
    await act(async () => { root?.unmount(); });
    container = document.createElement("div"); document.body.appendChild(container); root = createRoot(container);
    client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    await act(async () => { root!.render(<QueryClientProvider client={client}><TaskTodoPanel issue={{ id: "chat-1", identifier: "HOM-265" }} /></QueryClientProvider>); });
    await settle();
    expect(mocks.get).not.toHaveBeenCalled();
    expect(container.querySelector('[data-testid="todo-open-14"]')?.getAttribute("data-state")).toBe("next");
    expect(container.querySelector('[data-testid="todo-open-14"] a')).toBeNull();
  });

  it("folds a long list and has plain empty states", async () => {
    const many = Array.from({ length: 10 }, (_, index) => ({ id: index + 1, text: `step ${index + 1}`, status: "open" }));
    mocks.getDocument.mockResolvedValue({ id: "doc", key: "todo", body: todoBody(many), updatedAt: ago(1) });
    await render();
    expect(container.querySelectorAll('[data-testid^="todo-open-"]')).toHaveLength(7);
    await act(async () => button("Show 3 more")!.click());
    expect(container.querySelectorAll('[data-testid^="todo-open-"]')).toHaveLength(10);
    expect(container.querySelector('[data-testid="todo-recent"]')).toBeNull();
    expect(container.querySelector('[data-testid="todo-owner"]')).toBeNull();
  });

  it("says so when there is no TODO, and shows an earlier text TODO as text", async () => {
    mocks.getDocument.mockRejectedValue(new ApiError("Not found", 404, null));
    await render();
    expect(text('[data-testid="todo-empty"]')).toContain("No TODO yet");
    await act(async () => root!.unmount()); container.remove(); root = undefined;
    mocks.getDocument.mockResolvedValue({ id: "doc", key: "todo", body: "# 目標\n- [ ] 舊格式", updatedAt: ago(1) });
    await render();
    expect(text('[data-testid="todo-legacy"]')).toContain("earlier text format");
    expect(text('[data-testid="markdown"]')).toContain("舊格式");
  });
});
