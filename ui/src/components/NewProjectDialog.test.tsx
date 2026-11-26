// @vitest-environment jsdom

import { act, type ReactNode } from "react";
import { createRoot } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { PROJECT_COLORS } from "@paperclipai/shared";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { projectsApi } from "../api/projects";
import { agentsApi } from "../api/agents";
import { queryKeys } from "../lib/queryKeys";
import { getLastProjectId } from "../lib/recent-projects";
import { NewProjectForm } from "./NewProjectDialog";

vi.mock("../api/projects", () => ({ projectsApi: { create: vi.fn(), update: vi.fn(), environmentOptions: vi.fn() } }));
vi.mock("../api/agents", () => ({ agentsApi: { list: vi.fn(), create: vi.fn() } }));
vi.mock("./ProjectRepositoryInput", () => ({
  ProjectRepositoryInput: () => null,
  repositoryOptionsKey: (companyId: string) => ["repositories", companyId],
}));
vi.mock("@/features/connections/ConnectionSetupFlow", () => ({ ConnectionSetupFlow: () => null }));
vi.mock("./ui/dialog", () => ({
  Dialog: ({ children }: { children: ReactNode }) => <>{children}</>,
  DialogContent: ({ children }: { children: ReactNode }) => <div>{children}</div>,
  DialogTitle: ({ children }: { children: ReactNode }) => <h2>{children}</h2>,
}));

// Radix Checkbox measures its form-bubble input with ResizeObserver, which jsdom lacks.
globalThis.ResizeObserver ??= class { observe() {} unobserve() {} disconnect() {} } as unknown as typeof ResizeObserver;

let root: ReturnType<typeof createRoot>;
let container: HTMLDivElement;
beforeEach(() => {
  localStorage.clear();
  vi.mocked(projectsApi.create).mockReset().mockResolvedValue({ id: "project-created" } as Awaited<ReturnType<typeof projectsApi.create>>);
  vi.mocked(projectsApi.update).mockReset().mockResolvedValue({} as Awaited<ReturnType<typeof projectsApi.update>>);
  vi.mocked(agentsApi.list).mockReset().mockResolvedValue([]);
  vi.mocked(agentsApi.create).mockReset();
  vi.mocked(projectsApi.environmentOptions).mockReset().mockResolvedValue({ groups: [], defaultEnvironmentId: null, error: null });
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
});
afterEach(() => {
  act(() => root.unmount());
  container.remove();
  vi.restoreAllMocks();
});

async function settle() {
  await act(async () => { await new Promise((resolve) => setTimeout(resolve, 10)); });
}

describe("new project colors", () => {
  it("previews a palette color, keeps it through a retry, and remembers the created project", async () => {
    vi.mocked(projectsApi.create)
      .mockRejectedValueOnce(new Error("Try again"))
      .mockResolvedValueOnce({ id: "project-created" } as Awaited<ReturnType<typeof projectsApi.create>>);
    const onClose = vi.fn();
    act(() => root.render(<QueryClientProvider client={new QueryClient({ defaultOptions: { mutations: { retry: false } } })}>
      <NewProjectForm companyId="company-1" onClose={onClose} />
    </QueryClientProvider>));
    await settle();
    const previewColor = container.querySelector<HTMLElement>('span[style]')!.style.backgroundColor;
    const input = container.querySelector<HTMLInputElement>('input[aria-label="Project name"]')!;
    act(() => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(input, "Colorful project");
      input.dispatchEvent(new Event("input", { bubbles: true }));
    });
    act(() => container.querySelector("form")!.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true })));
    await settle();
    expect(container.querySelector('[role="alert"]')?.textContent).toBe("Try again");
    const firstColor = vi.mocked(projectsApi.create).mock.calls[0][1].color;
    expect(PROJECT_COLORS).toContain(firstColor);
    const expected = document.createElement("span");
    expected.style.backgroundColor = String(firstColor);
    expect(previewColor).toBe(expected.style.backgroundColor);
    act(() => container.querySelector("form")!.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true })));
    await settle();
    expect(vi.mocked(projectsApi.create).mock.calls[1][1]).toEqual({ name: "Colorful project", color: firstColor, status: "planned", repositoryIds: [] });
    expect(getLastProjectId("company-1")).toBe("project-created");
    expect(onClose).toHaveBeenCalledOnce();
  });
});

const groups = [
  { storageProviderPluginId: null, environments: [{ id: "sandbox", name: "Paperclip Sandbox" }, { id: "ssh", name: "Build host" }] },
  { storageProviderPluginId: "computer-plugin", environments: [{ id: "computer", name: "Agent computers" }] },
];

async function renderForm() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  act(() => root.render(<QueryClientProvider client={client}>
    <NewProjectForm companyId="company-1" onClose={vi.fn()} />
  </QueryClientProvider>));
  await settle();
  const input = container.querySelector<HTMLInputElement>('input[aria-label="Project name"]')!;
  act(() => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(input, "Environment project");
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
  return client;
}

describe("project environment selection", () => {
  it("groups compatible environments and follows the user's default within a group", async () => {
    vi.mocked(projectsApi.environmentOptions).mockResolvedValue({ groups, defaultEnvironmentId: "ssh", error: null });
    vi.mocked(projectsApi.create).mockResolvedValue({ id: "project" } as Awaited<ReturnType<typeof projectsApi.create>>);
    await renderForm();
    const select = container.querySelector<HTMLSelectElement>("select")!;
    expect(select.options).toHaveLength(2);
    expect(select.options[0].textContent).toBe("Paperclip Sandbox, Build host");
    expect(select.value).toBe("sandbox");
    act(() => container.querySelector("form")!.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true })));
    await settle();
    expect(projectsApi.create).toHaveBeenCalledWith("company-1", expect.objectContaining({ environmentId: "ssh" }));
  });

  it("sends an explicit choice and preserves it after a create failure", async () => {
    vi.mocked(projectsApi.environmentOptions).mockResolvedValue({ groups, defaultEnvironmentId: "computer", error: null });
    vi.mocked(projectsApi.create).mockRejectedValue(new Error("Try again"));
    await renderForm();
    const select = container.querySelector<HTMLSelectElement>("select")!;
    expect(select.value).toBe("computer");
    act(() => { select.value = "sandbox"; select.dispatchEvent(new Event("change", { bubbles: true })); });
    act(() => container.querySelector("form")!.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true })));
    await settle();
    expect(projectsApi.create).toHaveBeenCalledWith("company-1", expect.objectContaining({ environmentId: "sandbox", expectedStorageProviderPluginId: null }));
    expect(select.value).toBe("sandbox");
    expect(vi.mocked(projectsApi.create).mock.calls[0][1].executionWorkspacePolicy).toBeUndefined();
  });

  it("hides the picker for compatible environments but still sends the default", async () => {
    vi.mocked(projectsApi.environmentOptions).mockResolvedValue({ groups: [groups[0]], defaultEnvironmentId: "ssh", error: null });
    await renderForm();
    expect(container.querySelector("select")).toBeNull();
    expect(container.querySelector<HTMLButtonElement>('button[type="submit"]')!.disabled).toBe(false);
    act(() => container.querySelector("form")!.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true })));
    await settle();
    expect(projectsApi.create).toHaveBeenCalledWith("company-1", expect.objectContaining({ environmentId: "ssh" }));
  });

  it("never offers a single storage option, even when the default is unavailable", async () => {
    vi.mocked(projectsApi.environmentOptions).mockResolvedValue({ groups: [groups[1]], defaultEnvironmentId: null, error: "Default is unavailable" });
    await renderForm();
    expect(container.querySelector("select")).toBeNull();
    expect(container.querySelector("#project-environment")).toBeNull();
  });

  it("blocks submission while discovery is pending", async () => {
    let resolve!: (value: Awaited<ReturnType<typeof projectsApi.environmentOptions>>) => void;
    vi.mocked(projectsApi.environmentOptions).mockReturnValue(new Promise(value => { resolve = value; }));
    await renderForm();
    expect(container.querySelector<HTMLButtonElement>('button[type="submit"]')!.disabled).toBe(true);
    act(() => container.querySelector("form")!.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true })));
    expect(projectsApi.create).not.toHaveBeenCalled();
    await act(async () => resolve({ groups, defaultEnvironmentId: "computer", error: null }));
    await settle();
    expect(container.querySelector<HTMLButtonElement>('button[type="submit"]')!.disabled).toBe(false);
  });


  it("reports discovery failures and lets the user retry", async () => {
    vi.mocked(projectsApi.environmentOptions).mockRejectedValueOnce(new Error("Environment lookup failed"))
      .mockResolvedValueOnce({ groups, defaultEnvironmentId: "sandbox", error: null });
    await renderForm();
    expect(container.querySelector('[role="alert"]')?.textContent).toContain("Environment lookup failed");
    expect(container.querySelector<HTMLButtonElement>('button[type="submit"]')!.disabled).toBe(true);
    const retry = Array.from(container.querySelectorAll("button")).find(button => button.textContent === "Retry")!;
    act(() => retry.click());
    await settle();
    expect(container.querySelector('[role="alert"]')).toBeNull();
    expect(container.querySelector<HTMLButtonElement>('button[type="submit"]')!.disabled).toBe(false);
  });

  it("keeps cached environment choices during a transient refetch failure", async () => {
    vi.mocked(projectsApi.environmentOptions).mockResolvedValueOnce({ groups, defaultEnvironmentId: "sandbox", error: null })
      .mockRejectedValue(new TypeError("Failed to fetch"));
    const client = await renderForm();
    await act(async () => { await client.refetchQueries({ queryKey: queryKeys.projects.environments("company-1") }); });
    await settle();
    expect(container.querySelector<HTMLSelectElement>("select")?.value).toBe("sandbox");
    expect(container.querySelector('[role="alert"]')).toBeNull();
    expect(container.querySelector<HTMLButtonElement>('button[type="submit"]')!.disabled).toBe(false);
  });

  it("uses the only remaining storage when a refresh removes the chosen one", async () => {
    vi.mocked(projectsApi.environmentOptions).mockResolvedValueOnce({ groups, defaultEnvironmentId: "sandbox", error: null })
      .mockResolvedValue({ groups: [groups[0]], defaultEnvironmentId: "ssh", error: null });
    const client = await renderForm();
    const select = container.querySelector<HTMLSelectElement>("select")!;
    act(() => { select.value = "computer"; select.dispatchEvent(new Event("change", { bubbles: true })); });
    await act(async () => { await client.refetchQueries({ queryKey: queryKeys.projects.environments("company-1") }); });
    await settle();
    expect(container.querySelector("select")).toBeNull();
    expect(container.querySelector<HTMLButtonElement>('button[type="submit"]')!.disabled).toBe(false);
    act(() => container.querySelector("form")!.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true })));
    await settle();
    expect(projectsApi.create).toHaveBeenCalledWith("company-1", expect.objectContaining({ environmentId: "ssh", expectedStorageProviderPluginId: null }));
  });

  it("does not silently substitute storage when the default is unavailable", async () => {
    vi.mocked(projectsApi.environmentOptions).mockResolvedValue({ groups, defaultEnvironmentId: null, error: "Default is unavailable" });
    await renderForm();
    expect(container.querySelector('[role="alert"]')?.textContent).toBe("Default is unavailable");
    expect(container.querySelector<HTMLButtonElement>('button[type="submit"]')!.disabled).toBe(true);
    const select = container.querySelector<HTMLSelectElement>("select")!;
    act(() => { select.value = "sandbox"; select.dispatchEvent(new Event("change", { bubbles: true })); });
    expect(container.querySelector<HTMLButtonElement>('button[type="submit"]')!.disabled).toBe(false);
  });
});

describe("project main agent", () => {
  const mainAgent = { id: "m1", name: "Other", status: "idle", adapterType: "ccpocket_bridge", reportsTo: "boss",
    adapterConfig: { role: "main", hostId: "remote-host-c", provider: "claude", model: "remote-host-c/claude/family:opus-5.5", cwd: "/home/worker/projects/other" } };
  const submit = async () => { act(() => container.querySelector("form")!.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }))); await settle(); };

  it("is not offered when no main agent exists yet", async () => {
    await renderForm();
    expect(container.querySelector("#main-agent-cwd")).toBeNull();
    await submit();
    expect(agentsApi.create).not.toHaveBeenCalled();
  });

  it("creates the same-named agent bound to the new project, makes it the lead, and keeps the steps on retry", async () => {
    vi.mocked(agentsApi.list).mockResolvedValue([mainAgent] as unknown as Awaited<ReturnType<typeof agentsApi.list>>);
    vi.mocked(projectsApi.create).mockResolvedValue({ id: "project-1", name: "Environment project" } as Awaited<ReturnType<typeof projectsApi.create>>);
    vi.mocked(agentsApi.create).mockResolvedValue({ id: "agent-1" } as Awaited<ReturnType<typeof agentsApi.create>>);
    vi.mocked(projectsApi.update).mockRejectedValueOnce(new Error("lead save failed")).mockResolvedValue({} as Awaited<ReturnType<typeof projectsApi.update>>);
    await renderForm();
    await settle();
    expect(container.querySelector<HTMLInputElement>("#main-agent-cwd")!.value).toBe("/home/worker/projects/environment-project");
    await submit();
    expect(container.querySelector('[role="alert"]')?.textContent).toContain("The project was created, but its main agent was not");
    expect(container.querySelector('[role="alert"]')?.textContent).toContain("lead save failed");
    await submit();
    expect(projectsApi.create).toHaveBeenCalledTimes(1);
    expect(agentsApi.create).toHaveBeenCalledTimes(1);
    expect(agentsApi.create).toHaveBeenCalledWith("company-1", expect.objectContaining({ name: "Environment project",
      adapterConfig: expect.objectContaining({ role: "main", projectId: "project-1", cwd: "/home/worker/projects/environment-project", hostId: "remote-host-c" }) }));
    expect(projectsApi.update).toHaveBeenLastCalledWith("project-1", { leadAgentId: "agent-1" }, "company-1");
    expect(projectsApi.update).toHaveBeenCalledTimes(2);
  });

  it("creates only the project when the box is cleared, and blocks an invalid folder", async () => {
    vi.mocked(agentsApi.list).mockResolvedValue([mainAgent] as unknown as Awaited<ReturnType<typeof agentsApi.list>>);
    await renderForm();
    await settle();
    const cwd = container.querySelector<HTMLInputElement>("#main-agent-cwd")!;
    act(() => { Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(cwd, "relative"); cwd.dispatchEvent(new Event("input", { bubbles: true })); });
    expect(container.querySelector<HTMLButtonElement>('button[type="submit"]')!.disabled).toBe(true);
    act(() => container.querySelector<HTMLElement>('[aria-label="Create a main agent"]')!.click());
    expect(container.querySelector<HTMLButtonElement>('button[type="submit"]')!.disabled).toBe(false);
    await submit();
    expect(projectsApi.create).toHaveBeenCalledTimes(1);
    expect(agentsApi.create).not.toHaveBeenCalled();
  });
});
