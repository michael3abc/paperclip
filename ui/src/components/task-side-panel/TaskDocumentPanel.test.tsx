// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ApiError } from "@/api/client";
import { TaskDocumentPanel } from "./TaskDocumentPanel";
import { MemoryRouter } from "react-router-dom";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
const mocks = vi.hoisted(() => ({ get: vi.fn(), revision: vi.fn() }));
vi.mock("@/api/issues", () => ({ issuesApi: { getDocument: mocks.get, getDocumentRevision: mocks.revision } }));
vi.mock("@/lib/router", () => ({ useLocation: () => ({ hash: "#document-copy&revision=old&interaction=review" }) }));
vi.mock("@/components/IssueDocumentAnnotations", () => ({
  DocumentAnnotationsCountChip: () => <span>Annotations</span>,
  IssueDocumentAnnotations: ({ children, historicalPreview }: { children: React.ReactNode; historicalPreview: boolean }) => <div data-historical={historicalPreview}>{children}</div>,
}));
vi.mock("@/components/MarkdownBody", () => ({ MarkdownBody: ({ children }: { children: React.ReactNode }) => <div>{children}</div> }));
vi.mock("@/components/DocumentMarkdownBody", () => ({ DocumentMarkdownBody: ({ children, documentIssueId }: { children: React.ReactNode; documentIssueId?: string }) => <div data-gallery-owner={documentIssueId}>{children}</div> }));
let root: Root | undefined;
let container: HTMLDivElement;
afterEach(async () => { if (root) await act(async () => root!.unmount()); container?.remove(); root = undefined; vi.clearAllMocks(); });
async function render(issueId = "task", documentKey = "copy", revisionId: string | null = "old") {
  container = document.createElement("div"); document.body.appendChild(container); root = createRoot(container);
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  await act(async () => { root!.render(<MemoryRouter><QueryClientProvider client={client}><TaskDocumentPanel issueId={issueId} documentKey={documentKey} revisionId={revisionId ?? undefined} documentIssueId={issueId === "task-b" ? issueId : undefined} /></QueryClientProvider></MemoryRouter>); });
  await act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)); });
}
describe("exact reviewed revision panel", () => {
  it("passes the saved tab owner when the URL names a local document", async () => {
    mocks.get.mockResolvedValue({ id: "doc", key: "copy", body: "LATEST BODY", updatedAt: new Date() });
    mocks.revision.mockResolvedValue({ id: "old", title: "Reviewed copy", body: "REVIEWED BODY", format: "markdown", revisionNumber: 2, createdAt: new Date() });
    await render("task-b");
    expect(container.querySelector("[data-gallery-owner]")?.getAttribute("data-gallery-owner")).toBe("task-b");
  });
  it("renders the pinned body read-only even when the current document has advanced", async () => {
    mocks.get.mockResolvedValue({ id: "doc", key: "copy", title: "New copy", body: "LATEST BODY", latestRevisionId: "new", latestRevisionNumber: 4, updatedAt: new Date() });
    mocks.revision.mockResolvedValue({ id: "old", key: "copy", title: "Reviewed copy", body: "REVIEWED BODY", format: "markdown", revisionNumber: 2, createdAt: new Date() });
    await render();
    expect(container.textContent).toContain("REVIEWED BODY");
    expect(container.textContent).not.toContain("LATEST BODY");
    expect(container.querySelector('[data-historical="true"]')).not.toBeNull();
    expect(mocks.revision).toHaveBeenCalledWith("task", "copy", "old");
  });
  it("does not silently substitute latest when the reviewed revision is missing", async () => {
    mocks.get.mockResolvedValue({ id: "doc", key: "copy", title: "New copy", body: "LATEST BODY", latestRevisionId: "new", latestRevisionNumber: 4, updatedAt: new Date() });
    mocks.revision.mockRejectedValue(new ApiError("Not found", 404, {}));
    await render();
    expect(container.textContent).toContain("Reviewed revision unavailable");
    expect(container.textContent).not.toContain("LATEST BODY");
  });
  it("reads the actual document owner and fails closed when that task is inaccessible", async () => {
    mocks.get.mockRejectedValue(new ApiError("Forbidden", 403, {}));
    await render("task-b");
    expect(mocks.get).toHaveBeenCalledWith("task-b", "copy");
    expect(mocks.revision).not.toHaveBeenCalled();
    expect(container.textContent).toContain("Couldn't load the document");
    expect(container.querySelector("article")).toBeNull();
  });
  it("shows the agent TODO as a read-only checklist instead of its JSONL records", async () => {
    const body = [
      JSON.stringify({ type: "todo", v: 1, goal: "Ship the release", stop: "Live", nextId: 3 }),
      JSON.stringify({ id: 1, text: "Merge branches", status: "done", owner: false, task: null, note: "merged", createdAt: "2026-11-19T10:00:00.000Z", closedAt: "2026-11-19T11:00:00.000Z" }),
      JSON.stringify({ id: 2, text: "Cut over", status: "open", owner: false, task: null, note: null, createdAt: "2026-11-19T10:00:00.000Z", closedAt: null }),
    ].join("\n");
    mocks.get.mockResolvedValue({ id: "doc", key: "todo", title: null, body, format: "markdown", latestRevisionId: "r1", latestRevisionNumber: 1, updatedAt: new Date() });
    await render("task", "todo", null);
    const readonly = container.querySelector('[data-testid="todo-document-readonly"]');
    expect(readonly).not.toBeNull();
    expect(readonly?.textContent).toContain("Ship the release");
    expect(readonly?.textContent).toContain("#2 Cut over");
    expect(readonly?.textContent).toContain("#1 Merge branches");
    expect(container.textContent).not.toContain('"type":"todo"');
  });
  it("keeps an older markdown TODO as an ordinary document", async () => {
    mocks.get.mockResolvedValue({ id: "doc", key: "todo", title: null, body: "- [ ] plain markdown item", format: "markdown", latestRevisionNumber: 1, updatedAt: new Date() });
    await render("task", "todo", null);
    expect(container.querySelector('[data-testid="todo-document-readonly"]')).toBeNull();
    expect(container.textContent).toContain("plain markdown item");
  });
});
