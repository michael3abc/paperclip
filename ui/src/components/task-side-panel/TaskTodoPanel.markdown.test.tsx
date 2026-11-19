// @vitest-environment node
import type { ReactNode } from "react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { ThemeProvider } from "@/context/ThemeContext";
import { queryKeys } from "@/lib/queryKeys";
import { TaskTodoPanel } from "./TaskTodoPanel";

// The real markdown renderer, to pin what an item's text turns into: links and task identifiers must be clickable.
vi.mock("@/lib/router", () => ({
  Link: ({ children, to, disableIssueQuicklook: _quicklook, ...props }: { children: ReactNode; to: string; disableIssueQuicklook?: boolean } & React.ComponentProps<"a">) =>
    <a href={to} {...props}>{children}</a>,
  useLocation: () => ({ pathname: "/SHO/issues/SHO-12", search: "", hash: "", state: null }),
  useCaseHref: () => () => "#",
}));
vi.mock("@/api/issues", () => ({ issuesApi: { get: vi.fn(), getDocument: vi.fn(), addComment: vi.fn() } }));
vi.mock("@/context/CompanyContext", () => ({ useOptionalCompany: () => null }));

const line = (value: unknown) => JSON.stringify(value);

describe("TaskTodoPanel item text", () => {
  it("renders links and task identifiers in item text as links", () => {
    const body = [
      line({ type: "todo", v: 1, goal: "CCTV runtime 研究線與批次交付持續推進", stop: "全部有結論", nextId: 20 }),
      line({ id: 6, text: "SHO-93：Rule 2 VLM 審核，補完 v8 剩 239 窗、跑 `v8b`", status: "open", task: "SHO-93" }),
      line({ id: 16, text: "SHO-93：Rule 2 品質 GUI http://127.0.0.1:8931/（235 筆）", status: "open", owner: true, task: "SHO-93" }),
      line({ id: 3, text: "[SHO-91](/SHO/issues/SHO-91) 店員 Re-ID", status: "done", note: "見 SHO-92 的補驗", closedAt: new Date().toISOString() }),
    ].join("\n") + "\n";
    const client = new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: Infinity } } });
    client.setQueryData([...queryKeys.issues.documents("chat-1"), "todo"], { id: "doc", key: "todo", body, updatedAt: new Date() });
    client.setQueryData(queryKeys.issues.detail("SHO-93"), { id: "t93", identifier: "SHO-93", title: "Rule 2", status: "in_progress" });
    const html = renderToStaticMarkup(
      <QueryClientProvider client={client}><ThemeProvider><TaskTodoPanel issue={{ id: "chat-1", identifier: "SHO-12" }} /></ThemeProvider></QueryClientProvider>,
    );
    const hrefs = [...html.matchAll(/<a [^>]*href="([^"]+)"/g)].map((match) => match[1]);
    // The GUI address is a real link, and it does not swallow the full-width bracket that follows it.
    expect(hrefs).toContain("http://127.0.0.1:8931/");
    // Bare identifiers in text and notes link to their task; an explicit markdown link keeps its target. Both items
    // name SHO-93 themselves, so that mention is the only link to it (no separate chip).
    expect(hrefs.filter((href) => href === "/issues/SHO-93")).toHaveLength(2);
    expect(html).not.toContain('target="_blank" rel="noreferrer"');
    expect(hrefs).toContain("/SHO/issues/SHO-91");
    expect(hrefs.some((href) => href.includes("%EF%BC%88"))).toBe(false);
    expect(hrefs).toContain("/issues/SHO-92");
    expect(html).toContain("<code");
    expect(html).not.toContain("[SHO-91](");
  });
});
