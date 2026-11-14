/**
 * Voice-friendly projections of agent replies and the spoken confirmation
 * check for local voice (HOM-311).
 *
 * The main agent ends a voice-task reply with one line
 * `語音摘要：<two or three spoken sentences>` (or `voiceSummary: ...`, or the
 * HTML comment `<!-- voiceSummary: ... -->`). The relay speaks only that line;
 * the full comment stays in the text panel.
 */
const SUMMARY_LINE = /^\s*(?:[-*>]\s*)?(?:\*\*|__)?\s*(?:語音摘要|语音摘要|voice\s*summary|voiceSummary)\s*(?:\*\*|__)?\s*[:：]\s*(?:\*\*|__)?\s*(.+?)\s*$/i;
const SUMMARY_COMMENT = /<!--\s*voiceSummary\s*[:：]\s*([\s\S]+?)\s*-->/i;
const SPOKEN_LIMIT = 400;

export function extractVoiceSummary(body: string): string | null {
  const comment = SUMMARY_COMMENT.exec(body);
  if (comment?.[1]?.trim()) return clip(comment[1].trim(), SPOKEN_LIMIT);
  const lines = body.split(/\r?\n/);
  for (let index = lines.length - 1; index >= 0; index -= 1) {
    const match = SUMMARY_LINE.exec(lines[index]!);
    if (match?.[1]?.trim()) return clip(match[1].replace(/\*\*|__/g, "").trim(), SPOKEN_LIMIT);
  }
  return null;
}

/** Plain text for speaking a reply that has no voice summary: no code, tables or links. */
export function spokenFallback(body: string, limit = 600): string {
  const text = body
    .replace(/<!--[\s\S]*?-->/g, " ")
    .replace(/```[\s\S]*?```/g, " （程式碼略） ")
    .replace(/`([^`]*)`/g, "$1")
    .replace(/!\[[^\]]*\]\([^)]*\)/g, " ")
    .replace(/\[([^\]]+)\]\([^)]*\)/g, "$1")
    .split(/\r?\n/)
    .filter((line) => !/^\s*\|/.test(line) && !/^\s*[-=]{3,}\s*$/.test(line))
    .map((line) => line.replace(/^\s*(?:#{1,6}\s+|[-*+]\s+|\d+\.\s+|>\s*)/, "").replace(/\*\*|__/g, "").trim())
    .filter(Boolean)
    .join(" ")
    .replace(/\s+/g, " ")
    .trim();
  return clip(text, limit);
}

function clip(text: string, limit: number) {
  const chars = Array.from(text);
  return chars.length <= limit ? text : `${chars.slice(0, limit).join("")}…`;
}

const SIMPLIFIED_TO_TRADITIONAL: Record<string, string> = { 确: "確", 认: "認", 发: "發", 达: "達", 递: "遞" };
/** Normalize a transcription for phrase matching: traditional forms, no spaces or punctuation. */
export function normalizeTranscript(text: string) {
  return Array.from(text.normalize("NFKC"))
    .map((char) => SIMPLIFIED_TO_TRADITIONAL[char] ?? char)
    .join("")
    .replace(/[\s\p{P}\p{S}]/gu, "");
}

/** True only when the caller's own transcribed speech contains the exact confirmation phrase. */
export function containsConfirmationPhrase(transcript: string, phrase: string) {
  const needle = normalizeTranscript(phrase);
  const haystack = normalizeTranscript(transcript);
  if (!needle) return false;
  let found = false;
  for (let index = haystack.indexOf(needle); index >= 0; index = haystack.indexOf(needle, index + 1)) {
    // "不要確認送出", "別確認送出", "不確認送出", "先不確認送出" are refusals, not confirmations.
    if (/(?:不要|別|别|不|勿|不用)$/.test(haystack.slice(Math.max(0, index - 2), index))) return false;
    found = true;
  }
  return found;
}
