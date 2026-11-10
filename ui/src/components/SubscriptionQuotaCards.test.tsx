// @vitest-environment jsdom
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { SubscriptionQuotaPanels, quotaResetLabel } from "./SubscriptionQuotaCards";
import type { ProviderQuotaResult } from "@paperclipai/shared";

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
