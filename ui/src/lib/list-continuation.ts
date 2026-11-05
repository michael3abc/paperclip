/**
 * Markdown-style list continuation for plain `<textarea>` composers.
 *
 * Pure: given the text and a collapsed caret, decide what a "newline" keypress
 * should do on a list line. The composer owns key handling and applying the edit.
 */

export interface ListContinuationEdit {
  /** Replace `value.slice(from, to)` with `insert`. */
  from: number;
  to: number;
  insert: string;
  /** Caret position in the resulting value. */
  caret: number;
}

// `1. `, `1) `, `- `, `* `, `+ ` with optional leading indent. Horizontal indentation only,
// because a match is always confined to a single line.
const ORDERED_MARKER = /^([ \t]*)(\d{1,9})([.)])([ \t]+)/;
const BULLET_MARKER = /^([ \t]*)([-*+])([ \t]+)/;

/**
 * Returns the edit a newline keypress should apply at `caret`, or `null` when the caret is not
 * on a list item (the caller then keeps the browser's plain newline).
 *
 * - On an item with content: insert `\n` plus the next marker (`2. ` after `1. `, same bullet).
 *   Text after the caret moves to the new item.
 * - On an item with no content (`2. ` and nothing else): remove the marker to leave the list.
 * - Caret before or inside the marker: plain newline.
 */
export function continueListOnNewline(value: string, caret: number): ListContinuationEdit | null {
  if (caret < 0 || caret > value.length) return null;

  // `lastIndexOf` with a negative fromIndex still inspects index 0, so caret 0 is handled apart.
  const lineStart = caret === 0 ? 0 : value.lastIndexOf("\n", caret - 1) + 1;
  const newlineAfter = value.indexOf("\n", caret);
  const lineEnd = newlineAfter === -1 ? value.length : newlineAfter;
  const line = value.slice(lineStart, lineEnd);

  const ordered = ORDERED_MARKER.exec(line);
  const bullet = ordered ? null : BULLET_MARKER.exec(line);
  const match = ordered ?? bullet;
  if (!match) return null;

  const markerEnd = lineStart + match[0].length;
  if (caret < markerEnd) return null;

  const hasContent = value.slice(markerEnd, lineEnd).trim().length > 0;
  if (!hasContent) {
    return { from: lineStart, to: lineEnd, insert: "", caret: lineStart };
  }

  const nextMarker = ordered
    ? `${ordered[1]}${Number(ordered[2]) + 1}${ordered[3]}${ordered[4]}`
    : `${bullet![1]}${bullet![2]}${bullet![3]}`;
  const insert = `\n${nextMarker}`;
  return { from: caret, to: caret, insert, caret: caret + insert.length };
}
