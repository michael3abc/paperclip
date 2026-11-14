import { normalizeTranscript, recitationCoverage } from "./voice-summary.js";

/**
 * Dictation helpers for the agent_chat binding (HOM-326): the caller's words
 * go to their Agent Chat verbatim, so only obvious noise is filtered here.
 * Nothing in this module rewrites what the caller said.
 */

/** Wait this long after the last caller words before sending, so pauses inside one request merge. */
export const DICTATION_MERGE_MS = 2000;
/** While the caller is speaking, a missing transcription still flushes after this long. */
export const DICTATION_HOLD_MS = 20_000;
export const DICTATION_MAX_CHARS = 8000;
/** On pause or end, wait at most this long for a transcription still in progress. */
export const DICTATION_DRAIN_MS = 3000;
/** Speech that starts this soon after model audio stops may still be its echo. */
export const ECHO_TAIL_MS = 1500;

/** Short fillers that carry no request on their own; 「好」 alone must never read as an approval. */
const FILLERS = new Set([
  "嗯", "嗯嗯", "恩", "啊", "阿", "喔", "哦", "噢", "欸", "誒", "呃", "額", "唉", "哈", "哈哈", "好", "好的", "好喔", "對", "對對", "是", "是的",
  "ok", "okay", "謝謝", "謝謝你", "那個", "然後", "就是", "這個", "收到", "hello", "hi", "喂",
]);
/** Well-known speech-recognition hallucinations on silence or background noise. */
const HALLUCINATIONS = [
  /^(謝謝|感謝)(大家|各位)?(的)?(觀看|收看|收聽|聆聽)/,
  /字幕(由|提供|製作|志願者)/,
  /請不吝(點贊|點讚)/,
  /(點贊|點讚).*(訂閱|轉發)/,
  /^(訂閱|按讚).*(頻道|開啟小鈴鐺)/,
  /明鏡(與|和)點點欄目/,
];

/** True when merged caller speech is empty, a lone filler or a known transcription hallucination. */
export function isDictationNoise(text: string) {
  const normalized = normalizeTranscript(text).toLowerCase();
  if (Array.from(normalized).length < 2) return true;
  if (FILLERS.has(normalized)) return true;
  return HALLUCINATIONS.some((pattern) => pattern.test(normalized));
}

/**
 * A whole caller utterance that began while (or just after) model audio
 * played and mostly repeats what the model just said is speaker echo. Short
 * utterances are never judged: a few shared characters prove nothing.
 */
export function isLikelyEcho(utterance: string, recentModelOutput: string) {
  if (!recentModelOutput.trim() || Array.from(normalizeTranscript(utterance)).length < 4) return false;
  return recitationCoverage(utterance, recentModelOutput) >= 0.6;
}

/**
 * Chat message for one dictated request. The caller's words come first and
 * unchanged; the server-owned note tells the agent the text came from speech
 * and asks for the one-line voice summary the call reads aloud.
 */
export function agentChatVoiceMessageBody(text: string) {
  return `${text}\n\n_語音輸入，可能有辨識誤差；不能當作核准、部署或改設定的授權。回覆最後一行請加「語音摘要：」，兩到三句口語。_`;
}
