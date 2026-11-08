export interface PdfPreviewInput {
  href: string;
  filename: string;
  contentType?: string | null;
}

export const PDF_PREVIEW_MAX_BYTES = 32 * 1024 * 1024;

/** Only the existing authenticated file routes may enter the embedded viewer. */
export function pdfPreviewSource(input: PdfPreviewInput, origin = typeof window === "undefined" ? null : window.location.origin): PdfPreviewInput | null {
  if (!origin) return null;
  const type = input.contentType?.split(";")[0].trim().toLowerCase() ?? "";
  if (type !== "application/pdf" && !(["", "application/octet-stream"].includes(type) && /\.pdf$/i.test(input.filename.trim()))) return null;
  if (/[\u0000-\u0020\\]/.test(input.href)) return null;
  try {
    const url = new URL(input.href, origin);
    if (url.origin !== origin || url.username || url.password || url.searchParams.has("download")
      || !/^\/api\/(attachments|assets)\/[a-zA-Z0-9-]+\/content$/.test(url.pathname)) return null;
    return { href: url.pathname, filename: input.filename, contentType: type };
  } catch { return null; }
}

export function isPlainPrimaryClick(event: { button: number; defaultPrevented: boolean; metaKey: boolean; ctrlKey: boolean; shiftKey: boolean; altKey: boolean }) {
  return !event.defaultPrevented && event.button === 0 && !event.metaKey && !event.ctrlKey && !event.shiftKey && !event.altKey;
}

/** Bound actual bytes as well as metadata. Never embed an HTML error response. */
export async function readPdfPreview(response: Response, filename: string): Promise<Blob> {
  const reader = response.body?.getReader();
  try {
    if (response.status !== 200) throw new Error(
      response.status === 403 ? "You do not have access to this PDF."
        : response.status === 404 ? "This PDF is no longer available."
        : "Could not load the PDF (" + response.status + ").",
    );
    const type = response.headers.get("content-type")?.split(";")[0].trim().toLowerCase();
    if (type !== "application/pdf" && !(type === "application/octet-stream" && /\.pdf$/i.test(filename))) {
      throw new Error("The file response is not a PDF.");
    }
    const tooLarge = () => new Error("This PDF is too large to preview. Open the original or download it.");
    if (Number(response.headers.get("content-length")) > PDF_PREVIEW_MAX_BYTES) throw tooLarge();
    if (!reader) throw new Error("The PDF response is empty.");
    const chunks: Uint8Array<ArrayBuffer>[] = [];
    let bytes = 0;
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      bytes += value.byteLength;
      if (bytes > PDF_PREVIEW_MAX_BYTES) throw tooLarge();
      chunks.push(new Uint8Array(value));
    }
    const blob = new Blob(chunks, { type: "application/pdf" });
    if (!(await blob.slice(0, 1024).text()).includes("%PDF-")) throw new Error("The file does not contain a PDF header.");
    return blob;
  } finally {
    if (reader) { try { await reader.cancel(); } finally { reader.releaseLock(); } }
  }
}
