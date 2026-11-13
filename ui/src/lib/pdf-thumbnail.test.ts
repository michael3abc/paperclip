// @vitest-environment jsdom

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const pdfjs = vi.hoisted(() => {
  const render = vi.fn(() => ({ promise: Promise.resolve() }));
  const getPage = vi.fn(async () => ({
    getViewport: ({ scale }: { scale: number }) => ({ width: 600 * scale, height: 800 * scale }),
    render,
  }));
  const destroy = vi.fn(async () => undefined);
  const getDocument = vi.fn(() => ({ promise: Promise.resolve({ getPage }), destroy }));
  return { render, getPage, destroy, getDocument, GlobalWorkerOptions: { workerSrc: "" } };
});
vi.mock("pdfjs-dist", () => pdfjs);
vi.mock("pdfjs-dist/build/pdf.worker.min.mjs?url", () => ({ default: "/assets/pdf.worker.js" }));

import { clearPdfThumbnailCache, loadPdfThumbnail } from "./pdf-thumbnail";

const pdfResponse = () => new Response("%PDF-1.7\n", { headers: { "content-type": "application/pdf" } });
const input = (id: string) => ({ href: `/api/attachments/${id}/content`, filename: `${id}.pdf`, contentType: "application/pdf" });

describe("loadPdfThumbnail", () => {
  beforeEach(() => {
    clearPdfThumbnailCache();
    vi.clearAllMocks();
    vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockReturnValue({ fillRect: vi.fn(), fillStyle: "" } as unknown as CanvasRenderingContext2D);
    vi.spyOn(HTMLCanvasElement.prototype, "toDataURL").mockReturnValue("data:image/jpeg;base64,AAAA");
    vi.stubGlobal("fetch", vi.fn(async () => pdfResponse()));
  });
  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it("draws only the first page, scaled to the thumbnail width, and returns its ratio", async () => {
    const thumbnail = await loadPdfThumbnail(input("a"));
    expect(thumbnail).toEqual({ url: "data:image/jpeg;base64,AAAA", aspect: 0.75 });
    expect(pdfjs.getPage).toHaveBeenCalledWith(1);
    expect(pdfjs.GlobalWorkerOptions.workerSrc).toBe("/assets/pdf.worker.js");
    expect(pdfjs.getDocument).toHaveBeenCalledWith(expect.objectContaining({ enableXfa: false }));
    const canvas = (pdfjs.render.mock.calls[0] as unknown as [{ canvas: HTMLCanvasElement }])[0].canvas;
    expect(canvas.width).toBe(480);
    expect(canvas.height).toBe(640);
    expect(pdfjs.destroy).toHaveBeenCalled();
  });

  it("reads each PDF once and reuses the result", async () => {
    await Promise.all([loadPdfThumbnail(input("b")), loadPdfThumbnail(input("b"))]);
    await loadPdfThumbnail(input("b"));
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it("refuses anything but the authenticated file routes without fetching", async () => {
    await expect(loadPdfThumbnail({ href: "https://elsewhere.example/x.pdf", filename: "x.pdf", contentType: "application/pdf" })).rejects.toThrow();
    await expect(loadPdfThumbnail({ href: "/api/attachments/a/content", filename: "a.png", contentType: "image/png" })).rejects.toThrow();
    expect(fetch).not.toHaveBeenCalled();
  });

  it("rejects a response that is not a PDF, and lets a later mount retry", async () => {
    vi.mocked(fetch).mockResolvedValueOnce(new Response("<html>", { status: 200, headers: { "content-type": "text/html" } }));
    await expect(loadPdfThumbnail(input("c"))).rejects.toThrow("not a PDF");
    await expect(loadPdfThumbnail(input("c"))).resolves.toMatchObject({ aspect: 0.75 });
    expect(fetch).toHaveBeenCalledTimes(2);
  });

  it("renders at most two PDFs at a time", async () => {
    let active = 0;
    let peak = 0;
    pdfjs.getPage.mockImplementation(async () => {
      active += 1;
      peak = Math.max(peak, active);
      await new Promise((resolve) => setTimeout(resolve, 5));
      active -= 1;
      return { getViewport: ({ scale }: { scale: number }) => ({ width: 600 * scale, height: 800 * scale }), render: pdfjs.render };
    });
    await Promise.all(["d", "e", "f", "g"].map((id) => loadPdfThumbnail(input(id))));
    expect(peak).toBe(2);
  });
});
