// @vitest-environment jsdom

import { flushSync } from "react-dom";
import { createRoot } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { MemoryRouter } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Artifacts } from "./Artifacts";
import type { CompanyArtifact, CompanyArtifactGroup } from "../api/artifacts";

const companyState = vi.hoisted(() => ({
  selectedCompanyId: "company-1",
}));

const breadcrumbState = vi.hoisted(() => ({
  setBreadcrumbs: vi.fn(),
}));

const artifactsApiMock = vi.hoisted(() => ({
  list: vi.fn(),
}));

const artifactsV1Flag = vi.hoisted(() => ({ enabled: false, loaded: true }));

vi.mock("@/hooks/useArtifactsV1Enabled", () => ({
  useArtifactsV1Enabled: () => artifactsV1Flag,
}));

vi.mock("../context/CompanyContext", () => ({
  useCompany: () => companyState,
}));

vi.mock("../context/BreadcrumbContext", () => ({
  useBreadcrumbs: () => breadcrumbState,
}));

vi.mock("../api/artifacts", () => ({
  artifactsApi: artifactsApiMock,
}));

// Render the menu inline (no radix portal / pointer-capture) so option clicks
// are deterministic in jsdom.
vi.mock("@/components/ui/dropdown-menu", () => ({
  DropdownMenu: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  DropdownMenuTrigger: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  DropdownMenuContent: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  DropdownMenuLabel: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  DropdownMenuItem: ({
    children,
    onSelect,
    ...rest
  }: {
    children: React.ReactNode;
    onSelect?: () => void;
  }) => (
    <button type="button" onClick={onSelect} {...rest}>
      {children}
    </button>
  ),
}));

vi.mock("../components/artifacts/ArtifactCard", () => ({
  ArtifactCard: ({ artifact }: { artifact: CompanyArtifact }) => (
    <article data-testid="artifact-card">{artifact.title}</article>
  ),
  ArtifactPreview: ({ artifact }: { artifact: CompanyArtifact }) => (
    <div data-testid="artifact-preview">{artifact.title}</div>
  ),
}));

type ObserverCallback = IntersectionObserverCallback;

let latestObserverCallback: ObserverCallback | null = null;

class MockIntersectionObserver {
  readonly root = null;
  readonly rootMargin = "";
  readonly thresholds = [];

  constructor(callback: ObserverCallback) {
    latestObserverCallback = callback;
  }

  observe = vi.fn();
  unobserve = vi.fn();
  disconnect = vi.fn();
  takeRecords = vi.fn(() => []);
}

function sampleArtifact(overrides: Partial<CompanyArtifact> = {}): CompanyArtifact {
  return {
    id: "artifact-1",
    source: "document",
    mediaKind: "document",
    title: "Launch Brief",
    previewText: "launch brief preview",
    contentType: "text/markdown",
    contentPath: null,
    openPath: null,
    downloadPath: null,
    issue: { id: "issue-1", identifier: "PAP-42", title: "Ship launch" },
    project: null,
    createdByAgent: null,
    updatedAt: "2026-06-01T00:00:00.000Z",
    href: "/PAP/issues/PAP-42#document-brief",
    ...overrides,
  };
}

function sampleProjectGroup(overrides: Partial<CompanyArtifactGroup> = {}): CompanyArtifactGroup {
  return {
    id: "project:project-1",
    groupBy: "project",
    issue: null,
    project: { id: "project-1", name: "Launch site" },
    title: "Launch site",
    count: 5,
    mediaKinds: ["image", "file"],
    previewArtifacts: [sampleArtifact({ id: "img-1", source: "attachment", mediaKind: "image", contentType: "image/png", contentPath: "/files/hero.png", title: "hero.png" })],
    updatedAt: "2026-06-01T00:00:00.000Z",
    href: "/PAP/artifacts?groupBy=project&groupProjectId=project-1&mediaOnly=true",
    ...overrides,
  };
}

function sampleGroup(overrides: Partial<CompanyArtifactGroup> = {}): CompanyArtifactGroup {
  return {
    id: "task:issue-1",
    groupBy: "task",
    issue: { id: "issue-1", identifier: "PAP-42", title: "Ship launch" },
    title: "Ship launch",
    count: 3,
    mediaKinds: ["document"],
    previewArtifacts: [sampleArtifact()],
    updatedAt: "2026-06-01T00:00:00.000Z",
    href: "/PAP/artifacts?groupBy=task&groupIssueId=issue-1",
    ...overrides,
  };
}

async function flush() {
  await Promise.resolve();
  await new Promise((resolve) => setTimeout(resolve, 0));
}

async function waitForAssertion(assertion: () => void, attempts = 50) {
  let lastError: unknown;
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    try {
      assertion();
      return;
    } catch (error) {
      lastError = error;
      await flush();
    }
  }
  throw lastError;
}

function renderArtifacts(container: HTMLDivElement, initialEntries: string[] = ["/artifacts"]) {
  const root = createRoot(container);
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  flushSync(() => {
    root.render(
      <QueryClientProvider client={queryClient}>
        <MemoryRouter initialEntries={initialEntries}>
          <Artifacts />
        </MemoryRouter>
      </QueryClientProvider>,
    );
  });
  return { root, queryClient };
}

describe("Artifacts page", () => {
  let container: HTMLDivElement;
  let originalIntersectionObserver: typeof IntersectionObserver | undefined;

  beforeEach(() => {
    container = document.createElement("div");
    document.body.appendChild(container);
    breadcrumbState.setBreadcrumbs.mockReset();
    artifactsApiMock.list.mockReset();
    artifactsV1Flag.enabled = false;
    latestObserverCallback = null;
    originalIntersectionObserver = window.IntersectionObserver;
    window.IntersectionObserver = MockIntersectionObserver as unknown as typeof IntersectionObserver;
  });

  afterEach(() => {
    window.IntersectionObserver = originalIntersectionObserver as typeof IntersectionObserver;
    container.remove();
  });

  it("requests project folders by default", async () => {
    artifactsApiMock.list.mockResolvedValue({ artifacts: [], groups: [sampleProjectGroup()], nextCursor: null });

    const { root } = renderArtifacts(container);

    await waitForAssertion(() => {
      expect(artifactsApiMock.list).toHaveBeenCalledWith("company-1", {
        kind: "all",
        q: undefined,
        groupBy: "project",
        groupIssueId: undefined,
        mediaOnly: true,
        limit: 30,
        cursor: undefined,
      });
      const groupControl = container.querySelector('[data-testid="artifact-group-control"]') as HTMLButtonElement;
      const allFilter = [...container.querySelectorAll('[aria-label="Filter artifacts by type"] button')]
        .find((element) => element.textContent === "All") as HTMLButtonElement;
      expect(groupControl).not.toBeNull();
      expect(groupControl.textContent).toBe("");
      expect(groupControl.getAttribute("data-variant")).toBe("outline");
      expect(groupControl.getAttribute("data-size")).toBe("icon");
      expect(groupControl.getAttribute("data-group-by")).toBe("project");
      const card = container.querySelector('[data-testid="artifact-group-card"]') as HTMLElement;
      expect(card.getAttribute("href")).toBe("/artifacts?groupProjectId=project-1");
      expect(card.textContent).toContain("Launch site");
      expect(card.querySelector('[data-testid="artifact-group-folder-icon"]')).not.toBeNull();
      expect(Boolean(groupControl.compareDocumentPosition(allFilter) & Node.DOCUMENT_POSITION_FOLLOWING)).toBe(true);
    });

    flushSync(() => {
      root.unmount();
    });
  });

  it("debounces artifact search into the artifacts API", async () => {
    artifactsApiMock.list
      .mockResolvedValueOnce({ artifacts: [], groups: [sampleGroup()], nextCursor: null })
      .mockResolvedValueOnce({ artifacts: [], groups: [], nextCursor: null });

    const { root } = renderArtifacts(container);

    const input = container.querySelector('input[aria-label="Search artifacts"]') as HTMLInputElement;
    expect(input).not.toBeNull();

    flushSync(() => {
      const nativeSetter = Object.getOwnPropertyDescriptor(
        HTMLInputElement.prototype,
        "value",
      )!.set!;
      nativeSetter.call(input, "launch");
      input.dispatchEvent(new Event("input", { bubbles: true }));
    });

    await new Promise((resolve) => setTimeout(resolve, 300));

    await waitForAssertion(() => {
      expect(artifactsApiMock.list).toHaveBeenLastCalledWith("company-1", {
        kind: "all",
        q: "launch",
        groupBy: "project",
        groupIssueId: undefined,
        mediaOnly: true,
        limit: 30,
        cursor: undefined,
      });
    });

    flushSync(() => {
      root.unmount();
    });
  });

  it("keeps the artifacts grid max-width constrained and left aligned", async () => {
    artifactsApiMock.list.mockResolvedValue({ artifacts: [sampleArtifact()], nextCursor: null });

    const { root } = renderArtifacts(container, ["/artifacts?groupBy=none"]);

    await waitForAssertion(() => {
      expect(container.querySelector('[data-testid="artifact-card"]')).not.toBeNull();
    });

    const pageShell = container.firstElementChild as HTMLElement | null;
    expect(pageShell?.className).toContain("max-w-6xl");
    expect(pageShell?.className).not.toContain("mx-auto");

    flushSync(() => {
      root.unmount();
    });
  });

  it("fetches the next artifact page when the sentinel intersects", async () => {
    artifactsApiMock.list
      .mockResolvedValueOnce({
        artifacts: [sampleArtifact({ id: "artifact-1", title: "First Artifact" })],
        nextCursor: "cursor-2",
      })
      .mockResolvedValueOnce({
        artifacts: [sampleArtifact({ id: "artifact-2", title: "Second Artifact" })],
        nextCursor: null,
      });

    const { root } = renderArtifacts(container, ["/artifacts?groupBy=none"]);

    await waitForAssertion(() => {
      expect(container.textContent).toContain("First Artifact");
      expect(latestObserverCallback).not.toBeNull();
    });

    latestObserverCallback?.(
      [{ isIntersecting: true } as IntersectionObserverEntry],
      {} as IntersectionObserver,
    );

    await waitForAssertion(() => {
      expect(artifactsApiMock.list).toHaveBeenLastCalledWith("company-1", {
        kind: "all",
        q: undefined,
        groupBy: "none",
        groupIssueId: undefined,
        mediaOnly: true,
        limit: 30,
        cursor: "cursor-2",
      });
      expect(container.textContent).toContain("Second Artifact");
    });

    flushSync(() => {
      root.unmount();
    });
  });

  it("switches grouping via the group control and refetches stacks", async () => {
    artifactsApiMock.list.mockImplementation((_companyId: string, params?: { groupBy?: string }) => {
      if (params?.groupBy === "none") {
        return Promise.resolve({ artifacts: [sampleArtifact()], nextCursor: null });
      }
      return Promise.resolve({ artifacts: [], groups: [sampleGroup()], nextCursor: null });
    });

    const { root } = renderArtifacts(container);

    await waitForAssertion(() => {
      expect(container.querySelector('[data-testid="artifact-group-card"]')).not.toBeNull();
    });

    const noneOption = container.querySelector(
      '[data-testid="artifact-group-option-none"]',
    ) as HTMLButtonElement;
    expect(noneOption).not.toBeNull();

    flushSync(() => {
      noneOption.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
    });

    await waitForAssertion(() => {
      expect(artifactsApiMock.list).toHaveBeenLastCalledWith("company-1", {
        kind: "all",
        q: undefined,
        groupBy: "none",
        groupIssueId: undefined,
        mediaOnly: true,
        limit: 30,
        cursor: undefined,
      });
      expect(container.querySelector('[data-testid="artifact-card"]')).not.toBeNull();
      const groupControl = container.querySelector('[data-testid="artifact-group-control"]') as HTMLElement;
      expect(groupControl.getAttribute("data-group-by")).toBe("none");
    });

    flushSync(() => {
      root.unmount();
    });
  });

  it("renders stack cards from a grouped URL with count metadata", async () => {
    artifactsApiMock.list.mockResolvedValue({
      artifacts: [],
      groups: [sampleGroup({ count: 4 })],
      nextCursor: null,
    });

    const { root } = renderArtifacts(container, ["/artifacts?groupBy=task"]);

    await waitForAssertion(() => {
      expect(artifactsApiMock.list).toHaveBeenCalledWith("company-1", {
        kind: "all",
        q: undefined,
        groupBy: "task",
        groupIssueId: undefined,
        mediaOnly: true,
        limit: 30,
        cursor: undefined,
      });
      const card = container.querySelector('[data-testid="artifact-group-card"]') as HTMLElement;
      expect(card).not.toBeNull();
      expect(card.getAttribute("data-count")).toBe("4");
      expect(card.getAttribute("data-stacked")).toBe("true");
      expect(card.getAttribute("href")).toBe("/artifacts?groupBy=task&groupIssueId=issue-1");
      expect(card.textContent).toContain("4 artifacts");
    });

    flushSync(() => {
      root.unmount();
    });
  });

  it("opens a stack from the URL and shows the back affordance and artifacts", async () => {
    artifactsApiMock.list.mockResolvedValue({
      artifacts: [sampleArtifact({ title: "Stacked Artifact" })],
      selectedGroup: sampleGroup(),
      nextCursor: null,
    });

    const { root } = renderArtifacts(container, [
      "/artifacts?groupBy=task&groupIssueId=issue-1",
    ]);

    await waitForAssertion(() => {
      expect(artifactsApiMock.list).toHaveBeenCalledWith("company-1", {
        kind: "all",
        q: undefined,
        groupBy: "task",
        groupIssueId: "issue-1",
        mediaOnly: true,
        limit: 30,
        cursor: undefined,
      });
      expect(container.querySelector('[data-testid="artifact-stack-back"]')).not.toBeNull();
      expect(
        (container.querySelector('[data-testid="artifact-stack-back"]') as HTMLAnchorElement).getAttribute("href"),
      ).toBe("/artifacts?groupBy=task");
      expect(container.textContent).toContain("Stacked Artifact");
      expect(container.querySelector('[data-testid="artifact-card"]')).not.toBeNull();
    });

    flushSync(() => {
      root.unmount();
    });
  });

  it("opens a project folder from the URL with its breadcrumb and back link", async () => {
    artifactsApiMock.list.mockResolvedValue({
      artifacts: [sampleArtifact({ id: "deck", source: "attachment", mediaKind: "file", contentType: "application/vnd.openxmlformats-officedocument.presentationml.presentation", title: "deck.pptx" })],
      selectedGroup: sampleProjectGroup({ count: 1 }),
      nextCursor: null,
    });

    const { root } = renderArtifacts(container, ["/artifacts?groupProjectId=project-1"]);

    await waitForAssertion(() => {
      expect(artifactsApiMock.list).toHaveBeenCalledWith("company-1", {
        kind: "all",
        q: undefined,
        groupBy: "project",
        groupIssueId: undefined,
        groupProjectId: "project-1",
        mediaOnly: true,
        limit: 30,
        cursor: undefined,
      });
      const back = container.querySelector('[data-testid="artifact-stack-back"]') as HTMLAnchorElement;
      expect(back.getAttribute("href")).toBe("/artifacts");
      expect(back.textContent).toContain("All projects");
      expect(container.textContent).toContain("Launch site · 1 artifact");
      expect(container.textContent).toContain("deck.pptx");
      expect(breadcrumbState.setBreadcrumbs).toHaveBeenLastCalledWith([
        { label: "Artifacts", href: "/artifacts" },
        { label: "Launch site" },
      ]);
    });

    flushSync(() => {
      root.unmount();
    });
  });

  it("still opens a task stack from a link saved while Task was the default grouping", async () => {
    artifactsApiMock.list.mockResolvedValue({ artifacts: [sampleArtifact()], selectedGroup: sampleGroup(), nextCursor: null });

    const { root } = renderArtifacts(container, ["/artifacts?groupIssueId=issue-1"]);

    await waitForAssertion(() => {
      expect(artifactsApiMock.list).toHaveBeenCalledWith("company-1", expect.objectContaining({ groupBy: "task", groupIssueId: "issue-1" }));
      const back = container.querySelector('[data-testid="artifact-stack-back"]') as HTMLAnchorElement;
      expect(back.textContent).toContain("All stacks");
      expect(back.getAttribute("href")).toBe("/artifacts?groupBy=task");
    });

    flushSync(() => {
      root.unmount();
    });
  });

  it("preserves the media filter when grouping", async () => {
    artifactsApiMock.list.mockResolvedValue({
      artifacts: [],
      groups: [sampleGroup()],
      nextCursor: null,
    });

    const { root } = renderArtifacts(container, ["/artifacts?kind=image&groupBy=task"]);

    await waitForAssertion(() => {
      expect(artifactsApiMock.list).toHaveBeenCalledWith("company-1", {
        kind: "image",
        q: undefined,
        groupBy: "task",
        groupIssueId: undefined,
        mediaOnly: true,
        limit: 30,
        cursor: undefined,
      });
    });

    flushSync(() => {
      root.unmount();
    });
  });
});

describe("Artifacts page — Artifacts V1 (Settings > Experimental)", () => {
  let container: HTMLDivElement;
  let originalIntersectionObserver: typeof IntersectionObserver | undefined;

  const radio = (label: string) => Array.from(container.querySelectorAll<HTMLButtonElement>('[role="radio"]')).find((el) => el.textContent?.trim() === label) ?? null;

  beforeEach(() => {
    container = document.createElement("div");
    document.body.appendChild(container);
    breadcrumbState.setBreadcrumbs.mockReset();
    artifactsApiMock.list.mockReset();
    artifactsV1Flag.enabled = true;
    latestObserverCallback = null;
    originalIntersectionObserver = window.IntersectionObserver;
    window.IntersectionObserver = MockIntersectionObserver as unknown as typeof IntersectionObserver;
  });

  afterEach(() => {
    window.IntersectionObserver = originalIntersectionObserver as typeof IntersectionObserver;
    artifactsV1Flag.enabled = false;
    container.remove();
  });

  it("shows the Projects view by default: a folder tile per project, including the folder without a project", async () => {
    artifactsApiMock.list.mockResolvedValue({
      artifacts: [],
      groups: [
        sampleProjectGroup(),
        sampleProjectGroup({ id: "project:none", project: null, title: "No project", count: 1, href: "/PAP/artifacts?groupBy=project&groupProjectId=none" }),
      ],
      nextCursor: null,
    });
    const { root } = renderArtifacts(container);
    await waitForAssertion(() => {
      expect(container.querySelectorAll('[data-testid="artifact-v1-folder-tile"]')).toHaveLength(2);
    });
    const [projectTile, noProjectTile] = Array.from(container.querySelectorAll<HTMLAnchorElement>('[data-testid="artifact-v1-folder-tile"]'));
    expect(projectTile?.getAttribute("href")).toBe("/artifacts?groupProjectId=project-1");
    expect(projectTile?.textContent).toContain("Launch site");
    expect(projectTile?.textContent).toContain("5 Artifacts");
    expect(projectTile?.querySelector("[data-artifact-pill]")).toBeNull();
    // A folder with one file is still a folder, not the file itself.
    expect(noProjectTile?.getAttribute("href")).toBe("/artifacts?groupProjectId=none");
    expect(noProjectTile?.textContent).toContain("No project");
    expect(radio("Projects")?.getAttribute("aria-checked")).toBe("true");
    expect(artifactsApiMock.list).toHaveBeenLastCalledWith("company-1", expect.objectContaining({ groupBy: "project", kind: "all", mediaOnly: true }));
    flushSync(() => root.unmount());
  });

  it("shows the task grouping from the Group by menu as stack tiles with the identifier pill", async () => {
    artifactsApiMock.list.mockResolvedValue({ artifacts: [], groups: [sampleGroup()], nextCursor: null });
    const { root } = renderArtifacts(container, ["/artifacts?groupBy=task"]);
    await waitForAssertion(() => {
      expect(container.querySelector('[data-testid="artifact-v1-stack-tile"]')).not.toBeNull();
    });
    const tile = container.querySelector<HTMLAnchorElement>('[data-testid="artifact-v1-stack-tile"]');
    expect(tile?.getAttribute("href")).toBe("/artifacts?groupBy=task&groupIssueId=issue-1");
    expect(tile?.querySelector("[data-artifact-pill]")?.textContent).toBe("PAP-42");
    expect(tile?.textContent).toContain("3 Artifacts");
    expect(radio("Projects")?.getAttribute("aria-checked")).toBe("false");
    expect(artifactsApiMock.list).toHaveBeenLastCalledWith("company-1", expect.objectContaining({ groupBy: "task", kind: "all" }));
    flushSync(() => root.unmount());
  });

  it("shows a task with one artifact as a single tile that opens the artifact", async () => {
    artifactsApiMock.list.mockResolvedValue({ artifacts: [], groups: [sampleGroup({ count: 1 })], nextCursor: null });
    const { root } = renderArtifacts(container, ["/artifacts?groupBy=task"]);
    await waitForAssertion(() => {
      expect(container.querySelector('[data-testid="artifact-v1-single-tile"]')).not.toBeNull();
    });
    expect(container.querySelector<HTMLAnchorElement>('[data-testid="artifact-v1-single-tile"]')?.getAttribute("href")).toBe("/PAP/issues/PAP-42#document-brief");
    expect(container.querySelector('[data-testid="artifact-v1-stack-tile"]')).toBeNull();
    flushSync(() => root.unmount());
  });

  it("switches to a flat view by kind from the view tabs", async () => {
    artifactsApiMock.list
      .mockResolvedValueOnce({ artifacts: [], groups: [sampleGroup()], nextCursor: null })
      .mockResolvedValueOnce({ artifacts: [sampleArtifact({ id: "img-1", source: "work_product", mediaKind: "image", contentType: "image/png", contentPath: "/files/hero.png", title: "Hero" })], nextCursor: null });
    const { root } = renderArtifacts(container);
    await waitForAssertion(() => {
      expect(radio("Images")).not.toBeNull();
    });
    flushSync(() => radio("Images")!.click());
    await waitForAssertion(() => {
      expect(artifactsApiMock.list).toHaveBeenLastCalledWith("company-1", expect.objectContaining({ groupBy: "none", kind: "image" }));
      expect(container.querySelector('[data-testid="artifact-v1-single-tile"]')).not.toBeNull();
    });
    expect(radio("Images")?.getAttribute("aria-checked")).toBe("true");
    expect(container.querySelector("[data-artifact-print]")).not.toBeNull();
    flushSync(() => root.unmount());
  });

  it("never hides an active kind under a grouping: a kind in the URL is a flat view, and grouping clears it", async () => {
    artifactsApiMock.list.mockResolvedValue({ artifacts: [sampleArtifact({ id: "img-1", source: "work_product", mediaKind: "image", contentType: "image/png", contentPath: "/files/hero.png" })], nextCursor: null });
    const { root } = renderArtifacts(container, ["/artifacts?kind=image&groupBy=task"]);
    await waitForAssertion(() => {
      expect(artifactsApiMock.list).toHaveBeenLastCalledWith("company-1", expect.objectContaining({ groupBy: "none", kind: "image" }));
    });
    expect(radio("Images")?.getAttribute("aria-checked")).toBe("true");
    expect(radio("Projects")?.getAttribute("aria-checked")).toBe("false");
    artifactsApiMock.list.mockResolvedValue({ artifacts: [], groups: [sampleProjectGroup()], nextCursor: null });
    flushSync(() => radio("Projects")!.click());
    await waitForAssertion(() => {
      expect(artifactsApiMock.list).toHaveBeenLastCalledWith("company-1", expect.objectContaining({ groupBy: "project", kind: "all" }));
    });
    expect(radio("Projects")?.getAttribute("aria-checked")).toBe("true");
    artifactsApiMock.list.mockResolvedValue({ artifacts: [], groups: [sampleGroup()], nextCursor: null });
    flushSync(() => container.querySelector<HTMLButtonElement>('[data-testid="artifact-group-option-task"]')!.click());
    await waitForAssertion(() => {
      expect(artifactsApiMock.list).toHaveBeenLastCalledWith("company-1", expect.objectContaining({ groupBy: "task", kind: "all" }));
    });
    flushSync(() => root.unmount());
  });

  it("opens a media file in a folder in the preview window, not its task's session", async () => {
    artifactsApiMock.list.mockResolvedValue({
      artifacts: [sampleArtifact({ id: "hero", source: "attachment", mediaKind: "image", contentType: "image/png", title: "hero.png",
        contentPath: "/api/attachments/hero/content", openPath: "/api/attachments/hero/content", href: "/PAP/issues/PAP-42#attachment-hero" })],
      selectedGroup: sampleProjectGroup({ count: 1 }),
      nextCursor: null,
    });
    const { root } = renderArtifacts(container, ["/artifacts?groupProjectId=project-1"]);
    await waitForAssertion(() => {
      expect(container.querySelector('[data-testid="artifact-v1-single-tile"]')).not.toBeNull();
    });
    const tile = container.querySelector<HTMLAnchorElement>('[data-testid="artifact-v1-single-tile"]')!;
    expect(tile.getAttribute("href")).toBe("/api/attachments/hero/content");
    expect(tile.getAttribute("target")).toBe("_blank");
    // A plain click shows the file in the page's preview window instead of a new tab.
    const event = new MouseEvent("click", { bubbles: true, cancelable: true, button: 0 });
    flushSync(() => { tile.dispatchEvent(event); });
    expect(event.defaultPrevented).toBe(true);
    await waitForAssertion(() => {
      expect(document.querySelector('[data-testid="artifact-preview-image"]')?.getAttribute("src")).toBe("/api/attachments/hero/content");
    });
    flushSync(() => root.unmount());
  });

  it("renders an open stack as single tiles behind the All stacks row", async () => {
    artifactsApiMock.list.mockResolvedValue({
      artifacts: [sampleArtifact(), sampleArtifact({ id: "artifact-2", title: "Deck", href: "/PAP/issues/PAP-42#deck" })],
      groups: [],
      selectedGroup: sampleGroup(),
      nextCursor: null,
    });
    const { root } = renderArtifacts(container, ["/artifacts?groupIssueId=issue-1"]);
    await waitForAssertion(() => {
      expect(container.querySelectorAll('[data-testid="artifact-v1-single-tile"]')).toHaveLength(2);
    });
    expect(container.querySelector('[data-testid="artifact-stack-back"]')).not.toBeNull();
    flushSync(() => root.unmount());
  });

  it("renders an open project folder as single tiles behind the All projects row", async () => {
    artifactsApiMock.list.mockResolvedValue({
      artifacts: [sampleArtifact({ id: "deck", source: "attachment", mediaKind: "file", contentType: "application/vnd.openxmlformats-officedocument.presentationml.presentation", title: "deck.pptx", href: "/PAP/issues/PAP-42#attachment-deck" })],
      selectedGroup: sampleProjectGroup({ count: 1 }),
      nextCursor: null,
    });
    const { root } = renderArtifacts(container, ["/artifacts?groupProjectId=project-1"]);
    await waitForAssertion(() => {
      expect(container.querySelectorAll('[data-testid="artifact-v1-single-tile"]')).toHaveLength(1);
    });
    expect(container.querySelector('[data-testid="artifact-stack-back"]')?.textContent).toContain("All projects");
    expect(radio("Projects")?.getAttribute("aria-checked")).toBe("true");
    expect(artifactsApiMock.list).toHaveBeenLastCalledWith("company-1", expect.objectContaining({ groupBy: "project", groupProjectId: "project-1" }));
    flushSync(() => root.unmount());
  });
  it("offers only media views and always requests the media-only projection", async () => {
    artifactsApiMock.list.mockResolvedValue({ artifacts: [], groups: [sampleGroup()], nextCursor: null });
    const { root } = renderArtifacts(container);
    await waitForAssertion(() => {
      expect(radio("Images")).not.toBeNull();
    });
    const labels = Array.from(container.querySelectorAll<HTMLButtonElement>('[role="radio"]')).map((el) => el.textContent?.trim());
    expect(labels).toEqual(["Projects", "All files", "Images", "Videos", "Audio, PDF & Office"]);
    expect(artifactsApiMock.list).toHaveBeenLastCalledWith("company-1", expect.objectContaining({ mediaOnly: true }));
    flushSync(() => root.unmount());
  });

  it("falls back to all media when a stale URL asks for the removed document or text kinds", async () => {
    artifactsApiMock.list.mockResolvedValue({ artifacts: [], nextCursor: null });
    const { root } = renderArtifacts(container, ["/artifacts?kind=document&groupBy=none"]);
    await waitForAssertion(() => {
      expect(artifactsApiMock.list).toHaveBeenLastCalledWith("company-1", expect.objectContaining({ kind: "all", groupBy: "none", mediaOnly: true }));
    });
    expect(radio("All files")?.getAttribute("aria-checked")).toBe("true");
    flushSync(() => root.unmount());
  });

  it("explains the media-only empty state for the projects and flat views", async () => {
    artifactsApiMock.list.mockResolvedValue({ artifacts: [], groups: [], nextCursor: null });
    const { root } = renderArtifacts(container);
    await waitForAssertion(() => {
      expect(container.textContent).toContain("No media artifacts in any project yet.");
    });
    flushSync(() => root.unmount());

    const flat = renderArtifacts(container, ["/artifacts?groupBy=none"]);
    await waitForAssertion(() => {
      expect(container.textContent).toContain("No media artifacts yet.");
    });
    flushSync(() => flat.root.unmount());
  });
});
