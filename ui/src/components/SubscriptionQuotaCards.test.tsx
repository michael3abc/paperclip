// @vitest-environment jsdom
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { SubscriptionQuotaPanels, quotaResetLabel } from "./SubscriptionQuotaCards";
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
  it("shows only selected company accounts and the real remaining quota without claiming unknown data is full", () => {
    const html = render([account]);
    expect(html).toContain("Codex");
    expect(html).not.toContain("Claude");
    expect(html).not.toContain("Antigravity");
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
  it("renders every host account even when two hosts use the same provider", () => {
    const html = render([
      { ...account, accountKey: "host:a:openai", accountLabel: "Shopee-E" },
      { ...account, accountKey: "host:b:openai", accountLabel: "Shopee-D" },
    ]);
    expect(html).toContain("Shopee-E");
    expect(html).toContain("Shopee-D");
    expect((html.match(/Weekly limit/g) ?? []).length).toBe(4);
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
});
