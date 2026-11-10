import type { ReactNode } from "react";
import type { To } from "react-router-dom";
import { Link } from "@/lib/router";
import type { ArtifactFileLink } from "@/lib/artifact-file-link";
import { useArtifactPreviewClick } from "../ArtifactPreviewProvider";
import { ArtifactFront } from "./ArtifactFront";
import { ArtifactStack } from "./ArtifactStack";
import type { ArtifactSubject } from "./kinds";
import { countLabel, updatedLabel } from "./when";

/**
 * One cell of the Artifacts page grid: a 254px frame holding the artifact or
 * stack, then the caption — title, the task's identifier in a pill, and a
 * line of facts. From the mock: 20px side margins, 20px between frame and
 * caption, 12px between the title and the pill row. The artwork stands on
 * the frame's bottom edge, so the space from artwork to title is the same in
 * every cell. The cell is a fixed 370px tall whether the title takes one line
 * or two (its most before truncating), so the hover fill is the same size in
 * every cell. The pill is Paper Mono regular with 12px of side padding.
 */
export function ArtifactCaption({ title, identifier, facts }: { title: string; identifier?: string | null; facts: string[] }) {
  return (
    <div className="flex w-full flex-col items-center gap-3">
      <p className="line-clamp-2 w-full break-words text-center text-base font-medium leading-5 text-foreground" title={title}>
        {title}
      </p>
      <div className="flex items-center justify-center gap-2">
        {identifier ? (
          <span data-artifact-pill className="artifact-pill rounded-full px-3 py-1 text-xs font-normal leading-4 transition-colors">
            {identifier}
          </span>
        ) : null}
        <span className="flex items-center gap-1 text-xs leading-4 text-muted-foreground">
          {facts.map((fact, i) => (
            <span key={fact} className="whitespace-nowrap">
              {i > 0 ? <span className="mr-1">·</span> : null}
              {fact}
            </span>
          ))}
        </span>
      </div>
    </div>
  );
}

const TILE =
  "artifact-tile flex h-(--artifact-tile-h) w-full flex-col items-center gap-5 rounded-(--artifact-tile-radius) px-5 text-left outline-none transition-colors hover:bg-(--artifact-tile-hover) focus-visible:bg-(--artifact-tile-hover) focus-visible:ring-2 focus-visible:ring-ring";

/**
 * The cell: the stored file when it has one (shown in the preview window; a
 * modifier click opens it in a new tab), else a link when it has somewhere to
 * go, a button otherwise. text-left keeps a sheet's title from centring.
 */
export function ArtifactTile({ label, to, file, onClick, children, caption, testId }: { label: string; to?: To; file?: ArtifactFileLink | null; onClick?: () => void; children: ReactNode; caption: ReactNode; testId?: string }) {
  const onFileClick = useArtifactPreviewClick();
  const body = (
    <>
      <div className="flex h-(--artifact-frame-h) w-full shrink-0 items-end justify-center">{children}</div>
      {caption}
    </>
  );
  return (
    <li className="min-w-0">
      {file ? (
        // design-allow(card-pattern): file <a> cell, as the navigation cell below; Card renders a div and would break anchor semantics.
        <a
          href={file.href}
          target="_blank"
          rel="noreferrer"
          aria-label={label}
          data-testid={testId}
          className={TILE}
          onClick={(event) => onFileClick(event, file)}
        >
          {body}
        </a>
      ) : to ? (
        // design-allow(card-pattern): navigation <Link> cell, as ArtifactGroupCard; Card renders a div and would break anchor semantics.
        <Link to={to} aria-label={label} data-testid={testId} className={TILE}>
          {body}
        </Link>
      ) : (
        <button type="button" aria-label={label} onClick={onClick} data-testid={testId} className={TILE}>
          {body}
        </button>
      )}
    </li>
  );
}

export interface StackTileProps {
  /** The task identifier pill; a project folder has none. */
  identifier?: string | null;
  title: string;
  count: number;
  updatedAt: string;
  /** The newest artifact, shown as the first page. */
  front: ArtifactSubject;
  to?: To;
  onClick?: () => void;
  now?: Date;
  testId?: string;
}

/** A task (or project folder) with several artifacts: its newest one on top of a stack, the title underneath. */
export function ArtifactStackTile({ identifier, title, count, updatedAt, front, to, onClick, now, testId = "artifact-v1-stack-tile" }: StackTileProps) {
  return (
    <ArtifactTile label={`Open ${identifier ? `${identifier} ` : ""}${title}, ${countLabel(count)}`} to={to} onClick={onClick} testId={testId} caption={<ArtifactCaption title={title} identifier={identifier} facts={[countLabel(count), `Updated ${updatedLabel(updatedAt, now)}`]} />}>
      <ArtifactStack front={front} />
    </ArtifactTile>
  );
}

/** One artifact on its own: its file name (or title) underneath. */
export function ArtifactSingleTile({ subject, to, file, onClick, now }: { subject: ArtifactSubject; to?: To; file?: ArtifactFileLink | null; onClick?: () => void; now?: Date }) {
  const name = subject.filename ?? subject.title;
  return (
    <ArtifactTile label={`Open ${name}`} to={to} file={file} onClick={onClick} testId="artifact-v1-single-tile" caption={<ArtifactCaption title={name} identifier={subject.taskIdentifier} facts={subject.updatedAt ? [`Updated ${updatedLabel(subject.updatedAt, now)}`] : []} />}>
      <ArtifactFront subject={subject} />
    </ArtifactTile>
  );
}

/** The grid: cells 28px apart in both directions, columns at least 330px wide. */
export function ArtifactTileGrid({ children, testId = "artifact-v1-grid" }: { children: ReactNode; testId?: string }) {
  return (
    <ul data-testid={testId} className="grid gap-7 grid-cols-(--artifact-grid)">
      {children}
    </ul>
  );
}
