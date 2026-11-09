// @vitest-environment jsdom

import { flushSync } from "react-dom";
import { createRoot } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { MemoryRouter } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { CompanyArtifact } from "../api/artifacts";
import { ProjectArtifacts } from "./ProjectExecutionRecords";

const artifactsApiMock = vi.hoisted(() => ({ list: vi.fn() }));
const projectsApiMock = vi.hoisted(() => ({ workProducts: vi.fn(), sessions: vi.fn() }));

vi.mock("../api/artifacts", () => ({ artifactsApi: artifactsApiMock }));
vi.mock("../api/projects", () => ({ projectsApi: projectsApiMock }));
vi.mock("./artifacts/ArtifactCard", () => ({
  ArtifactCard: ({ artifact }: { artifact: CompanyArtifact }) => <article data-testid="artifact-card">{artifact.title}</article>,
}));

async function waitFor(assertion: () => void, attempts = 50) {
  let lastError: unknown;
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    try {
      assertion();
      return;
    } catch (error) {
      lastError = error;
      await new Promise((resolve) => setTimeout(resolve, 0));
    }
  }
  throw lastError;
}

describe("ProjectArtifacts", () => {
  let container: HTMLDivElement;

  beforeEach(() => {
    container = document.createElement("div");
    document.body.appendChild(container);
    artifactsApiMock.list.mockReset();
    projectsApiMock.workProducts.mockReset();
    projectsApiMock.workProducts.mockResolvedValue({ records: [], nextOffset: null });
  });

  afterEach(() => container.remove());

  it("lists only the project's media files, the same projection as its Artifacts folder", async () => {
    artifactsApiMock.list.mockResolvedValue({
      artifacts: [{
        id: "attachment:1",
        source: "attachment",
        mediaKind: "file",
        title: "deck.pptx",
        previewText: null,
        contentType: "application/vnd.openxmlformats-officedocument.presentationml.presentation",
        contentPath: "/api/attachments/1/content",
        openPath: "/api/attachments/1/content",
        downloadPath: "/api/attachments/1/content?download=1",
        issue: { id: "issue-1", identifier: "PAP-1", title: "Deck" },
        project: { id: "project-1", name: "Launch" },
        createdByAgent: null,
        updatedAt: "2026-11-09T00:00:00.000Z",
        href: "/PAP/issues/PAP-1#attachment-1",
      } satisfies CompanyArtifact],
      nextCursor: null,
    });
    const root = createRoot(container);
    flushSync(() => root.render(
      <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
        <MemoryRouter>
          <ProjectArtifacts companyId="company-1" projectId="project-1" />
        </MemoryRouter>
      </QueryClientProvider>,
    ));

    await waitFor(() => {
      expect(artifactsApiMock.list).toHaveBeenCalledWith("company-1", { projectId: "project-1", mediaOnly: true, limit: 30, cursor: undefined });
      expect(container.querySelector('[data-testid="artifact-card"]')?.textContent).toBe("deck.pptx");
    });
    expect(container.textContent).toContain("Task documents such as plans and notes are not listed");
    flushSync(() => root.unmount());
  });
});
