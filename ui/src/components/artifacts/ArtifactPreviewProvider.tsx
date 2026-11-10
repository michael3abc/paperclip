import { createContext, useCallback, useContext, useEffect, useRef, useState, type MouseEvent, type ReactNode } from "react";
import { useLocation } from "react-router-dom";
import { Download, ExternalLink, FileText, MessageSquare } from "lucide-react";
import { Dialog, DialogContent, DialogTitle } from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { PdfContent, usePdfLink } from "@/components/PdfPreviewProvider";
import type { ArtifactFileLink } from "@/lib/artifact-file-link";
import { isPlainPrimaryClick, pdfPreviewSource } from "@/lib/pdf-preview";
import { Link } from "@/lib/router";

/** One artifact file shown in the preview window, with its task one click away. */
export interface ArtifactPreviewInput extends ArtifactFileLink {
  /** The in-app task (session) page; the window links back to it. */
  taskHref?: string | null;
  taskLabel?: string | null;
  downloadHref?: string | null;
}

type PreviewKind = "image" | "video" | "audio" | "pdf" | "other";

const IMAGE_EXT = /\.(png|jpe?g|gif|webp|avif|bmp|svg|heic|heif|tiff?)$/i;
const VIDEO_EXT = /\.(mp4|m4v|mov|webm|mkv|avi)$/i;
const AUDIO_EXT = /\.(mp3|wav|m4a|aac|flac|ogg|oga|opus|aiff?)$/i;

export function previewKind(input: Pick<ArtifactFileLink, "href" | "filename" | "contentType">): PreviewKind {
  if (pdfPreviewSource(input)) return "pdf";
  const type = input.contentType?.split(";")[0].trim().toLowerCase() ?? "";
  const generic = !type || type === "application/octet-stream" || type === "binary/octet-stream";
  if (type.startsWith("image/") || (generic && IMAGE_EXT.test(input.filename))) return "image";
  if (type.startsWith("video/") || (generic && VIDEO_EXT.test(input.filename))) return "video";
  if (type.startsWith("audio/") || (generic && AUDIO_EXT.test(input.filename))) return "audio";
  return "other";
}

type OpenPreview = (input: ArtifactPreviewInput) => void;
const ArtifactPreviewContext = createContext<OpenPreview | null>(null);

/**
 * The click handler for an artifact file link: a plain click shows the file in
 * the preview window; modifier clicks keep the link's native new-tab behaviour.
 * Without a preview window, a PDF falls back to the full PDF viewer and other
 * files to the link's new tab.
 */
export function useArtifactPreviewClick() {
  const open = useContext(ArtifactPreviewContext);
  const onPdfClick = usePdfLink();
  return useCallback((event: MouseEvent, input: ArtifactPreviewInput) => {
    if (!open) { onPdfClick(event, input); return; }
    if (!isPlainPrimaryClick(event)) return;
    event.preventDefault();
    open(input);
  }, [open, onPdfClick]);
}

function PreviewBody({ input }: { input: ArtifactPreviewInput }) {
  const kind = previewKind(input);
  if (kind === "image") {
    return <img src={input.href} alt={input.filename} className="mx-auto max-h-(--sz-70vh) w-auto max-w-full rounded-md object-contain" data-testid="artifact-preview-image" />;
  }
  if (kind === "video") {
    return <video src={input.href} controls playsInline className="mx-auto max-h-(--sz-70vh) w-full rounded-md" data-testid="artifact-preview-video" />;
  }
  if (kind === "audio") {
    return <audio src={input.href} controls className="w-full" data-testid="artifact-preview-audio" />;
  }
  if (kind === "pdf") {
    // The shared viewer validates the authenticated PDF before embedding it.
    return <div className="flex h-(--sz-70vh) flex-col overflow-hidden rounded-md border border-border" data-testid="artifact-preview-pdf"><PdfContent source={input} /></div>;
  }
  return (
    <div className="flex flex-col items-center gap-3 py-10 text-center text-sm text-muted-foreground" data-testid="artifact-preview-unsupported">
      <FileText className="h-10 w-10" aria-hidden />
      <p>This file type cannot be previewed here.</p>
      <Button asChild variant="outline" size="sm">
        <a href={input.downloadHref ?? input.href} download={input.filename}><Download aria-hidden />Download</a>
      </Button>
    </div>
  );
}

/** A small, page-local window for artifact files; navigation closes it. */
export function ArtifactPreviewProvider({ children }: { children: ReactNode }) {
  const location = useLocation();
  const [preview, setPreview] = useState<{ input: ArtifactPreviewInput; locationKey: string } | null>(null);
  const returnFocus = useRef<HTMLElement | null>(null);
  const open = useCallback<OpenPreview>((input) => {
    returnFocus.current = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    setPreview({ input, locationKey: location.key });
  }, [location.key]);
  useEffect(() => { setPreview(null); }, [location.key]);
  const input = preview?.locationKey === location.key ? preview.input : null;
  return (
    <ArtifactPreviewContext.Provider value={open}>
      {children}
      <Dialog open={Boolean(input)} onOpenChange={(value) => { if (!value) setPreview(null); }}>
        <DialogContent
          aria-describedby={undefined}
          data-testid="artifact-preview"
          className="flex max-h-(--sz-88vh) flex-col gap-3 sm:max-w-3xl"
          onCloseAutoFocus={(event) => { event.preventDefault(); if (returnFocus.current?.isConnected) returnFocus.current.focus({ preventScroll: true }); }}
        >
          <div className="flex min-w-0 items-center gap-1 pr-8">
            <DialogTitle className="min-w-0 flex-1 truncate text-sm" title={input?.filename}>{input?.filename ?? "Preview"}</DialogTitle>
            {input?.taskHref ? (
              <Button asChild variant="ghost" size="icon-sm">
                <Link to={input.taskHref} disableIssueQuicklook aria-label={`Open ${input.taskLabel ?? "task"}`} title={`Open ${input.taskLabel ?? "task"}`}><MessageSquare aria-hidden /></Link>
              </Button>
            ) : null}
            {input ? (
              <>
                <Button asChild variant="ghost" size="icon-sm">
                  <a href={input.href} target="_blank" rel="noreferrer" aria-label="Open in new tab" title="Open in new tab"><ExternalLink aria-hidden /></a>
                </Button>
                <Button asChild variant="ghost" size="icon-sm">
                  <a href={input.downloadHref ?? input.href} download={input.filename} aria-label="Download" title="Download"><Download aria-hidden /></a>
                </Button>
              </>
            ) : null}
          </div>
          <div className="min-h-0 overflow-auto">{input ? <PreviewBody key={input.href} input={input} /> : null}</div>
        </DialogContent>
      </Dialog>
    </ArtifactPreviewContext.Provider>
  );
}
