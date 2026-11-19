import { useRef, type CSSProperties, type SyntheticEvent } from "react";
import { usePdfThumbnail } from "@/hooks/usePdfThumbnail";
import { pdfPreviewSource } from "@/lib/pdf-preview";
import { ArtifactPrint, usePreviewFailure, type PrintSize } from "./ArtifactPrint";
import { IconSheet, PreviewSheet } from "./ArtifactSheet";
import { previewSourceOf, treatmentOf, type ArtifactSubject } from "./kinds";

/**
 * The artifact's own representation: one of the mock's four treatments. A
 * print is sized by the caller (a stack fits it to its own box); on its own
 * it fits the single-artifact box. A picture that cannot be loaded gives
 * way to the icon sheet, the face a file without a preview gets, rather
 * than the browser's broken-picture glyph; the caller hears of it through
 * onMediaError so it can stand the sheet where sheets stand. The root
 * carries data-artifact-front so a hovered tile can lift it (index.css).
 */
export function ArtifactFront({
  subject,
  print,
  onMediaLoad,
  onMediaError,
  style,
}: {
  subject: ArtifactSubject;
  print?: PrintSize;
  onMediaLoad?: (event: SyntheticEvent<HTMLImageElement | HTMLVideoElement>) => void;
  onMediaError?: (event: SyntheticEvent<HTMLImageElement | HTMLVideoElement>) => void;
  style?: CSSProperties;
}) {
  const [failed, onOwnError] = usePreviewFailure(previewSourceOf(subject));
  switch (failed ? "icon" : treatmentOf(subject)) {
    case "preview":
      return (
        <div data-artifact-front className="shrink-0" style={style}>
          <PreviewSheet subject={subject} />
        </div>
      );
    case "media":
      return (
        <ArtifactPrint
          subject={subject}
          size={print}
          onMediaLoad={onMediaLoad}
          onMediaError={(event) => {
            onOwnError();
            onMediaError?.(event);
          }}
          style={style}
        />
      );
    case "media-fallback":
      return (
        <div data-artifact-front className="shrink-0" style={style}>
          <IconSheet subject={subject} play />
        </div>
      );
    default:
      return (
        <div data-artifact-front className="shrink-0" style={style}>
          <IconSheet subject={subject} />
        </div>
      );
  }
}

/**
 * A PDF on its own: its first page as a print once the tile nears the viewport,
 * the icon sheet before that and whenever the page cannot be drawn.
 */
export function PdfFront({ subject }: { subject: ArtifactSubject }) {
  const target = useRef<HTMLDivElement>(null);
  const source = subject.pdfUrl
    ? pdfPreviewSource({ href: subject.pdfUrl, filename: subject.filename ?? subject.title, contentType: subject.contentType })
    : null;
  const state = usePdfThumbnail(target, source);
  const page = state.status === "ready" ? state.thumbnail : null;
  return (
    <div ref={target} data-pdf-thumbnail={state.status} className="flex shrink-0 items-end justify-center">
      <ArtifactFront subject={page ? { ...subject, kind: "image", thumbnailUrl: page.url, aspect: page.aspect } : subject} />
    </div>
  );
}
