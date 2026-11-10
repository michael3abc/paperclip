import { createContext, useCallback, useContext, useEffect, useRef, useState, type MouseEvent, type ReactNode } from "react";
import { useLocation } from "react-router-dom";
import { ArrowLeft, Download, ExternalLink } from "lucide-react";
import { Dialog, DialogContent, DialogTitle } from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { isPlainPrimaryClick, pdfPreviewSource, readPdfPreview, type PdfPreviewInput } from "@/lib/pdf-preview";

type OpenPdf = (input: PdfPreviewInput) => boolean;
const PdfPreviewContext = createContext<OpenPdf | null>(null);
export const usePdfPreview = () => useContext(PdfPreviewContext);

/** Preserve native link actions and callers' existing text/media handlers. */
export function usePdfLink() {
  const open = usePdfPreview();
  return useCallback((event: MouseEvent, input: PdfPreviewInput) => {
    if (!isPlainPrimaryClick(event) || !open?.(input)) return false;
    event.preventDefault();
    return true;
  }, [open]);
}

export function PdfContent({ source }: { source: PdfPreviewInput }) {
  const [attempt, setAttempt] = useState(0);
  const [result, setResult] = useState<{ url?: string; error?: string }>({});
  useEffect(() => {
    const controller = new AbortController();
    let url: string | undefined;
    setResult({});
    void (async () => {
      try {
        const response = await fetch(source.href, { credentials: "same-origin", redirect: "error", signal: controller.signal });
        const blob = await readPdfPreview(response, source.filename);
        if (controller.signal.aborted) return;
        url = URL.createObjectURL(blob);
        setResult({ url });
      } catch (error) {
        if (!controller.signal.aborted) setResult({ error: error instanceof Error ? error.message : "Could not load the PDF." });
      }
    })();
    return () => { controller.abort(); if (url) URL.revokeObjectURL(url); };
  }, [source.href, source.filename, attempt]);
  if (result.error) return <div className="space-y-3 p-4" role="alert"><p>{result.error}</p><Button variant="outline" onClick={() => setAttempt(value => value + 1)}>Retry preview</Button></div>;
  if (!result.url) return <p className="p-4 text-sm" role="status">Loading PDF…</p>;
  // Native PDF viewers cannot run in a sandboxed iframe. Only validated PDF blobs enter here.
  return <iframe src={result.url} title={source.filename + " PDF preview"} className="min-h-0 w-full flex-1 border-0" />;
}

/** Local modal state leaves task history, deep-link state and scroll untouched. */
export function PdfPreviewProvider({ children }: { children: ReactNode }) {
  const location = useLocation();
  const [preview, setPreview] = useState<{ source: PdfPreviewInput; locationKey: string } | null>(null);
  const returnFocus = useRef<HTMLElement | null>(null);
  const open = useCallback<OpenPdf>((input) => {
    const source = pdfPreviewSource(input);
    if (!source) return false;
    returnFocus.current = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    setPreview({ source, locationKey: location.key });
    return true;
  }, [location.key]);
  useEffect(() => { setPreview(null); }, [location.key]);
  const source = preview?.locationKey === location.key ? preview.source : null;
  return <PdfPreviewContext.Provider value={open}>
    {children}
    <Dialog open={Boolean(source)} onOpenChange={value => { if (!value) setPreview(null); }}>
      <DialogContent showCloseButton={false} aria-describedby={undefined}
        className="inset-0 top-0 left-0 flex h-dvh w-full max-w-none translate-x-0 translate-y-0 flex-col gap-0 rounded-none border-0 p-0 pt-(--sz-safe-top) pb-(--sz-safe-bottom) sm:max-w-none md:top-0 md:translate-y-0"
        onCloseAutoFocus={event => { event.preventDefault(); if (returnFocus.current?.isConnected) returnFocus.current.focus({ preventScroll: true }); }}>
        <header className="flex shrink-0 items-center gap-2 border-b border-border p-3">
          <Button variant="ghost" onClick={() => setPreview(null)}><ArrowLeft aria-hidden />Back</Button>
          <DialogTitle className="min-w-0 flex-1 truncate text-sm" title={source?.filename}> {source?.filename ?? "PDF preview"}</DialogTitle>
          {source && <>
            <Button asChild variant="ghost" size="icon-sm"><a href={source.href} target="_blank" rel="noreferrer" aria-label="Open original PDF" title="Open original PDF"><ExternalLink aria-hidden /></a></Button>
            <Button asChild variant="ghost" size="icon-sm"><a href={source.href + "?download=1"} download={source.filename} aria-label="Download PDF" title="Download PDF"><Download aria-hidden /></a></Button>
          </>}
        </header>
        {source && <PdfContent key={source.href} source={source} />}
      </DialogContent>
    </Dialog>
  </PdfPreviewContext.Provider>;
}
