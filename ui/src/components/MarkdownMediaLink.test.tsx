// @vitest-environment jsdom

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { MemoryRouter } from "react-router-dom";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ThemeProvider } from "@/context/ThemeContext";
import { MarkdownBody } from "./MarkdownBody";
import { ArtifactPreviewProvider, mediaLinkPath } from "./artifacts/ArtifactPreviewProvider";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
const path = "/api/attachments/img-1/content";
const fetchMock = vi.fn();
const tick = () => new Promise(resolve => setTimeout(resolve, 0));

describe("Markdown attachment links open the preview window", () => {
  let container: HTMLDivElement, root: Root;
  beforeEach(() => {
    vi.stubGlobal("fetch", fetchMock);
    vi.stubGlobal("ResizeObserver", class { observe() {} unobserve() {} disconnect() {} });
    container = document.createElement("div");
    document.body.append(container);
    root = createRoot(container);
    act(() => root.render(
      <QueryClientProvider client={new QueryClient()}><ThemeProvider><MemoryRouter><ArtifactPreviewProvider>
        <MarkdownBody>{`[sheet](${path}) [other](/api/attachments/doc-1/content)`}</MarkdownBody>
      </ArtifactPreviewProvider></MemoryRouter></ThemeProvider></QueryClientProvider>,
    ));
  });
  afterEach(() => { act(() => root.unmount()); container.remove(); fetchMock.mockReset(); vi.unstubAllGlobals(); });
  const click = async (label: string, init: MouseEventInit = {}) => {
    const link = [...container.querySelectorAll("a")].find(a => a.textContent?.includes(label))!;
    const event = new MouseEvent("click", { bubbles: true, cancelable: true, button: 0, ...init });
    await act(async () => { link.dispatchEvent(event); await tick(); });
    return event;
  };

  it("opens an image attachment in the preview window", async () => {
    fetchMock.mockResolvedValue(new Response("png", { headers: { "content-type": "image/png" } }));
    const event = await click("sheet");
    expect(event.defaultPrevented).toBe(true);
    expect(fetchMock).toHaveBeenCalledWith(path, expect.objectContaining({ credentials: "same-origin", redirect: "error" }));
    expect(document.querySelector("[data-testid=artifact-preview-image]")).not.toBeNull();
  });

  it("leaves modifier clicks to the browser without a lookup", async () => {
    const event = await click("sheet", { ctrlKey: true });
    expect(event.defaultPrevented).toBe(false);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("does not preview a non-media attachment", async () => {
    fetchMock.mockResolvedValue(new Response("<html>", { headers: { "content-type": "text/html" } }));
    await click("other");
    expect(document.querySelector("[data-testid=artifact-preview]")).toBeNull();
  });

  it("only accepts same-origin attachment content paths", () => {
    expect(mediaLinkPath(path, "http://x.test")).toBe(path);
    expect(mediaLinkPath("http://evil.test" + path, "http://x.test")).toBeNull();
    expect(mediaLinkPath(path + "?download=1", "http://x.test")).toBeNull();
    expect(mediaLinkPath("/api/issues/1", "http://x.test")).toBeNull();
  });
});
