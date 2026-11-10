import { afterEach, describe, expect, it, vi } from "vitest";
import { mapAntigravityQuota, fetchAntigravityQuota } from "../services/antigravity-quota.js";

vi.mock("node:fs/promises", () => ({ readFile: vi.fn(async () => JSON.stringify({
  token: { access_token: "fixture-access-token", expiry: "2099-01-01T00:00:00Z" },
})) }));

const bucket = { window: "weekly", remainingFraction: 0.75, resetTime: "2026-11-17T00:00:00Z" };
const response = (value: unknown) => ({ groups: [{ displayName: "Gemini models", buckets: [value] }] });
afterEach(() => vi.unstubAllGlobals());

describe("Antigravity quota", () => {
  it("preserves groups, weekly/5h windows, real zero and unknown values separately", () => {
    const windows = mapAntigravityQuota({ groups: [{ displayName: "Claude and GPT models", buckets: [
      bucket, { ...bucket, window: "5h", remainingFraction: 0 }, { window: "5h" },
    ] }] });
    expect(windows).toMatchObject([
      { label: "Claude and GPT models · 7d", usedPercent: 25 },
      { label: "Claude and GPT models · 5h", usedPercent: 100 },
      { usedPercent: null, resetsAt: null, valueLabel: "Remaining quota not reported" },
    ]);
    expect(mapAntigravityQuota({ groups: [] })).toEqual([]);
  });
  it.each([-0.1, 1.1, "1", NaN])("rejects invalid remaining fractions (%s)", (remainingFraction) => {
    expect(() => mapAntigravityQuota(response({ ...bucket, remainingFraction }))).toThrow("invalid remaining quota");
  });
  it("uses the native product endpoint/header and abortable read without credit or inference requests", async () => {
    const fetch = vi.fn(async () => new Response(JSON.stringify(response(bucket)), { status: 200 }));
    vi.stubGlobal("fetch", fetch);
    const signal = new AbortController().signal;
    expect(await fetchAntigravityQuota(signal)).toMatchObject([{ usedPercent: 25 }]);
    expect(fetch).toHaveBeenCalledExactlyOnceWith(
      "https://daily-cloudcode-pa.googleapis.com/v1internal:retrieveUserQuotaSummary",
      { method: "POST", body: "{}", signal, headers: {
        Authorization: "Bearer fixture-access-token", "Content-Type": "application/json", "User-Agent": "antigravity",
      } },
    );
  });
  it("surfaces HTTP refusal once and never parses or exposes the provider's error body", async () => {
    const fetch = vi.fn(async () => new Response("fixture-provider-secret", { status: 403 }));
    vi.stubGlobal("fetch", fetch);
    await expect(fetchAntigravityQuota(new AbortController().signal)).rejects.toThrow("HTTP 403");
    expect(fetch).toHaveBeenCalledTimes(1);
  });
});
