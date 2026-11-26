// @vitest-environment jsdom
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { SubscriptionQuotaPanels, orderQuotaWindows, quotaResetLabel } from "./SubscriptionQuotaCards";
import type { ProviderQuotaResult } from "@paperclipai/shared";
import { QuotaBar } from "./QuotaBar";

const account: ProviderQuotaResult = { provider: "openai", ok: true, accountLabel: "test-host", capturedAt: "2026-11-10T00:00:00Z", windows: [
  { label: "Weekly limit", usedPercent: 99, resetsAt: null, valueLabel: null },
  { label: "Unknown limit", usedPercent: null, resetsAt: null, valueLabel: null },
] };
const render = (accounts: ProviderQuotaResult[], failed = false) => renderToStaticMarkup(
  <SubscriptionQuotaPanels accounts={accounts} refreshing={false} failed={failed} onRefresh={vi.fn()} />,
);

describe("subscription quota cards", () => {
  it("shows all three providers and the real remaining quota without claiming unknown data is full", () => {
    const html = render([account]);
    expect(html).toContain("Codex");
    expect(html).toContain("Claude");
    expect(html).toContain("Antigravity");
    expect(html).toContain("1% remaining");
    expect(html).toContain("Remaining quota not reported");
    expect(html).toContain("Reset time not reported");
    expect(html).not.toContain("100% remaining");
    const view = document.createElement("div");
    view.innerHTML = html;
    const bar = view.querySelector<HTMLElement>('[role="progressbar"]')!;
    expect(bar.style.width).toBe("1%");
    expect(bar.getAttribute("aria-valuenow")).toBe("1");
    expect(bar.getAttribute("aria-label")).toBe("Weekly limit: 1% remaining");
    expect(bar.className).toContain("bg-(--status-task-blocked)");
  });
  it.each([
    { usedPercent: 0, remaining: 100, color: "done" },
    { usedPercent: 10, remaining: 90, color: "done" },
    { usedPercent: 100, remaining: 0, color: "blocked" },
  ])("fills $remaining% for a reported usage of $usedPercent%", ({ usedPercent, remaining, color }) => {
    const view = document.createElement("div");
    view.innerHTML = render([{ ...account, windows: [{ ...account.windows[0], usedPercent }] }]);
    const bar = view.querySelector<HTMLElement>('[role="progressbar"]')!;
    expect(bar.style.width).toBe(remaining + "%");
    expect(bar.getAttribute("aria-valuenow")).toBe(String(remaining));
    expect(bar.className).toContain("bg-(--status-task-" + color + ")");
  });
  it("keeps existing spending bars expressed as consumption", () => {
    const view = document.createElement("div");
    view.innerHTML = renderToStaticMarkup(<QuotaBar label="Period spend" percentUsed={99} leftLabel="99% used" />);
    const bar = view.querySelector<HTMLElement>('[role="progressbar"]')!;
    expect(bar.style.width).toBe("99%");
    expect(bar.getAttribute("aria-valuenow")).toBe("99");
    expect(bar.getAttribute("aria-label")).toBe("Period spend: 99%");
  });
  it("distinguishes a failed refresh and provider refusal from successful values", () => {
    const html = render([account, { provider: "anthropic", ok: false, error: "Login expired", windows: [] }], true);
    expect(html).toContain("previous check");
    expect(html).toContain("Login expired");
    expect(html).toContain('role="alert"');
  });
  it("hides the section when the host feature is disabled", () => {
    expect(render([])).toBe("");
  });
  it("formats reset countdowns without treating elapsed times as renewed quota", () => {
    const now = Date.parse("2026-11-10T00:00:00Z");
    expect(quotaResetLabel("2026-11-10T02:30:00Z", now)).toBe("Resets in 2h 30m");
    expect(quotaResetLabel("2026-11-13T01:00:00Z", now)).toBe("Resets in 3d 1h");
    expect(quotaResetLabel("2026-11-09T00:00:00Z", now)).toContain("refresh to check");
    expect(quotaResetLabel(null, now)).toBe("Reset time not reported");
  });

  it("shows the 5h window above the 7d window inside each Antigravity group, keeping group order", () => {
    const w = (label: string) => ({ label, usedPercent: 10, resetsAt: null, valueLabel: null });
    expect(orderQuotaWindows([
      w("Claude and GPT models · 7d"), w("Claude and GPT models · 5h"),
      w("Gemini models · 7d"), w("Gemini models · 5h"),
      w("Weekly limit"), w("Unknown limit"),
    ]).map((window) => window.label)).toEqual([
      "Claude and GPT models · 5h", "Claude and GPT models · 7d",
      "Gemini models · 5h", "Gemini models · 7d",
      "Weekly limit", "Unknown limit",
    ]);
    const html = render([{ provider: "antigravity", ok: true, accountLabel: "controller-host",
      windows: [w("Claude and GPT models · 7d"), w("Claude and GPT models · 5h")] }]);
    expect(html.indexOf("Claude and GPT models · 5h")).toBeLessThan(html.indexOf("Claude and GPT models · 7d"));
  });

  it("shows the Google Cloud credit card only when the company reports it, without a reset line for credits", () => {
    expect(render([account])).not.toContain("Google Cloud credits");
    const html = render([account, { provider: "google_cloud", ok: true, accountLabel: "Google Cloud billing · TWD", capturedAt: "2026-11-21T09:57:00Z",
      windows: [{ label: "Credits left (estimate) · NT$9,839.82 of NT$9,852.00", usedPercent: 0.12, resetsAt: null, valueLabel: null },
        { label: "Spend this month (before credits) · NT$12.18 of NT$318.00 budget", usedPercent: 3.83, resetsAt: "2026-12-01T07:00:00.000Z", valueLabel: null }] }]);
    expect(html).toContain("Google Cloud credits");
    expect(html).toContain("Credits left (estimate) · NT$9,839.82 of NT$9,852.00");
    expect(html).toContain("Google has no credit-balance API");
    expect(html.match(/Reset time not reported/g)?.length ?? 0).toBe(1);
  });
});
