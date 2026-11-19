import { describe, expect, it } from "vitest";
import {
  parseTodoDocument,
  todoCancelComment,
  todoDisplayText,
  todoMarkdownText,
  todoView,
  TODO_RECENT_LIMIT,
  TODO_RECENT_WINDOW_MS,
} from "./todo-document";

const line = (value: unknown) => JSON.stringify(value);
const NOW = new Date("2026-11-19T12:00:00.000Z").getTime();
const ago = (minutes: number) => new Date(NOW - minutes * 60_000).toISOString();

function body(items: unknown[], head: Record<string, unknown> = {}) {
  return [line({ type: "todo", v: 1, goal: "Reach 70 on test", stop: "Two flat rounds", nextId: 12, ...head }), ...items.map(line)].join("\n") + "\n";
}

describe("todo document", () => {
  it("parses the JSONL store and skips damaged or incomplete lines", () => {
    const parsed = parseTodoDocument(body([
      { id: 3, text: "ablation   (HOM-9)", status: "open", owner: false, task: "HOM-9", note: null, createdAt: ago(300), closedAt: null },
      { id: 9, text: "confirm the venue", status: "open", owner: true },
      { id: 2, text: "baseline", status: "done", note: "reproduced 66.2", closedAt: ago(30) },
      { id: 5, text: "old idea", status: "cancelled", closedAt: "not a date" },
      { text: "no id" },
      { id: 7, text: "   " },
    ]) + "{broken\n");
    expect(parsed).toMatchObject({ goal: "Reach 70 on test", stop: "Two flat rounds", created: 11 });
    expect(parsed!.items.map((item) => [item.id, item.status, item.owner, item.task])).toEqual([
      [3, "open", false, "HOM-9"], [9, "open", true, null], [2, "done", false, null], [5, "cancelled", false, null],
    ]);
    expect(parsed!.items[0]!.text).toBe("ablation (HOM-9)");
    expect(parsed!.items[0]!.closedAt).toBeNull();
    expect(parsed!.items[3]!.closedAt).toBeNull();
  });

  it.each(["", "   ", "# 目標\n- [ ] item", "{\"type\":\"other\"}", "{broken", null, undefined])("does not read %j as a TODO", (value) => {
    expect(parseTodoDocument(value)).toBeNull();
  });

  it("counts items ever created from nextId, and never below the items present", () => {
    expect(parseTodoDocument(body([{ id: 20, text: "late", status: "open" }], { nextId: 3 }))!.created).toBe(20);
    expect(parseTodoDocument(body([], { nextId: undefined }))!.created).toBe(0);
  });

  it("shows at most three finished items, and only those finished within six hours", () => {
    const parsed = parseTodoDocument(body([
      { id: 10, text: "open work", status: "open" },
      { id: 11, text: "owner matter", status: "open", owner: true },
      { id: 1, text: "five hours ago", status: "done", closedAt: ago(5 * 60) },
      { id: 2, text: "one hour ago", status: "done", closedAt: ago(60) },
      { id: 3, text: "ten minutes ago", status: "cancelled", closedAt: ago(10) },
      { id: 4, text: "two hours ago", status: "done", closedAt: ago(120) },
      { id: 5, text: "seven hours ago", status: "done", closedAt: ago(7 * 60) },
      { id: 6, text: "unknown time", status: "done" },
    ]))!;
    const view = todoView(parsed, NOW);
    expect(view.open.map((item) => item.id)).toEqual([10]);
    expect(view.owner.map((item) => item.id)).toEqual([11]);
    expect(view.recent.map((item) => item.id)).toEqual([3, 2, 4]);
    expect(view.recent).toHaveLength(TODO_RECENT_LIMIT);
    // The fourth recent one and everything older or undated is behind "finished earlier".
    expect(view.earlier.map((item) => item.id)).toEqual([1, 5, 6]);
    expect(view.created).toBe(11);
    expect(view.closed).toBe(9);
    // Exactly at the window edge still counts; one millisecond later does not.
    const edge = parseTodoDocument(body([{ id: 1, text: "edge", status: "done", closedAt: new Date(NOW - TODO_RECENT_WINDOW_MS).toISOString() }]))!;
    expect(todoView(edge, NOW).recent).toHaveLength(1);
    expect(todoView(edge, NOW + 1).recent).toHaveLength(0);
    expect(todoView(edge, NOW + 1).earlier).toHaveLength(1);
  });

  it("renders item text as plain words", () => {
    expect(todoDisplayText("[HOM-389](/HOM/issues/HOM-389) aux 出來後跑 `tolerant_em.py`，**重要**")).toBe("HOM-389 aux 出來後跑 tolerant_em.py，重要");
  });

  it("ends a bare address where it really ends, so CJK text after it is not taken into the link", () => {
    expect(todoMarkdownText("SHO-93：Rule 2 品質 GUI http://127.0.0.1:8931/（235 筆）")).toBe("SHO-93：Rule 2 品質 GUI <http://127.0.0.1:8931/>（235 筆）");
    expect(todoMarkdownText("看 https://example.com/a?b=1，再回報。")).toBe("看 <https://example.com/a?b=1>，再回報。");
    expect(todoMarkdownText("See https://example.com/path). Next")).toBe("See <https://example.com/path>). Next");
    // Addresses that are already marked up, or sit inside code, are left alone.
    for (const kept of ["[頁面](https://example.com/x)", "<https://example.com/x>", "`https://example.com/x`", "沒有連結的文字", "href=\"https://example.com\""])
      expect(todoMarkdownText(kept)).toBe(kept);
  });

  it("asks the agent to cancel an item by id, naming its task once", () => {
    expect(todoCancelComment({ id: 7, text: "DPO 結果出來後判定", task: "HOM-388" }))
      .toBe("取消 TODO #7：「DPO 結果出來後判定」（HOM-388）。請停掉這一項背後的 task 與 job，執行 `todo cancel 7`，然後繼續其他項目。");
    expect(todoCancelComment({ id: 3, text: "[HOM-389](/HOM/issues/HOM-389) 照分岔表執行", task: "HOM-389" }))
      .toBe("取消 TODO #3：「HOM-389 照分岔表執行」。請停掉這一項背後的 task 與 job，執行 `todo cancel 3`，然後繼續其他項目。");
    expect(todoCancelComment({ id: 4, text: "整併紀錄", task: null })).toContain("取消 TODO #4：「整併紀錄」。");
  });
});
