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

const SIMPLIFIED_TO_TRADITIONAL: Record<string, string> = { 确: "確", 认: "認", 发: "發", 达: "達", 递: "遞", 这: "這", 个: "個", 请: "請", 帮: "幫", 查: "查", 问: "問", 题: "題", 务: "務", 们: "們", 时: "時", 么: "麼", 说: "說", 话: "話", 对: "對", 没: "沒", 谢: "謝", 吗: "嗎", 败: "敗", 态: "態", 状: "狀", 结: "結", 果: "果", 开: "開", 关: "關", 设: "設", 处: "處", 理: "理", 还: "還", 会: "會", 后: "後", 让: "讓", 给: "給", 应: "應", 该: "該", 现: "現", 进: "進", 动: "動", 实: "實", 测: "測", 试: "試", 部: "部", 署: "署" };
/** Normalize a transcription for phrase matching: traditional forms, no spaces or punctuation. */
export function normalizeTranscript(text: string) {
  return Array.from(text.normalize("NFKC"))
    .map((char) => SIMPLIFIED_TO_TRADITIONAL[char] ?? char)
    .join("")
    .replace(/[\s\p{P}\p{S}]/gu, "");
}

/** Words a caller may put around the phrase, e.g. 「好，確認送出」 or 「確認送出吧」. */
const CONFIRMATION_PREFIXES = ["", "好", "好的", "對", "嗯", "是", "是的", "沒問題", "ok", "okay", "可以"];
const CONFIRMATION_SUFFIXES = ["", "吧", "喔", "哦", "了", "謝謝", "謝謝你"];

/**
 * True only when one caller utterance is the confirmation phrase itself, with
 * at most a short acknowledgement before or after it. Questions, refusals and
 * longer sentences that merely contain the phrase (「請說確認送出」,
 * 「我不想確認送出」, 「確認送出嗎」) do not confirm.
 */
export function isConfirmationUtterance(utterance: string, phrase: string) {
  const needle = normalizeTranscript(phrase);
  const text = normalizeTranscript(utterance).toLowerCase();
  if (!needle) return false;
  for (let index = text.indexOf(needle); index >= 0; index = text.indexOf(needle, index + 1)) {
    if (CONFIRMATION_PREFIXES.includes(text.slice(0, index)) && CONFIRMATION_SUFFIXES.includes(text.slice(index + needle.length))) return true;
  }
  return false;
}

/** Share of the draft's character bigrams present in what the model said (0..1). */
export function recitationCoverage(draft: string, spoken: string) {
  const bigrams = (value: string) => {
    const chars = Array.from(normalizeTranscript(value).toLowerCase());
    const result: string[] = [];
    for (let index = 0; index + 1 < chars.length; index += 1) result.push(chars[index]! + chars[index + 1]!);
    return result;
  };
  const wanted = bigrams(draft);
  if (wanted.length === 0) return normalizeTranscript(spoken).includes(normalizeTranscript(draft)) ? 1 : 0;
  const heard = new Set(bigrams(spoken));
  return wanted.filter((gram) => heard.has(gram)).length / wanted.length;
}
