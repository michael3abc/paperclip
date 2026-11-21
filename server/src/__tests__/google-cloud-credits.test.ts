import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mapGoogleCloudCredits, parseGoogleCloudCredits, readGoogleCloudCredits } from "../services/google-cloud-credits.js";

const now = Date.parse("2026-11-21T10:00:00Z");
const file = {
  schema: "paperclip.google-cloud-credits.v1", currency: "TWD", snapshotAt: "2026-11-21T08:50:00Z",
  creditsOriginal: 9852, creditsRemainingEstimate: 9839.82, spendSinceSnapshot: 10,
  month: { intervalStart: "2026-11-01T07:00:00Z", spend: 12.18, budget: 318, reportedAt: "2026-11-21T09:40:00Z" },
  lastReportAt: "2026-11-21T09:40:00Z", checkedAt: "2026-11-21T09:57:00Z",
};

let directory: string;
beforeEach(async () => { directory = await mkdtemp(path.join(tmpdir(), "gcp-credits-")); });
afterEach(async () => { await rm(directory, { recursive: true, force: true }); });

describe("Google Cloud credit estimate", () => {
  it("shows the estimated credit left and this month's before-credit spend in the account currency", () => {
    const windows = mapGoogleCloudCredits(parseGoogleCloudCredits(file));
    expect(windows[0]).toMatchObject({ label: "Credits left (estimate) · NT$9,839.82 of NT$9,852.00", resetsAt: null });
    expect(windows[0]!.usedPercent).toBeCloseTo(0.12, 2);
    expect(windows[0]!.detail).toContain("Credits page on 2026-11-21 minus NT$10.00");
    expect(windows[1]).toMatchObject({ label: "Spend this month (before credits) · NT$12.18 of NT$318.00 budget",
      resetsAt: "2026-12-01T07:00:00.000Z" });
    expect(windows[1]!.usedPercent).toBeCloseTo(3.83, 2);
  });

  it("says it is waiting before Google's first report instead of showing zero spend", () => {
    const windows = mapGoogleCloudCredits(parseGoogleCloudCredits({ ...file, month: null, lastReportAt: null }));
    expect(windows[1]).toMatchObject({ usedPercent: null, valueLabel: expect.stringContaining("Waiting for Google") });
  });

  it("reports a stale or invalid reader as unavailable without echoing file contents", async () => {
    const target = path.join(directory, "credits.json");
    await writeFile(target, JSON.stringify({ ...file, checkedAt: "2026-11-21T06:00:00Z" }));
    expect(await readGoogleCloudCredits(target, now)).toMatchObject({ ok: false, errorFamily: "stale" });
    await writeFile(target, JSON.stringify({ ...file, currency: "private-secret" }));
    const invalid = await readGoogleCloudCredits(target, now);
    expect(invalid).toMatchObject({ ok: false, errorFamily: "provider_unavailable" });
    expect(JSON.stringify(invalid)).not.toContain("private-secret");
    await writeFile(target, JSON.stringify(file));
    expect(await readGoogleCloudCredits(target, now)).toMatchObject({ ok: true, provider: "google_cloud", windows: [{}, {}] });
  });
});
