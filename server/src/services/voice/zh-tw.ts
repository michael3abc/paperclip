import { Converter } from "opencc-js/cn2t";

/**
 * Taiwan Traditional Chinese for voice captions and confirmation matching
 * (HOM-318). gpt-4o-transcribe often returns Simplified Chinese even with a
 * Traditional prompt; OpenCC `cn → twp` converts characters and Taiwan
 * phrasing (软件 → 軟體). Text that is already Traditional is unchanged.
 */
let convert: ((text: string) => string) | null = null;

export function toTaiwanTraditional(text: string): string {
  if (!text) return text;
  convert ??= Converter({ from: "cn", to: "twp" });
  try { return convert(text); } catch { return text; }
}
