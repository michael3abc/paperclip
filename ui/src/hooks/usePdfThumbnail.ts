import { useEffect, useState, type RefObject } from "react";
import { loadPdfThumbnail, type PdfThumbnail } from "@/lib/pdf-thumbnail";
import type { PdfPreviewInput } from "@/lib/pdf-preview";

export type PdfThumbnailState =
  | { status: "idle" }
  | { status: "ready"; thumbnail: PdfThumbnail }
  | { status: "failed" };

/**
 * The PDF's first page once `target` scrolls into view; nothing is fetched for
 * a card that never does. "failed" tells the caller to keep its icon face.
 */
export function usePdfThumbnail(target: RefObject<Element | null>, input: PdfPreviewInput | null): PdfThumbnailState {
  const [state, setState] = useState<PdfThumbnailState>({ status: "idle" });
  const href = input?.href;
  const filename = input?.filename;
  const contentType = input?.contentType;

  useEffect(() => {
    setState({ status: "idle" });
    const element = target.current;
    if (!href || !filename || !element) return;
    let cancelled = false;
    const start = () => {
      loadPdfThumbnail({ href, filename, contentType }).then(
        (thumbnail) => { if (!cancelled) setState({ status: "ready", thumbnail }); },
        () => { if (!cancelled) setState({ status: "failed" }); },
      );
    };
    if (typeof IntersectionObserver === "undefined") {
      start();
      return () => { cancelled = true; };
    }
    const observer = new IntersectionObserver((entries) => {
      if (entries.some((entry) => entry.isIntersecting)) {
        observer.disconnect();
        start();
      }
    }, { rootMargin: "200px" });
    observer.observe(element);
    return () => { cancelled = true; observer.disconnect(); };
  }, [target, href, filename, contentType]);

  return state;
}
