// @vitest-environment jsdom

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { MemoryRouter, Route, Routes, useLocation } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ArtifactSingleTile, ArtifactStackTile, ArtifactTileGrid } from "./ArtifactTile";
import { testSubject } from "./test-subject";
import { PdfPreviewProvider } from "@/components/PdfPreviewProvider";

vi.mock("@/context/CompanyContext", () => ({
  useCompany: () => ({ selectedCompany: null, selectedCompanyId: null, companies: [] }),
}));

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const NOW = new Date("2026-09-28T18:00:00");

describe("the Artifacts page tiles", () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
  });

  it("renders a stack as a link with the task's pill, its count and when it changed", () => {
    act(() =>
      root.render(
        <MemoryRouter>
          <ArtifactTileGrid>
            <ArtifactStackTile identifier="ACM-3" title="Create visual directions" count={21} updatedAt="2026-09-28T11:07:00" front={testSubject({ kind: "pdf", filename: "deck.pdf" })} to="/artifacts?issue=i3" now={NOW} />
          </ArtifactTileGrid>
        </MemoryRouter>,
      ),
    );
    const link = container.querySelector('a[data-testid="artifact-v1-stack-tile"]');
    expect(link?.getAttribute("href")).toBe("/artifacts?issue=i3");
    expect(link?.className).toContain("artifact-tile");
    expect(container.querySelector("[data-artifact-pill]")?.textContent).toBe("ACM-3");
    expect(link?.textContent).toContain("21 Artifacts");
    expect(link?.textContent).toContain("Updated 11:07 AM");
    expect(container.querySelector('[data-artifact-stack="sheet"]')).not.toBeNull();
    expect(container.querySelectorAll("[data-artifact-spread]")).toHaveLength(2);
  });

  it("renders a picture stack on the media backing with a fitted print", () => {
    act(() =>
      root.render(
        <MemoryRouter>
          <ArtifactTileGrid>
            <ArtifactStackTile identifier="ACM-5" title="Shoot cap product photos" count={6} updatedAt="2026-09-27T15:12:00" front={testSubject({ kind: "image", thumbnailUrl: "/cap.png", aspect: 3 / 2 })} now={NOW} />
          </ArtifactTileGrid>
        </MemoryRouter>,
      ),
    );
    expect(container.querySelector('[data-artifact-stack="media"]')).not.toBeNull();
    const print = container.querySelector<HTMLElement>("[data-artifact-print]");
    expect(print?.style.width).toBe("245px");
    expect(print?.style.height).toBe("163.33px");
  });

  it("plays a video's own stream in the print when it has no poster, never an image tag on the video", () => {
    act(() =>
      root.render(
        <MemoryRouter>
          <ArtifactTileGrid>
            <ArtifactSingleTile subject={testSubject({ kind: "video", filename: "reel.webm", videoUrl: "/api/files/reel.webm" })} now={NOW} />
          </ArtifactTileGrid>
        </MemoryRouter>,
      ),
    );
    const print = container.querySelector("[data-artifact-print]");
    expect(print?.querySelector("video")?.getAttribute("src")).toBe("/api/files/reel.webm");
    expect(print?.querySelector("img")).toBeNull();
  });

  it("renders a single artifact as a button named after its file, with the sheet treatment", () => {
    act(() =>
      root.render(
        <MemoryRouter>
          <ArtifactTileGrid>
            <ArtifactSingleTile subject={testSubject({ kind: "document", title: "Brand strategy", filename: "brand-strategy-brief.md", hasText: true, taskIdentifier: "ACM-2" })} now={NOW} />
          </ArtifactTileGrid>
        </MemoryRouter>,
      ),
    );
    const button = container.querySelector('button[data-testid="artifact-v1-single-tile"]');
    expect(button?.getAttribute("aria-label")).toBe("Open brand-strategy-brief.md");
    expect(container.querySelector('[data-artifact-sheet="preview"]')?.textContent).toContain("Brand strategy");
    expect(container.querySelector("[data-artifact-front]")).not.toBeNull();
  });

  it("opens a single file artifact as the file itself: a new tab, or the in-app preview for a PDF, never its task", () => {
    act(() =>
      root.render(
        <MemoryRouter>
          <ArtifactTileGrid>
            <ArtifactSingleTile subject={testSubject({ kind: "image", filename: "hero.png", thumbnailUrl: "/api/attachments/hero/content" })} to="/PAP/issues/PAP-1#attachment-hero" file={{ href: "/api/attachments/hero/content", filename: "hero.png", contentType: "image/png" }} now={NOW} />
          </ArtifactTileGrid>
        </MemoryRouter>,
      ),
    );
    const tile = container.querySelector<HTMLAnchorElement>('a[data-testid="artifact-v1-single-tile"]');
    expect(tile?.getAttribute("href")).toBe("/api/attachments/hero/content");
    expect(tile?.getAttribute("target")).toBe("_blank");
    expect(tile?.getAttribute("rel")).toBe("noreferrer");
    expect(tile?.getAttribute("aria-label")).toBe("Open hero.png");
  });

  it("previews a PDF tile in place without leaving the page", () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response("%PDF-1.7\n", { headers: { "content-type": "application/pdf" } })));
    const where: string[] = [];
    function Probe() { where.push(useLocation().pathname); return null; }
    act(() =>
      root.render(
        <MemoryRouter initialEntries={["/PAP/artifacts"]}>
          <PdfPreviewProvider>
            <Routes><Route path="*" element={<Probe />} /></Routes>
            <ArtifactTileGrid>
              <ArtifactSingleTile subject={testSubject({ kind: "file", filename: "brief.pdf" })} to="/PAP/issues/PAP-1#attachment-brief" file={{ href: "/api/attachments/brief/content", filename: "brief.pdf", contentType: "application/pdf" }} now={NOW} />
            </ArtifactTileGrid>
          </PdfPreviewProvider>
        </MemoryRouter>,
      ),
    );
    const tile = container.querySelector<HTMLAnchorElement>('a[data-testid="artifact-v1-single-tile"]')!;
    const event = new MouseEvent("click", { bubbles: true, cancelable: true, button: 0 });
    act(() => { tile.dispatchEvent(event); });
    expect(event.defaultPrevented).toBe(true);
    expect(document.querySelector('[data-slot="dialog-content"]')).not.toBeNull();
    expect(where.at(-1)).toBe("/PAP/artifacts");
    vi.unstubAllGlobals();
  });

  it("keeps the 4:3 print until a single picture loads, and shows the icon sheet when its file cannot be loaded", () => {
    act(() =>
      root.render(
        <MemoryRouter>
          <ArtifactTileGrid>
            <ArtifactSingleTile subject={testSubject({ kind: "image", filename: "hero.png", thumbnailUrl: "/api/attachments/gone/content" })} now={NOW} />
          </ArtifactTileGrid>
        </MemoryRouter>,
      ),
    );
    const print = container.querySelector<HTMLElement>("[data-artifact-print]")!;
    expect([print.style.width, print.style.height]).toEqual(["240px", "180px"]);
    act(() => { print.querySelector("img")!.dispatchEvent(new Event("error")); });
    expect(container.querySelector("[data-artifact-print]")).toBeNull();
    const sheet = container.querySelector('[data-artifact-front] [data-artifact-sheet="icon"]');
    expect(sheet?.textContent).toContain("PNG");
    expect(sheet?.querySelector(".lucide-image")).not.toBeNull();
    expect(container.querySelector('button[data-testid="artifact-v1-single-tile"]')?.getAttribute("aria-label")).toBe("Open hero.png");
  });

  it("stands a picture stack's front as the icon sheet, where audio stands, when the picture cannot be loaded, and prints a new picture back in its place", () => {
    const render = (thumbnailUrl: string) =>
      act(() =>
        root.render(
          <MemoryRouter>
            <ArtifactTileGrid>
              <ArtifactStackTile identifier="ACM-5" title="Shoot cap product photos" count={6} updatedAt="2026-09-27T15:12:00" front={testSubject({ kind: "image", filename: "cap.png", thumbnailUrl })} now={NOW} />
              <ArtifactStackTile identifier="ACM-6" title="Record the jingle" count={2} updatedAt="2026-09-27T15:12:00" front={testSubject({ kind: "file", filename: "jingle.mp3" })} now={NOW} />
            </ArtifactTileGrid>
          </MemoryRouter>,
        ),
      );
    const tiles = () => Array.from(container.querySelectorAll<HTMLElement>('[data-testid="artifact-v1-stack-tile"]'));
    const placement = (el: HTMLElement | null) => el && [el.style.left, el.style.top, el.style.width, el.style.height];
    render("/api/attachments/gone/content");
    let [pictures, audio] = tiles();
    const printed = placement(pictures.querySelector<HTMLElement>("[data-artifact-print]"));
    expect(printed?.[2]).toBe("245px");
    act(() => { pictures.querySelector("[data-artifact-print] img")!.dispatchEvent(new Event("error")); });
    expect(pictures.querySelector("[data-artifact-print]")).toBeNull();
    expect(pictures.querySelector('[data-artifact-stack="media"]')).not.toBeNull();
    expect(pictures.querySelector('[data-artifact-sheet="icon"]')?.textContent).toContain("PNG");
    const front = pictures.querySelector<HTMLElement>("[data-artifact-front]")!;
    const audioFront = audio.querySelector<HTMLElement>("[data-artifact-front]")!;
    expect([front.style.left, front.style.top]).toEqual([audioFront.style.left, audioFront.style.top]);
    expect(audio.querySelector("[data-artifact-print]")).toBeNull();
    // A newer artifact takes the front: the stack's geometry and the front's face both start over from the new source.
    render("/api/attachments/fresh/content");
    [pictures] = tiles();
    expect(pictures.querySelector('[data-artifact-sheet="icon"]')).toBeNull();
    expect(pictures.querySelector("[data-artifact-print] img")?.getAttribute("src")).toBe("/api/attachments/fresh/content");
    expect(placement(pictures.querySelector<HTMLElement>("[data-artifact-print]"))).toEqual(printed);
  });

  it("shows the icon sheet without a play disc for a video whose stream cannot be loaded", () => {
    act(() =>
      root.render(
        <MemoryRouter>
          <ArtifactTileGrid>
            <ArtifactSingleTile subject={testSubject({ kind: "video", filename: "reel.webm", videoUrl: "/api/files/gone.webm" })} now={NOW} />
          </ArtifactTileGrid>
        </MemoryRouter>,
      ),
    );
    expect(container.querySelector("[data-artifact-print] .lucide-play")).not.toBeNull();
    act(() => { container.querySelector("[data-artifact-print] video")!.dispatchEvent(new Event("error")); });
    expect(container.querySelector("[data-artifact-print]")).toBeNull();
    const sheet = container.querySelector('[data-artifact-sheet="icon"]');
    expect(sheet?.textContent).toContain("WEBM");
    expect(sheet?.querySelector(".lucide-film")).not.toBeNull();
    expect(sheet?.querySelector(".lucide-play")).toBeNull();
  });
});
