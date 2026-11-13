import { pdfPreviewSource, readPdfPreview, type PdfPreviewInput } from "@/lib/pdf-preview";

export interface PdfThumbnail {
  /** A JPEG data URL of the first page. */
  url: string;
  /** Page width / height. */
  aspect: number;
}

/** Wide enough for a retina card; the page is drawn once and kept as a small JPEG. */
const THUMBNAIL_WIDTH = 480;
const MAX_CONCURRENT = 2;
const MAX_CACHED = 64;

const cache = new Map<string, Promise<PdfThumbnail>>();
const waiting: Array<() => void> = [];
let running = 0;

/** pdf.js decodes on a worker but still costs memory, so a page of PDFs renders two at a time. */
async function inTurn<T>(task: () => Promise<T>): Promise<T> {
  if (running >= MAX_CONCURRENT) await new Promise<void>((resolve) => waiting.push(resolve));
  running += 1;
  try {
    return await task();
  } finally {
    running -= 1;
    waiting.shift()?.();
  }
}

let pdfjsModule: Promise<typeof import("pdfjs-dist")> | null = null;

/** pdf.js is large: it loads on the first thumbnail, once, and its worker with it. */
function loadPdfjs() {
  pdfjsModule ??= (async () => {
    const [pdfjs, worker] = await Promise.all([import("pdfjs-dist"), import("pdfjs-dist/build/pdf.worker.min.mjs?url")]);
    pdfjs.GlobalWorkerOptions.workerSrc = worker.default;
    return pdfjs;
  })();
  pdfjsModule.catch(() => { pdfjsModule = null; });
  return pdfjsModule;
}

async function render(source: PdfPreviewInput): Promise<PdfThumbnail> {
  // Same authenticated, size-bounded and header-checked read as the preview window.
  const response = await fetch(source.href, { credentials: "same-origin", redirect: "error" });
  const blob = await readPdfPreview(response, source.filename);
  const data = new Uint8Array(await blob.arrayBuffer());

  const pdfjs = await loadPdfjs();
  const task = pdfjs.getDocument({ data, enableXfa: false });
  try {
    const pdf = await task.promise;
    const page = await pdf.getPage(1);
    const base = page.getViewport({ scale: 1 });
    const viewport = page.getViewport({ scale: THUMBNAIL_WIDTH / base.width });
    const canvas = document.createElement("canvas");
    canvas.width = Math.ceil(viewport.width);
    canvas.height = Math.ceil(viewport.height);
    const canvasContext = canvas.getContext("2d");
    if (!canvasContext) throw new Error("Canvas is not available.");
    // A transparent page would print black as a JPEG.
    canvasContext.fillStyle = "#fff";
    canvasContext.fillRect(0, 0, canvas.width, canvas.height);
    await page.render({ canvas, canvasContext, viewport }).promise;
    return { url: canvas.toDataURL("image/jpeg", 0.82), aspect: base.width / base.height };
  } finally {
    await task.destroy();
  }
}

/**
 * The first page of an authenticated attachment/asset PDF as a small picture.
 * Only the routes the preview window accepts are fetched. Results are shared
 * by URL; a failure is dropped from the cache so a later mount may retry.
 */
export function loadPdfThumbnail(input: PdfPreviewInput): Promise<PdfThumbnail> {
  const source = pdfPreviewSource(input);
  if (!source) return Promise.reject(new Error("Not a previewable PDF."));
  const cached = cache.get(source.href);
  if (cached) return cached;
  const pending = inTurn(() => render(source));
  cache.set(source.href, pending);
  pending.catch(() => {
    if (cache.get(source.href) === pending) cache.delete(source.href);
  });
  if (cache.size > MAX_CACHED) cache.delete(cache.keys().next().value as string);
  return pending;
}

export function clearPdfThumbnailCache() {
  cache.clear();
}
