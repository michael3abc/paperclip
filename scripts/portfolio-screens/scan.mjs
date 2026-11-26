export const forbidden = /michael-server|shopee|yoyo|compass|192\.168\.|HOM-|\/home\/|momo|nono|career|all-set|comfyui|driving|fable|gpt-6|astra|strata|opus 5|sonnet 5|[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}/ig;
export function assertSafe(text, label) {
  const matches = [...text.matchAll(forbidden)];
  if (matches.length) throw new Error(`${label}: forbidden content (${[...new Set(matches.map(match => match[0]))].join(", ")})`);
}
