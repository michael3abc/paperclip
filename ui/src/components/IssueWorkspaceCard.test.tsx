// @vitest-environment jsdom

import { act as reactAct, type ComponentProps } from "react";
import { flushSync } from "react-dom";
import { createRoot } from "react-dom/client";
import type { ExecutionWorkspace, Issue } from "@paperclipai/shared";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { IssueWorkspaceCard } from "./IssueWorkspaceCard";
import { issuesApi } from "../api/issues";

function act(callback: () => void | Promise<void>) {
  let result: void | Promise<void> | undefined;
  flushSync(() => {
    result = callback();
  });
  return result;
}

const useQueryMock = vi.fn();
const invalidateQueries = vi.fn(async () => {});
const inspectRefetch = vi.fn();

vi.mock("@tanstack/react-query", async () => {
  const actual = await vi.importActual<typeof import("@tanstack/react-query")>("@tanstack/react-query");
  return {
    ...actual,
    useQueryClient: () => ({ invalidateQueries }),
    useQuery: (options: { queryKey: unknown[] }) => options.queryKey[0] === "task-workspace"
      ? { refetch: inspectRefetch, data: { bindingRevision: 3, admission: { binding: "bound", host: "test-host", cwd: "/tmp/issue-sandbox", waitingReason: null } } }
      : useQueryMock(options),
  };
});

vi.mock("../context/CompanyContext", () => ({
  useCompany: () => ({ selectedCompanyId: "company-1" }),
}));

vi.mock("@/lib/router", () => ({
  Link: ({ children, className, ...props }: ComponentProps<"a">) => (
    <a className={className} {...props}>{children}</a>
  ),
}));

const visibility = vi.hoisted(() => ({ visible: true, loaded: true }));
vi.mock("@/hooks/useWorkspaceIsolationControls", () => ({ useWorkspaceIsolationControls: () => visibility }));
beforeEach(() => { visibility.visible = true; visibility.loaded = true; });

// eslint-disable-next-line @typescript-eslint/no-explicit-any
(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

function createExecutionWorkspace(overrides: Partial<ExecutionWorkspace> = {}): ExecutionWorkspace {
  return {
    id: "workspace-1",
    companyId: "company-1",
    projectId: "project-1",
    projectWorkspaceId: "project-workspace-1",
    sourceIssueId: null,
    mode: "isolated_workspace",
    strategyType: "git_worktree",
    name: "Issue sandbox",
    status: "active",
    deliveryState: "unknown",
    cwd: "/tmp/issue-sandbox",
    repoUrl: null,
    baseRef: null,
    branchName: "paperclip/papa-81",
    providerType: "git_worktree",
    providerRef: null,
    derivedFromExecutionWorkspaceId: null,
    lastUsedAt: new Date("2026-04-16T05:00:00.000Z"),
    openedAt: new Date("2026-04-16T04:59:00.000Z"),
    closedAt: null,
    cleanupEligibleAt: null,
    cleanupReason: null,
    config: {
      environmentId: "env-workspace",
      provisionCommand: null,
      teardownCommand: null,
      cleanupCommand: null,
      workspaceRuntime: null,
      desiredState: null,
    },
    metadata: { mainManagedWorktree: { schema: "paperclip.main-managed-worktree.v1", phase: "open",
      sourceCwd: "/tmp/source", parentDir: "/tmp", branch: "paperclip/papa-81", targetBranch: "main",
      hostId: null, pendingOperationId: null, participants: {} } },
    runtimeServices: [],
    createdAt: new Date("2026-04-16T04:59:00.000Z"),
    updatedAt: new Date("2026-04-16T05:00:00.000Z"),
    ...overrides,
  };
}

function createIssue(overrides: Partial<Issue> = {}): Issue {
  return {
    id: "issue-1",
    identifier: "PAPA-81",
    companyId: "company-1",
    projectId: "project-1",
    projectWorkspaceId: "project-workspace-1",
    goalId: null,
    parentId: null,
    title: "Sandboxing",
    description: null,
    status: "in_progress",
    priority: "medium",
    reviewPolicy: null,
    assigneeAgentId: "agent-1",
    assigneeUserId: null,
    responsibleUserId: null,
    createdByAgentId: null,
    createdByUserId: null,
    issueNumber: 81,
    requestDepth: 0,
    billingCode: null,
    assigneeAdapterOverrides: null,
    executionWorkspaceId: "workspace-1",
    executionWorkspacePreference: "isolated_workspace",
    executionWorkspaceSettings: {
      mode: "isolated_workspace",
      environmentId: "env-issue",
    },
    checkoutRunId: null,
    executionRunId: null,
    executionAgentNameKey: null,
    executionLockedAt: null,
    startedAt: null,
    completedAt: null,
    cancelledAt: null,
    hiddenAt: null,
    createdAt: new Date("2026-04-16T04:30:00.000Z"),
    updatedAt: new Date("2026-04-16T05:30:00.000Z"),
    labels: [],
    labelIds: [],
    currentExecutionWorkspace: null,
    ...overrides,
    workMode: overrides.workMode ?? "standard",
  };
}

describe("IssueWorkspaceCard", () => {
  let container: HTMLDivElement;
  let originalResizeObserver: typeof ResizeObserver | undefined;

  beforeEach(() => {
    originalResizeObserver = globalThis.ResizeObserver;
    globalThis.ResizeObserver = class ResizeObserver {
      observe() {}
      unobserve() {}
      disconnect() {}
    };
    container = document.createElement("div");
    document.body.appendChild(container);
    useQueryMock.mockReset();
  });

  afterEach(() => {
    globalThis.ResizeObserver = originalResizeObserver!;
    container.remove();
  });

  it("keeps workspace details and files while suppressing editing and draft writes", () => {
    visibility.visible = false;
    useQueryMock.mockImplementation((options: { queryKey: unknown[] }) => ({
      data: options.queryKey[0] === "instance" ? { enableIsolatedWorkspaces: true } : [],
    }));
    const root = createRoot(container);
    const onUpdate = vi.fn();
    const onDraftChange = vi.fn();
    const onBrowseFiles = vi.fn();
    act(() => root.render(<IssueWorkspaceCard
      issue={createIssue({ currentExecutionWorkspace: createExecutionWorkspace() })}
      project={{ id: "project-1", executionWorkspacePolicy: { enabled: true, defaultMode: "isolated_workspace" } }}
      initialEditing livePreview onUpdate={onUpdate} onDraftChange={onDraftChange} onBrowseFiles={onBrowseFiles}
    />));
    expect(container.querySelector("select")).toBeNull();
    expect(container.textContent).not.toContain("Save");
    expect(container.textContent).toContain("View workspace details");
    const browse = Array.from(container.querySelectorAll("button")).find((button) => button.textContent?.includes("Browse files"));
    act(() => browse!.click());
    expect(onBrowseFiles).toHaveBeenCalledOnce();
    expect(onUpdate).not.toHaveBeenCalled();
    expect(onDraftChange).not.toHaveBeenCalled();
    act(() => root.unmount());
  });

  it("selects an existing workspace through the revision-checked API without patching the task", async () => {
    const select = vi.spyOn(issuesApi, "selectWorkspace").mockResolvedValue({ kind: "scheduled", bindingRevision: 4 });
    const root = createRoot(container);
    const onUpdate = vi.fn();
    const reusableWorkspace = createExecutionWorkspace();

    useQueryMock.mockImplementation((options: { queryKey: unknown[] }) => {
      if (options.queryKey[0] === "instance") {
        return { data: { enableEnvironments: true, enableIsolatedWorkspaces: true } };
      }
      if (options.queryKey[0] === "environments") {
        return {
          data: [{ id: "env-workspace", name: "Local", driver: "local" }],
        };
      }
      if (options.queryKey[0] === "execution-workspaces") {
        return { data: [reusableWorkspace] };
      }
      return { data: undefined };
    });

    act(() => {
      root.render(
        <IssueWorkspaceCard
          issue={createIssue()}
          project={{
            id: "project-1",
            executionWorkspacePolicy: {
              enabled: true,
              defaultMode: "isolated_workspace",
              environmentId: "env-project",
            },
          }}
          onUpdate={onUpdate}
        />,
      );
    });

    const editButton = Array.from(container.querySelectorAll("button")).find((button) => button.textContent?.includes("Edit"));
    expect(editButton).not.toBeUndefined();

    act(() => {
      editButton!.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
    });

    const selects = container.querySelectorAll("select");
    expect(selects).toHaveLength(1);
    expect(container.querySelector("button[role='combobox']")?.textContent).toContain("Issue sandbox");

    const saveButton = Array.from(container.querySelectorAll("button")).find((button) => button.textContent?.includes("Save"));
    expect(saveButton).not.toBeUndefined();

    await act(async () => {
      saveButton!.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
      await Promise.resolve();
    });

    expect(select).toHaveBeenCalledWith("issue-1", {
      selection: { kind: "existing", workspaceId: "workspace-1" },
      expectedBindingRevision: 3, requestKey: expect.any(String),
    });
    expect(onUpdate).not.toHaveBeenCalled();

    act(() => {
      root.unmount();
    });
  });

  it("reconciles an uncertain selection by reading its original request without resending", async () => {
    const select = vi.spyOn(issuesApi, "selectWorkspace").mockRejectedValue(new Error("Response lost"));
    select.mockClear();
    const root = createRoot(container);
    useQueryMock.mockImplementation((options: { queryKey: unknown[] }) => ({
      data: options.queryKey[0] === "instance" ? { enableIsolatedWorkspaces: true } : [createExecutionWorkspace()],
    }));
    await reactAct(() => root.render(<IssueWorkspaceCard issue={createIssue()} project={{ id: "project-1" }}
      initialEditing onUpdate={vi.fn()} />));
    const save = Array.from(container.querySelectorAll("button")).find(button => button.textContent === "Save")!;
    await reactAct(async () => { save.click(); await Promise.resolve(); });
    expect(select).toHaveBeenCalledOnce();
    expect(save.disabled).toBe(true);
    expect(container.textContent).toContain("outcome is unknown");
    const key = select.mock.calls[0]![1].requestKey;
    inspectRefetch.mockResolvedValue({ data: { pendingSelection: { requestKey: key } } });
    const check = Array.from(container.querySelectorAll("button")).find(button => button.textContent === "Check selection status")!;
    await reactAct(async () => { check.click(); await Promise.resolve(); });
    expect(inspectRefetch).toHaveBeenCalledOnce();
    expect(select).toHaveBeenCalledOnce();
    expect(container.textContent).not.toContain("outcome is unknown");
    await reactAct(() => root.unmount());
  });

  it("hides environment UI when environments are disabled", () => {
    const root = createRoot(container);

    useQueryMock.mockImplementation((options: { queryKey: unknown[] }) => {
      if (options.queryKey[0] === "instance") {
        return { data: { enableEnvironments: false, enableIsolatedWorkspaces: true } };
      }
      if (options.queryKey[0] === "execution-workspaces") {
        return { data: [createExecutionWorkspace()] };
      }
      return { data: undefined };
    });

    act(() => {
      root.render(
        <IssueWorkspaceCard
          issue={createIssue()}
          project={{
            id: "project-1",
            executionWorkspacePolicy: {
              enabled: true,
              defaultMode: "isolated_workspace",
              environmentId: "env-project",
            },
          }}
          onUpdate={vi.fn()}
        />,
      );
    });

    expect(container.textContent).not.toContain("Environment:");

    const editButton = Array.from(container.querySelectorAll("button")).find((button) => button.textContent?.includes("Edit"));
    expect(editButton).not.toBeUndefined();

    act(() => {
      editButton!.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
    });

    const selects = container.querySelectorAll("select");
    expect(selects).toHaveLength(1);
    expect(container.querySelector("button[role='combobox']")?.textContent).toContain("Issue sandbox");
    expect(container.textContent).not.toContain("Project default environment");

    act(() => {
      root.unmount();
    });
  });

  it("rejects legacy or converging trees and saves an explicit session-only selection", async () => {
    const select = vi.spyOn(issuesApi, "selectWorkspace").mockResolvedValue({ kind: "scheduled", bindingRevision: 4 });
    select.mockClear();
    const closed = createExecutionWorkspace();
    (closed.metadata!.mainManagedWorktree as Record<string, unknown>).phase = "converging";
    useQueryMock.mockImplementation((options: { queryKey: unknown[] }) => ({
      data: options.queryKey[0] === "instance" ? { enableIsolatedWorkspaces: true }
        : [createExecutionWorkspace({ metadata: null }), closed],
    }));
    const root = createRoot(container);
    await reactAct(() => root.render(<IssueWorkspaceCard issue={createIssue()} project={{ id: "project-1" }}
      initialEditing onUpdate={vi.fn()} />));
    const save = Array.from(container.querySelectorAll("button")).find(button => button.textContent === "Save")!;
    expect(save.disabled).toBe(true);
    const choice = container.querySelector("select")!;
    expect(Array.from(choice.options).map(option => option.value)).toEqual(["reuse_existing", "session_only"]);
    await reactAct(() => { choice.value = "session_only"; choice.dispatchEvent(new Event("change", { bubbles: true })); });
    expect(save.disabled).toBe(false);
    await reactAct(async () => { save.click(); await Promise.resolve(); });
    expect(select).toHaveBeenCalledWith("issue-1", { selection: { kind: "session_only" },
      expectedBindingRevision: 3, requestKey: expect.any(String) });
    await reactAct(() => root.unmount());
  });
});
