// @vitest-environment jsdom

import { act } from "react";
import type { ComponentProps, ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { Issue, IssueDocument } from "@paperclipai/shared";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { IssueDocumentsSection } from "./IssueDocumentsSection";
import { queryKeys } from "../lib/queryKeys";

const mockIssuesApi = vi.hoisted(() => ({
  listDocuments: vi.fn(),
  listDocumentRevisions: vi.fn(),
  restoreDocumentRevision: vi.fn(),
  upsertDocument: vi.fn(),
  lockDocument: vi.fn(),
  unlockDocument: vi.fn(),
  deleteDocument: vi.fn(),
  getDocument: vi.fn(),
}));

// eslint-disable-next-line @typescript-eslint/no-explicit-any
(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

vi.mock("../api/issues", () => ({ issuesApi: mockIssuesApi }));
vi.mock("../api/auth", () => ({ authApi: { getSession: async () => ({ user: { id: "user-1" } }) } }));
vi.mock("@/lib/router", () => ({ useLocation: () => ({ hash: "" }) }));
vi.mock("./IssueDocumentAnnotations", () => ({
  DocumentAnnotationsCountChip: () => null,
  IssueDocumentAnnotations: ({ children }: { children: ReactNode }) => <>{children}</>,
}));
vi.mock("./DocumentMarkdownBody", () => ({
  DocumentMarkdownBody: ({ children }: { children: string }) => <div>{children}</div>,
}));
vi.mock("./MarkdownBody", () => ({
  MarkdownBody: ({ children }: { children: string }) => <div>{children}</div>,
}));
vi.mock("./MarkdownEditor", () => ({
  MarkdownEditor: ({ value }: { value: string }) => <div>{value}</div>,
}));
vi.mock("@/components/ui/button", () => ({
  Button: ({ children, type = "button", ...props }: ComponentProps<"button">) => (
    <button type={type} {...props}>{children}</button>
  ),
}));
vi.mock("@/components/ui/dropdown-menu", () => ({
  DropdownMenu: ({ children }: { children: ReactNode }) => <div>{children}</div>,
  DropdownMenuTrigger: ({ children }: { children: ReactNode }) => <>{children}</>,
  DropdownMenuContent: ({ children }: { children: ReactNode }) => <div>{children}</div>,
  DropdownMenuItem: ({ children, onClick }: { children: ReactNode; onClick?: () => void }) => (
    <button type="button" onClick={onClick}>{children}</button>
  ),
  DropdownMenuLabel: ({ children }: { children: ReactNode }) => <div>{children}</div>,
  DropdownMenuRadioGroup: ({ children }: { children: ReactNode }) => <div>{children}</div>,
  DropdownMenuRadioItem: ({ children }: { children: ReactNode }) => <div>{children}</div>,
  DropdownMenuSeparator: () => <hr />,
}));

function createIssueDocument(overrides: Partial<IssueDocument> = {}): IssueDocument {
  return {
    id: "document-1",
    companyId: "company-1",
    issueId: "issue-1",
    key: "plan",
    title: "Plan",
    format: "markdown",
    body: "",
    latestRevisionId: "revision-1",
    latestRevisionNumber: 1,
    createdByAgentId: null,
    createdByUserId: "user-1",
    updatedByAgentId: null,
    updatedByUserId: "user-1",
    lockedAt: null,
    lockedByAgentId: null,
    lockedByUserId: null,
    createdAt: new Date("2026-03-31T12:00:00.000Z"),
    updatedAt: new Date("2026-03-31T12:05:00.000Z"),
    ...overrides,
  };
}

function createIssue(): Issue {
  return {
    id: "issue-1",
    companyId: "company-1",
    identifier: "DOC-1",
    title: "Keyless documents",
    documentSummaries: [],
    legacyPlanDocument: null,
  } as unknown as Issue;
}

async function flush() {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
}

describe("IssueDocumentsSection agent TODO", () => {
  let container: HTMLDivElement;
  let root: Root;
  let client: QueryClient;

  beforeEach(() => {
    vi.clearAllMocks();
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
    client = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
    client.setQueryData(queryKeys.auth.session, { user: { id: "user-1" } });
  });

  afterEach(async () => {
    await act(async () => root.unmount());
    client.clear();
    container.remove();
  });

  const todoBody = [
    JSON.stringify({ type: "todo", v: 1, goal: "Ship the thumbnails", stop: "Released", nextId: 3 }),
    JSON.stringify({ id: 1, text: "Port the branch", status: "done", note: "pushed", closedAt: "2026-11-19T10:00:00.000Z" }),
    JSON.stringify({ id: 2, text: "Release after the sync", status: "open" }),
  ].join("\n") + "\n";

  async function renderDocuments(documents: IssueDocument[]) {
    mockIssuesApi.listDocuments.mockResolvedValue(documents);
    await act(async () => root.render(
      <QueryClientProvider client={client}>
        <IssueDocumentsSection issue={createIssue()} canDeleteDocuments={false} />
      </QueryClientProvider>,
    ));
    await flush();
  }

  it("shows the stored TODO as a read-only checklist without an edit action", async () => {
    await renderDocuments([createIssueDocument({ id: "todo", key: "todo", title: "TODO", body: todoBody })]);
    const readonly = container.querySelector("[data-testid='todo-document-readonly']");
    expect(readonly?.textContent).toContain("**Goal:** Ship the thumbnails");
    expect(readonly?.textContent).toContain("- [ ] #2 Release after the sync");
    expect(readonly?.textContent).toContain("- [x] #1 Port the branch — pushed");
    expect(container.textContent).not.toContain("\"type\":\"todo\"");
    expect(container.textContent).not.toContain("Edit document");
    expect(container.textContent).toContain("Download document");
  });

  it("keeps a markdown TODO and other documents editable", async () => {
    await renderDocuments([
      createIssueDocument({ id: "todo", key: "todo", title: "TODO", body: "# 目標\n- [ ] item" }),
      createIssueDocument({ id: "notes", key: "notes", title: "Notes", body: todoBody }),
    ]);
    expect(container.querySelector("[data-testid='todo-document-readonly']")).toBeNull();
    expect(container.textContent?.match(/Edit document/g)).toHaveLength(2);
  });
});
