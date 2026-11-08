import { describe, expect, it, vi } from "vitest";
import { isPlainPrimaryClick, pdfPreviewSource, PDF_PREVIEW_MAX_BYTES, readPdfPreview } from "./pdf-preview";

const origin = "https://board.example";
const input = { href: "/api/attachments/file-1/content?inline=1", filename: "report.PDF" };
const response = (body = "%PDF-1.7\n", headers = {}, status = 200) => new Response(body, { status, headers: { "content-type": "application/pdf", ...headers } });

describe("PDF preview boundary", () => {
  it("accepts authenticated attachment/asset paths and drops presentation query and fragment", () => {
    expect(pdfPreviewSource(input, origin)?.href).toBe("/api/attachments/file-1/content");
    expect(pdfPreviewSource({ ...input, href: origin + "/api/assets/asset-1/content#page=2" }, origin)?.href).toBe("/api/assets/asset-1/content");
    expect(pdfPreviewSource({ ...input, filename: "Report", contentType: "Application/PDF; charset=binary" }, origin)).not.toBeNull();
  });

  it.each([
    "https://other.example/api/attachments/file-1/content",
    "https://user:pass@board.example/api/attachments/file-1/content",
    "/api/attachments/file-1/content?download=1",
    "/api/issues/file-1/content", "/api/attachments/file-1/content/extra", "javascript:alert(1)",
    " /api/attachments/file-1/content", "/api/attachments/file-1/content\n",
  ])("does not intercept %s", href => {
    expect(pdfPreviewSource({ ...input, href }, origin)).toBeNull();
  });

  it("leaves other file types untouched, even if mislabeled with a PDF filename", () => {
    expect(pdfPreviewSource({ ...input, contentType: "text/html" }, origin)).toBeNull();
    expect(pdfPreviewSource({ ...input, filename: "notes.md" }, origin)).toBeNull();
  });

  it("only intercepts unprevented primary clicks", () => {
    const event = { button: 0, defaultPrevented: false, metaKey: false, ctrlKey: false, shiftKey: false, altKey: false };
    expect(isPlainPrimaryClick(event)).toBe(true);
    for (const key of ["defaultPrevented", "metaKey", "ctrlKey", "shiftKey", "altKey"]) {
      expect(isPlainPrimaryClick({ ...event, [key]: true })).toBe(false);
    }
    expect(isPlainPrimaryClick({ ...event, button: 1 })).toBe(false);
  });

  it("normalizes MIME and produces a PDF blob, including named binary PDFs", async () => {
    for (const type of ["Application/PDF; charset=binary", "application/octet-stream"]) {
      const blob = await readPdfPreview(response("prefix\n%PDF-1.7", { "content-type": type }), "report.pdf");
      expect(blob.type).toBe("application/pdf");
      expect(await blob.text()).toContain("%PDF-");
    }
  });

  it.each([401, 403, 404, 500, 206, 302])("rejects HTTP %s, including partial/redirect responses", async status => {
    await expect(readPdfPreview(response("%PDF-1.7", {}, status), "report.pdf")).rejects.toThrow();
  });

  it("rejects HTML, untyped binary and a missing/late PDF header", async () => {
    await expect(readPdfPreview(response("<html>login</html>", { "content-type": "text/html" }), "report.pdf")).rejects.toThrow("not a PDF");
    await expect(readPdfPreview(response("%PDF-1.7", { "content-type": "application/octet-stream" }), "Report")).rejects.toThrow("not a PDF");
    await expect(readPdfPreview(response("<html>error</html>"), "report.pdf")).rejects.toThrow("PDF header");
    await expect(readPdfPreview(response("x".repeat(1024) + "%PDF-1.7"), "report.pdf")).rejects.toThrow("PDF header");
  });

  it("bounds declared and actual size and cancels the stream on failure", async () => {
    const cancel = vi.fn();
    const declared = new Response(new ReadableStream({ cancel }), { headers: { "content-type": "application/pdf", "content-length": String(PDF_PREVIEW_MAX_BYTES + 1) } });
    await expect(readPdfPreview(declared, "report.pdf")).rejects.toThrow("too large");
    expect(cancel).toHaveBeenCalledOnce();
    const chunk = new Uint8Array(1024 * 1024);
    const cancelActual = vi.fn();
    const streamed = new Response(new ReadableStream({ pull(c) { c.enqueue(chunk); }, cancel: cancelActual }), { headers: { "content-type": "application/pdf", "content-length": "1" } });
    await expect(readPdfPreview(streamed, "report.pdf")).rejects.toThrow("too large");
    expect(cancelActual).toHaveBeenCalledOnce();
  });

  it("surfaces stream errors and releases its reader", async () => {
    const stream = new ReadableStream({ start(c) { c.error(new Error("connection lost")); } });
    await expect(readPdfPreview(new Response(stream, { headers: { "content-type": "application/pdf" } }), "report.pdf")).rejects.toThrow("connection lost");
    expect(stream.locked).toBe(false);
  });
});
