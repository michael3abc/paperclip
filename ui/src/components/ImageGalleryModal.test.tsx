// @vitest-environment jsdom

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ImageGalleryModal, type GalleryMediaItem } from "./ImageGalleryModal";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

async function flushReact() {
  await act(async () => {
    await Promise.resolve();
    await new Promise((resolve) => window.setTimeout(resolve, 0));
  });
}

function makeMediaItem(overrides: Partial<GalleryMediaItem> = {}): GalleryMediaItem {
  return {
    id: "media-1",
    contentPath: "/api/attachments/media-1/content",
    openPath: "/api/attachments/media-1/content",
    downloadPath: "/api/attachments/media-1/content?download=1",
    contentType: "image/png",
    originalFilename: "screenshot.png",
    ...overrides,
  };
}

describe("ImageGalleryModal", () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
    vi.stubGlobal("ResizeObserver", class {
      observe() {}
      unobserve() {}
      disconnect() {}
    });
  });

  afterEach(async () => {
    await act(async () => {
      root.unmount();
    });
    document.body.innerHTML = "";
    vi.unstubAllGlobals();
  });

  async function renderGallery(items = [makeMediaItem()], open = true, onOpenChange = vi.fn()) {
    await act(() => {
      root.render(<ImageGalleryModal items={items} initialIndex={0} open={open} onOpenChange={onOpenChange} />);
    });
    await flushReact();
    return onOpenChange;
  }

  function button(label: string) {
    const node = document.body.querySelector<HTMLButtonElement>(`button[aria-label="${label}"]`);
    expect(node).not.toBeNull();
    return node!;
  }

  function image() {
    const node = document.body.querySelector<HTMLImageElement>('img');
    expect(node).not.toBeNull();
    return node!;
  }

  function level() {
    return document.body.querySelector('[aria-label="Zoom level"]')?.textContent;
  }

  async function click(label: string) {
    await act(() => button(label).click());
  }

  async function key(value: string, options: KeyboardEventInit = {}) {
    await act(() => {
      window.dispatchEvent(new KeyboardEvent("keydown", { key: value, bubbles: true, ...options }));
    });
  }

  function measureImage() {
    const img = image();
    const viewport = img.parentElement!;
    Object.defineProperties(viewport, {
      clientWidth: { configurable: true, value: 400 },
      clientHeight: { configurable: true, value: 300 },
    });
    Object.defineProperties(img, {
      clientWidth: { configurable: true, value: 400 },
      clientHeight: { configurable: true, value: 300 },
    });
    viewport.getBoundingClientRect = () => new DOMRect(0, 0, 400, 300);
    const captured = new Set<number>();
    img.setPointerCapture = vi.fn((id: number) => { captured.add(id); });
    img.hasPointerCapture = (id: number) => captured.has(id);
    img.releasePointerCapture = vi.fn((id: number) => { captured.delete(id); });
    return { img, viewport };
  }

  async function pointer(img: HTMLImageElement, type: string, id: number, x: number, y: number) {
    // jsdom has no PointerEvent/capture implementation; retain real mouse coordinates
    // and event bubbling while supplying pointer identity explicitly.
    const event = new MouseEvent(type, { bubbles: true, button: 0, clientX: x, clientY: y });
    Object.defineProperties(event, {
      pointerId: { value: id },
      pointerType: { value: "touch" },
    });
    await act(() => { img.dispatchEvent(event); });
  }

  it("zooms with buttons, clamps to 100–500%, and fits the image again", async () => {
    const onOpenChange = await renderGallery();
    expect(level()).toBe("100%");
    expect(button("Zoom out").disabled).toBe(true);
    await click("Zoom in");
    expect(level()).toBe("125%");
    for (let i = 0; i < 12; i++) await click("Zoom in");
    expect(level()).toBe("500%");
    expect(button("Zoom in").disabled).toBe(true);
    await click("Zoom out");
    expect(level()).toBe("400%");
    await click("Fit image");
    expect(level()).toBe("100%");
    expect(image().style.transform).toBe("translate(0px, 0px) scale(1)");
    expect(onOpenChange).not.toHaveBeenCalled();
  });

  it("supports zoom shortcuts without intercepting browser modified shortcuts", async () => {
    await renderGallery();
    await key("+");
    expect(level()).toBe("125%");
    await key("-");
    expect(level()).toBe("100%");
    await key("=");
    expect(level()).toBe("125%");
    await key("0");
    expect(level()).toBe("100%");
    for (const modifier of ["ctrlKey", "metaKey", "altKey"]) {
      await key("+", { [modifier]: true });
    }
    expect(level()).toBe("100%");
  });

  it("zooms with the wheel around its position and prevents page scrolling", async () => {
    await renderGallery();
    const { img, viewport } = measureImage();
    const wheel = async (deltaY: number) => {
      const event = new WheelEvent("wheel", { bubbles: true, cancelable: true, deltaY, clientX: 300, clientY: 150 });
      await act(() => { viewport.dispatchEvent(event); });
      expect(event.defaultPrevented).toBe(true);
    };
    await wheel(-100);
    expect(level()).toBe("125%");
    expect(img.style.transform).toBe("translate(-25px, 0px) scale(1.25)");
    for (let i = 0; i < 12; i++) await wheel(-100);
    expect(level()).toBe("500%");
    for (let i = 0; i < 14; i++) await wheel(100);
    expect(level()).toBe("100%");
    expect(img.style.transform).toBe("translate(0px, 0px) scale(1)");
  });

  it("resets zoom when navigating to another image and closing/reopening", async () => {
    const items = [makeMediaItem(), makeMediaItem({ id: "second", contentPath: "/second.png", originalFilename: "second.png" })];
    await renderGallery(items);
    await click("Zoom in");
    await key("ArrowRight");
    expect(image().getAttribute("src")).toBe("/second.png");
    expect(level()).toBe("100%");
    await click("Zoom in");
    await key("ArrowLeft");
    expect(level()).toBe("100%");
    await click("Zoom in");
    await renderGallery(items, false);
    await renderGallery(items, true);
    expect(level()).toBe("100%");
  });

  it("pans within image bounds and a drag release over the curtain does not close", async () => {
    const onOpenChange = await renderGallery();
    const { img, viewport } = measureImage();
    await act(() => { img.dispatchEvent(new MouseEvent("dblclick", { bubbles: true, clientX: 200, clientY: 150 })); });
    expect(level()).toBe("200%");
    await pointer(img, "pointerdown", 1, 200, 150);
    await pointer(img, "pointermove", 1, 1000, 1000);
    expect(img.style.transform).toBe("translate(200px, 150px) scale(2)");
    await pointer(img, "pointermove", 1, -1000, -1000);
    expect(img.style.transform).toBe("translate(-200px, -150px) scale(2)");
    await pointer(img, "pointerup", 1, -1000, -1000);
    expect(img.releasePointerCapture).toHaveBeenCalledWith(1);
    await act(() => viewport.click());
    expect(onOpenChange).not.toHaveBeenCalled();
    // A separate, intentional curtain click still closes the gallery.
    await act(() => viewport.click());
    expect(onOpenChange).toHaveBeenCalledWith(false);
  });

  it("clears canceled pointers so later movement does not pan or pinch", async () => {
    await renderGallery();
    const { img } = measureImage();
    await click("Zoom in");
    await pointer(img, "pointerdown", 1, 100, 150);
    await pointer(img, "pointercancel", 1, 100, 150);
    await pointer(img, "pointermove", 1, 300, 150);
    expect(img.style.transform).toBe("translate(0px, 0px) scale(1.25)");
    expect(img.releasePointerCapture).toHaveBeenCalledWith(1);
    await pointer(img, "pointerdown", 2, 100, 150);
    await pointer(img, "pointermove", 2, 110, 150);
    expect(img.style.transform).toBe("translate(10px, 0px) scale(1.25)");
    await pointer(img, "pointerup", 2, 110, 150);
  });

  it("supports two-pointer pinch and double-click to fit", async () => {
    const onOpenChange = await renderGallery();
    const { img } = measureImage();
    await pointer(img, "pointerdown", 1, 100, 150);
    await pointer(img, "pointerdown", 2, 300, 150);
    await pointer(img, "pointermove", 2, 500, 150);
    expect(level()).toBe("200%");
    await pointer(img, "pointerup", 1, 100, 150);
    await pointer(img, "pointerup", 2, 500, 150);
    await act(() => { img.dispatchEvent(new MouseEvent("dblclick", { bubbles: true })); });
    expect(level()).toBe("100%");
    expect(img.style.transform).toBe("translate(0px, 0px) scale(1)");
    expect(onOpenChange).not.toHaveBeenCalled();
  });

  it("renders video media with a download link in the gallery", async () => {
    const video = makeMediaItem({
      id: "video-1",
      contentPath: "/api/attachments/video-1/content",
      downloadPath: "/api/attachments/video-1/content?download=1",
      contentType: "video/webm",
      originalFilename: "demo.webm",
    });

    await act(async () => {
      root.render(
        <ImageGalleryModal
          items={[video]}
          initialIndex={0}
          open
          onOpenChange={() => undefined}
        />,
      );
    });
    await flushReact();

    const renderedVideo = document.body.querySelector("video");
    expect(renderedVideo?.getAttribute("src")).toBe("/api/attachments/video-1/content");
    expect(renderedVideo?.getAttribute("controls")).not.toBeNull();
    expect(document.body.querySelector('[aria-label="Image zoom"]')).toBeNull();
    await key("+");
    expect(renderedVideo?.style.transform).toBe("");
    expect(
      document.body.querySelector('a[aria-label="Download demo.webm"]')?.getAttribute("href"),
    ).toBe("/api/attachments/video-1/content?download=1");
  });

  it("supports keyboard navigation and Escape close", async () => {
    const onOpenChange = vi.fn();
    const first = makeMediaItem({
      id: "first",
      contentPath: "/api/attachments/first/content",
      originalFilename: "first.png",
    });
    const second = makeMediaItem({
      id: "second",
      contentPath: "/api/attachments/second/content",
      originalFilename: "second.png",
    });

    await act(async () => {
      root.render(
        <ImageGalleryModal
          items={[first, second]}
          initialIndex={0}
          open
          onOpenChange={onOpenChange}
        />,
      );
    });
    await flushReact();

    expect(document.body.textContent).toContain("first.png");
    expect(document.body.textContent).toContain("1 / 2");

    await act(async () => {
      window.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowRight" }));
    });
    await flushReact();

    expect(document.body.textContent).toContain("second.png");
    expect(document.body.textContent).toContain("2 / 2");

    await act(async () => {
      window.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowLeft" }));
    });
    await flushReact();

    expect(document.body.textContent).toContain("first.png");
    expect(document.body.textContent).toContain("1 / 2");

    await act(async () => {
      document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    });

    expect(onOpenChange).toHaveBeenCalledWith(false);
  });

  it.each(["/images/original.png", undefined])("offers the original image separately from download with openPath %s", async (openPath) => {
    const item = makeMediaItem({ openPath });
    await act(async () => {
      root.render(<ImageGalleryModal items={[item]} initialIndex={0} open onOpenChange={() => undefined} />);
    });
    await flushReact();

    const original = document.body.querySelector<HTMLAnchorElement>('a[aria-label="Open original screenshot.png"]');
    expect(original?.getAttribute("href")).toBe(openPath ?? item.contentPath);
    expect(original?.target).toBe("_blank");
    expect(original?.rel).toContain("noopener");
    expect(document.body.querySelector('a[aria-label="Download screenshot.png"]')?.getAttribute("href")).toBe(item.downloadPath);
  });
});
