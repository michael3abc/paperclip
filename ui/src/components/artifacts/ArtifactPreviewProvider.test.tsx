// @vitest-environment jsdom

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { MemoryRouter, Route, Routes, useLocation } from "react-router-dom";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ArtifactPreviewProvider, previewKind } from "./ArtifactPreviewProvider";
import { ArtifactSingleTile, ArtifactTileGrid } from "./v1/ArtifactTile";
import { testSubject } from "./v1/test-subject";
import type { ArtifactFileLink } from "@/lib/artifact-file-link";

vi.mock("@/context/CompanyContext", () => ({
  useCompany: () => ({ selectedCompany: null, selectedCompanyId: null, companies: [] }),
}));

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const NOW = new Date("2026-09-28T18:00:00");

describe("the artifact preview window", () => {
  let container: HTMLDivElement;
  let root: Root;
  const where: string[] = [];
  function Probe() { where.push(useLocation().pathname); return null; }

  beforeEach(() => {
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
    where.length = 0;
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
    vi.unstubAllGlobals();
  });

  function renderTile(file: ArtifactFileLink, kind: "image" | "video" | "file" = "image") {
    act(() =>
      root.render(
        <QueryClientProvider client={new QueryClient()}>
        <MemoryRouter initialEntries={["/PAP/artifacts"]}>
          <ArtifactPreviewProvider>
            <Routes><Route path="*" element={<Probe />} /></Routes>
            <ArtifactTileGrid>
              <ArtifactSingleTile subject={testSubject({ kind, filename: file.filename })} to={file.taskHref ?? undefined} file={file} now={NOW} />
            </ArtifactTileGrid>
          </ArtifactPreviewProvider>
        </MemoryRouter>
        </QueryClientProvider>,
      ),
    );
    return container.querySelector<HTMLAnchorElement>('a[data-testid="artifact-v1-single-tile"]')!;
  }

  function click(target: HTMLElement, init: MouseEventInit = {}) {
    const event = new MouseEvent("click", { bubbles: true, cancelable: true, button: 0, ...init });
    act(() => { target.dispatchEvent(event); });
    return event;
  }

  const dialog = () => document.querySelector('[data-testid="artifact-preview"]');

  it("shows an image in a small window on the same page, with its task, new-tab and download actions", () => {
    const tile = renderTile({ href: "/api/attachments/hero/content", filename: "hero.png", contentType: "image/png",
      downloadHref: "/api/attachments/hero/content?download=1", taskHref: "/PAP/issues/PAP-1#attachment-hero", taskLabel: "PAP-1" });
    expect(click(tile).defaultPrevented).toBe(true);
    expect(dialog()).not.toBeNull();
    expect(dialog()?.querySelector('[data-testid="artifact-preview-image"]')?.getAttribute("src")).toBe("/api/attachments/hero/content");
    expect(dialog()?.querySelector('[aria-label="Open PAP-1"]')?.getAttribute("href")).toBe("/PAP/issues/PAP-1#attachment-hero");
    expect(dialog()?.querySelector('[aria-label="Open in new tab"]')?.getAttribute("target")).toBe("_blank");
    expect(dialog()?.querySelector('[aria-label="Download"]')?.getAttribute("href")).toBe("/api/attachments/hero/content?download=1");
    expect(where.at(-1)).toBe("/PAP/artifacts");
  });

  it("keeps a modifier click as the native new-tab link", () => {
    const tile = renderTile({ href: "/api/attachments/hero/content", filename: "hero.png", contentType: "image/png" });
    expect(click(tile, { metaKey: true }).defaultPrevented).toBe(false);
    expect(dialog()).toBeNull();
  });

  it("plays a video in the window", () => {
    const tile = renderTile({ href: "/api/attachments/reel/content", filename: "reel.mp4", contentType: "video/mp4" }, "video");
    click(tile);
    expect(dialog()?.querySelector('[data-testid="artifact-preview-video"]')?.getAttribute("src")).toBe("/api/attachments/reel/content");
  });

  it("previews a PDF in the window through the validated viewer", () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response("%PDF-1.7\n", { headers: { "content-type": "application/pdf" } })));
    const tile = renderTile({ href: "/api/attachments/brief/content", filename: "brief.pdf", contentType: "application/pdf" }, "file");
    click(tile);
    expect(dialog()?.querySelector('[data-testid="artifact-preview-pdf"]')).not.toBeNull();
  });

  it("offers a download for an Office file it cannot render", () => {
    const tile = renderTile({ href: "/api/attachments/deck/content", filename: "deck.pptx",
      contentType: "application/vnd.openxmlformats-officedocument.presentationml.presentation", downloadHref: "/api/attachments/deck/content?download=1" }, "file");
    click(tile);
    const unsupported = dialog()?.querySelector('[data-testid="artifact-preview-unsupported"]');
    expect(unsupported?.textContent).toContain("cannot be previewed");
    expect(unsupported?.querySelector("a")?.getAttribute("href")).toBe("/api/attachments/deck/content?download=1");
  });

  it("classifies by content type first and by extension only for generic types", () => {
    expect(previewKind({ href: "/x", filename: "a.png", contentType: "application/json" })).toBe("other");
    expect(previewKind({ href: "/x", filename: "a.png", contentType: "application/octet-stream" })).toBe("image");
    expect(previewKind({ href: "/x", filename: "a.bin", contentType: "audio/mpeg" })).toBe("audio");
  });
});
