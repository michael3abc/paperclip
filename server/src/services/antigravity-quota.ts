import { execFile } from "node:child_process";
import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import type { QuotaWindow } from "@paperclipai/shared";

const execFileAsync = promisify(execFile);
const QUOTA_URL = "https://daily-cloudcode-pa.googleapis.com/v1internal:retrieveUserQuotaSummary";

export class HostQuotaError extends Error {
  constructor(public readonly family: string, message: string) { super(message); }
}

function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new HostQuotaError("invalid_response", "Provider returned an invalid quota response.");
  }
  return value as Record<string, unknown>;
}

/** Keep provider groups and time windows; never infer absent model quotas. */
export function mapAntigravityQuota(value: unknown): QuotaWindow[] {
  const body = record(value);
  if (!Array.isArray(body.groups)) throw new HostQuotaError("invalid_response", "Antigravity did not report quota groups.");
  const windows: QuotaWindow[] = [];
  for (const entry of body.groups) {
    const group = record(entry);
    if (typeof group.displayName !== "string" || !Array.isArray(group.buckets)) {
      throw new HostQuotaError("invalid_response", "Antigravity returned an invalid quota group.");
    }
    for (const entry of group.buckets) {
      const bucket = record(entry);
      const fraction = bucket.remainingFraction;
      if (fraction != null && (typeof fraction !== "number" || !Number.isFinite(fraction) || fraction < 0 || fraction > 1)) {
        throw new HostQuotaError("invalid_response", "Antigravity returned an invalid remaining quota.");
      }
      const reset = bucket.resetTime;
      if (reset != null && (typeof reset !== "string" || !Number.isFinite(Date.parse(reset)))) {
        throw new HostQuotaError("invalid_response", "Antigravity returned an invalid reset time.");
      }
      const window = bucket.window === "weekly" ? "7d" : bucket.window;
      if (typeof window !== "string" || !window) {
        throw new HostQuotaError("invalid_response", "Antigravity did not report the quota window.");
      }
      windows.push({
        label: group.displayName + " · " + window,
        usedPercent: typeof fraction === "number" ? Math.round((1 - fraction) * 10_000) / 100 : null,
        resetsAt: typeof reset === "string" ? reset : null,
        valueLabel: fraction == null ? "Remaining quota not reported" : null,
        detail: typeof group.description === "string" ? group.description : null,
      });
    }
  }
  return windows;
}

export async function fetchAntigravityQuota(signal: AbortSignal): Promise<QuotaWindow[]> {
  const tokenPath = path.join(homedir(), ".gemini", "antigravity-cli", "antigravity-oauth-token");
  const readToken = async () => {
    const auth = record(JSON.parse(await readFile(tokenPath, "utf8")));
    return record(auth.token);
  };
  let token = await readToken();
  if (typeof token.expiry !== "string" || !Number.isFinite(Date.parse(token.expiry))) {
    throw new HostQuotaError("authentication_required", "Antigravity login expiry is unavailable.");
  }
  if (Date.parse(token.expiry) <= Date.now() + 30_000) {
    // Let the installed CLI refresh its own login. The models command opens no
    // conversation, starts no agent turn and does not enable AI credit overages.
    await execFileAsync("agy", ["models"], { signal, timeout: 15_000, maxBuffer: 128 * 1024 });
    token = await readToken();
    if (typeof token.expiry !== "string" || !Number.isFinite(Date.parse(token.expiry)) || Date.parse(token.expiry) <= Date.now()) {
      throw new HostQuotaError("authentication_required", "Antigravity login needs to be renewed.");
    }
  }
  if (typeof token.access_token !== "string" || !token.access_token) {
    throw new HostQuotaError("credentials_unavailable", "Antigravity is not logged in on this host.");
  }
  const response = await fetch(QUOTA_URL, {
    method: "POST", body: "{}", signal,
    // The native service rejects generic HTTP clients without its product UA.
    headers: { Authorization: "Bearer " + token.access_token, "Content-Type": "application/json", "User-Agent": "antigravity" },
  });
  if (!response.ok) {
    throw new HostQuotaError(response.status === 401 ? "authentication_required" : "provider_unavailable",
      "Antigravity quota request failed (HTTP " + response.status + ").");
  }
  return mapAntigravityQuota(await response.json());
}
