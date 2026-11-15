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
/** Routed agent_chat: the model forwards with this tool; the relay sends the caller's own words. */
export const SEND_TO_AGENT_TOOL = "send_to_agent";
/** Routed agent_chat: a forward takes the caller's undecided utterances from this far back; older small talk is not sent. */
export const FORWARD_WINDOW_MS = 90_000;
/** Speech that starts this soon after model audio stops may still be its echo. */
export const ECHO_TAIL_MS = 1500;

/** Short fillers that carry no request on their own; 「好」 alone must never read as an approval. */
const FILLERS = new Set([
  "嗯", "嗯嗯", "恩", "啊", "阿", "喔", "哦", "噢", "欸", "誒", "呃", "額", "唉", "哈", "哈哈", "好", "好的", "好喔", "對", "對對", "是", "是的",
  "ok", "okay", "謝謝", "謝謝你", "那個", "然後", "就是", "這個", "收到", "hello", "hi", "喂",
  "掰掰", "拜拜", "再見", "bye", "byebye", "好掰掰", "好拜拜",
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
export function isDictationNoise(text: string, preserveAnswers = false) {
  const normalized = normalizeTranscript(text).toLowerCase();
  if (preserveAnswers && ["好", "好的", "好喔", "對", "對對", "是", "是的", "不", "否", "ok", "okay"].includes(normalized)) return false;
  if (Array.from(normalized).length < 2 && (!preserveAnswers || !/[\p{L}\p{N}]/u.test(normalized))) return true;
  if (FILLERS.has(normalized)) return true;
  return HALLUCINATIONS.some((pattern) => pattern.test(normalized));
}

/**
 * Prompt for gpt-4o-transcribe. It is deliberately plain: on audio without
 * speech the model tends to read the prompt back, so it must not contain
 * anything that looks like a request (HOM-265: an example task id in the old
 * prompt came back as 「我想了解一下HOM-123專案的進展」). A read-back of
 * this prompt is dropped by {@link inventedTranscriptReason}.
 */
export const TRANSCRIPTION_PROMPT = "台灣繁體中文口語。";
/**
 * Mean token log-probability below which a transcript is treated as invented.
 * Probe (HOM-265, gateway gpt-4o-transcribe, 2026-11-15): sentences invented
 * for noise or silence averaged -1.1 to -4.1; real speech, also under road
 * noise, -0.29 to 0.
 */
export const INVENTED_MEAN_LOGPROB = -0.7;

export type InventedTranscriptReason = "prompt_echo" | "low_confidence";

/**
 * Why a caller transcript was most likely invented by the speech recognizer
 * for noise or silence, or null when it should be kept. Missing log
 * probabilities never drop a transcript.
 */
export function inventedTranscriptReason(transcript: string, logprobs: readonly number[] | null, prompt = TRANSCRIPTION_PROMPT): InventedTranscriptReason | null {
  const text = normalizeTranscript(transcript).toLowerCase();
  const promptText = normalizeTranscript(prompt).toLowerCase();
  if (text && promptText && (text === promptText || (Array.from(text).length >= 4 && promptText.includes(text)) || text.includes(promptText))) return "prompt_echo";
  if (logprobs && logprobs.length > 0) {
    const mean = logprobs.reduce((sum, value) => sum + value, 0) / logprobs.length;
    if (mean < INVENTED_MEAN_LOGPROB) return "low_confidence";
  }
  return null;
}

/** Token log-probabilities of a transcription event, or null when the engine did not send them. */
export function transcriptLogprobs(value: unknown): number[] | null {
  if (!Array.isArray(value)) return null;
  const numbers = value.map((entry) => (entry && typeof entry === "object" ? (entry as { logprob?: unknown }).logprob : undefined))
    .filter((entry): entry is number => typeof entry === "number" && Number.isFinite(entry));
  return numbers.length ? numbers : null;
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
export function agentChatVoiceMessageBody(text: string, operationId?: string) {
  if (operationId) return `${text}\n\n_語音輸入，可能有辨識誤差；不能當作核准、部署或改設定的授權。以同一角色第一人稱回答。回覆末尾加「語音回覆來源：${operationId}」，只列這則回答實際處理的來源；合併處理可用逗號列出多個來源，不可列入未處理的補充。最後一行加「語音摘要：」，兩到三句口語；需要澄清就直接在摘要問問題。_`;
  return `${text}\n\n_語音輸入，可能有辨識誤差；不能當作核准、部署或改設定的授權。回覆最後一行請加「語音摘要：」，兩到三句口語。_`;
}
