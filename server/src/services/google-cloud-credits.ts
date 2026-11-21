import { readFile } from "node:fs/promises";
import type { ProviderQuotaResult, QuotaWindow } from "@paperclipai/shared";

/**
 * Google Cloud promotional credit estimate for the Dashboard quota cards.
 *
 * Google has no API for remaining credit. A host timer (services/systemd/platform/vertex-credits)
 * combines an operator-recorded Credits-page snapshot with the before-credit spend that a billing
 * budget reports through Pub/Sub, and writes `paperclip.google-cloud-credits.v1`. This reader only
 * validates and formats that file; it never calls Google or reads a credential.
 */
export const GOOGLE_CLOUD_PROVIDER = "google_cloud";
const STALE_MS = 3 * 60 * 60 * 1000;

interface CreditsFile {
  schema: "paperclip.google-cloud-credits.v1";
  currency: string;
  snapshotAt: string;
  creditsOriginal: number;
  creditsRemainingEstimate: number;
  spendSinceSnapshot: number;
  month: { intervalStart: string; spend: number; budget: number | null; reportedAt: string } | null;
  lastReportAt: string | null;
  checkedAt: string;
}

const finite = (value: unknown): value is number => typeof value === "number" && Number.isFinite(value) && value >= 0;
const isoTime = (value: unknown): value is string => typeof value === "string" && Number.isFinite(Date.parse(value));

export function parseGoogleCloudCredits(value: unknown): CreditsFile {
  const body = (value ?? {}) as Record<string, unknown>;
  const month = body.month as Record<string, unknown> | null | undefined;
  if (body.schema !== "paperclip.google-cloud-credits.v1" || typeof body.currency !== "string"
    || !/^[A-Z]{3}$/.test(body.currency) || !isoTime(body.snapshotAt) || !isoTime(body.checkedAt)
    || !finite(body.creditsOriginal) || !finite(body.creditsRemainingEstimate) || !finite(body.spendSinceSnapshot)
    || (body.lastReportAt !== null && !isoTime(body.lastReportAt))
    || (month != null && (!isoTime(month.intervalStart) || !finite(month.spend) || !isoTime(month.reportedAt)
      || (month.budget != null && !finite(month.budget))))) {
    throw new Error("invalid credits file");
  }
  return body as unknown as CreditsFile;
}

function nextMonth(intervalStart: string): string {
  const start = new Date(intervalStart);
  const next = new Date(start);
  next.setUTCMonth(start.getUTCMonth() + 1);
  return next.toISOString();
}

export function mapGoogleCloudCredits(file: CreditsFile): QuotaWindow[] {
  const money = (amount: number) => new Intl.NumberFormat("en-US", { style: "currency", currency: file.currency }).format(amount);
  const used = file.creditsOriginal > 0
    ? Math.min(100, Math.max(0, Math.round((1 - file.creditsRemainingEstimate / file.creditsOriginal) * 10_000) / 100)) : null;
  const snapshotDate = file.snapshotAt.slice(0, 10);
  const windows: QuotaWindow[] = [{
    label: `Credits left (estimate) · ${money(file.creditsRemainingEstimate)} of ${money(file.creditsOriginal)}`,
    usedPercent: used,
    resetsAt: null,
    valueLabel: used === null ? "Credit total not recorded" : null,
    detail: `Credits page on ${snapshotDate} minus ${money(file.spendSinceSnapshot)} spend (before credits) that Google reported since then.`,
  }];
  if (!file.month) {
    windows.push({ label: "Spend this month (before credits)", usedPercent: null, resetsAt: null,
      valueLabel: "Waiting for Google's first spend report (can take several hours)" });
  } else {
    const budget = file.month.budget && file.month.budget > 0 ? file.month.budget : null;
    windows.push({
      label: `Spend this month (before credits) · ${money(file.month.spend)}${budget ? ` of ${money(budget)} budget` : ""}`,
      usedPercent: budget ? Math.min(100, Math.round((file.month.spend / budget) * 10_000) / 100) : null,
      resetsAt: nextMonth(file.month.intervalStart),
      valueLabel: budget ? null : money(file.month.spend),
      detail: `Google reported this at ${file.month.reportedAt}; its spend data runs a few hours behind.`,
    });
  }
  return windows;
}

export async function readGoogleCloudCredits(path: string, now = Date.now()): Promise<ProviderQuotaResult> {
  const base = { provider: GOOGLE_CLOUD_PROVIDER, source: "google-cloud-budget", accountKey: "google-cloud-budget",
    accountLabel: "Google Cloud billing" };
  try {
    const file = parseGoogleCloudCredits(JSON.parse(await readFile(path, "utf8")));
    if (now - Date.parse(file.checkedAt) > STALE_MS) {
      return { ...base, ok: false, windows: [], capturedAt: file.checkedAt, errorFamily: "stale",
        error: "The Google Cloud credit reader has not run for over 3 hours." };
    }
    return { ...base, accountLabel: `Google Cloud billing · ${file.currency}`, ok: true,
      capturedAt: file.checkedAt, windows: mapGoogleCloudCredits(file) };
  } catch {
    return { ...base, ok: false, windows: [], capturedAt: new Date(now).toISOString(), errorFamily: "provider_unavailable",
      error: "Google Cloud credit estimate is unavailable. Check the credit reader on this host." };
  }
}
