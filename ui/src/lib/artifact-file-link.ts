import type { CompanyArtifact } from "@paperclipai/shared";

/** A stored file an artifact click opens directly, in place of its task. */
export interface ArtifactFileLink {
  href: string;
  filename: string;
  contentType: string | null;
  downloadHref?: string | null;
  /** The artifact's task (session) page, kept one click away. */
  taskHref?: string | null;
  taskLabel?: string | null;
}

/**
 * The file behind an artifact: attachments and file-backed work products open
 * their own content route; documents and work products without a file keep
 * opening their task.
 */
export function artifactFileLink(
  artifact: Pick<CompanyArtifact, "source" | "title" | "contentType" | "openPath" | "contentPath"> &
    Partial<Pick<CompanyArtifact, "downloadPath" | "href" | "issue">>,
): ArtifactFileLink | null {
  if (artifact.source === "document") return null;
  const href = artifact.openPath ?? artifact.contentPath;
  if (!href) return null;
  return { href, filename: artifact.title, contentType: artifact.contentType,
    downloadHref: artifact.downloadPath ?? null, taskHref: artifact.href ?? null, taskLabel: artifact.issue?.identifier ?? null };
}
