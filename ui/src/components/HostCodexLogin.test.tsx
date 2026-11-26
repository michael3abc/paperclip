// @vitest-environment jsdom
import { flushSync } from "react-dom";
import { createRoot } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { SubscriptionQuotaCards, SubscriptionQuotaPanels } from "./SubscriptionQuotaCards";
const api = vi.hoisted(() => ({ subscriptionQuotas: vi.fn(), codexHosts: vi.fn(), checkHostCodex: vi.fn(), startHostCodex: vi.fn(), hostCodexSession: vi.fn(), cancelHostCodex: vi.fn() }));
vi.mock("@/api/dashboard", () => ({ dashboardApi: { ...api, claudeHosts: async () => [] } }));
vi.mock("@/api/access", () => ({ accessApi: { getCurrentBoardAccess: async () => ({ isInstanceAdmin: true, source: "session" }) } }));
let root: ReturnType<typeof createRoot>, host: HTMLDivElement, client: QueryClient;
beforeEach(() => {
  vi.resetAllMocks();
  api.codexHosts.mockResolvedValue([{ id: "remote-host-a", label: "Remote-host-A", available: true }]);
  api.checkHostCodex.mockResolvedValue({ loggedIn: false });
  api.startHostCodex.mockResolvedValue({ id: "s1", hostId: "remote-host-a", status: "waiting", verificationUrl: "https://auth.openai.com/codex/device", userCode: "AB12-CD345", expiresAt: new Date(Date.now() + 600_000).toISOString() });
  api.hostCodexSession.mockResolvedValue({ id: "s1", status: "authenticated" });
  api.cancelHostCodex.mockResolvedValue({ id: "s1", status: "verifying" });
  host = document.createElement("div"); document.body.append(host); root = createRoot(host);
  client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
});
afterEach(() => { flushSync(() => root.unmount()); client.clear(); host.remove(); vi.useRealTimers(); });
function mount(companyId = "company") {
  flushSync(() => root.render(<QueryClientProvider client={client}>
    <SubscriptionQuotaPanels companyId={companyId} accounts={[{ provider: "openai", ok: true, accountLabel: "remote-host-a", windows: [{ label: "Current session", usedPercent: 20, resetsAt: null, valueLabel: null }] }]} refreshing={false} failed={false} onRefresh={vi.fn()} />
  </QueryClientProvider>));
}
function button(text: string) { return Array.from(host.querySelectorAll("button")).find(b => b.textContent === text)!; }
async function checked() {
  await vi.waitFor(() => expect(client.getQueryState(["host-codex-status", "company", "remote-host-a"])?.fetchStatus).toBe("idle"));
}
it("replaces only the Codex card body after native status confirms logged out; login needs a human click", async () => {
  mount();
  await vi.waitFor(() => expect(button("登入 Codex")).toBeDefined());
  const card = button("登入 Codex").closest('[data-slot="card"]')!;
  expect(card.textContent).toContain("Codex");
  expect(card.textContent).not.toContain("Current session");
  expect(host.textContent).toContain("Claude");
  expect(host.textContent).toContain("Antigravity");
  expect(host.querySelector('[aria-label="主機 Codex 登入"]')).toBeNull();
  expect(api.checkHostCodex).toHaveBeenCalledWith("company", "remote-host-a");
  expect(api.startHostCodex).not.toHaveBeenCalled();
});
it("keeps normal quotas and hides sign-in for an authenticated host", async () => {
  api.checkHostCodex.mockResolvedValue({ loggedIn: true });
  mount(); await checked();
  expect(host.textContent).toContain("Current session");
  expect(host.textContent).toContain("80% remaining");
  expect(button("登入 Codex")).toBeUndefined();
});
it("restores quotas when a manual status check confirms an external sign-in", async () => {
  mount();
  await vi.waitFor(() => expect(button("登入 Codex")).toBeDefined());
  api.checkHostCodex.mockResolvedValue({ loggedIn: true });
  flushSync(() => button("檢查狀態").click());
  await vi.waitFor(() => expect(host.textContent).toContain("Current session"));
  expect(button("登入 Codex")).toBeUndefined();
});
it.each(["unknown", "error"])("does not treat %s status as a logged-out host", async kind => {
  if (kind === "unknown") api.checkHostCodex.mockResolvedValue({ loggedIn: null });
  else api.checkHostCodex.mockRejectedValue(new Error("fixture"));
  mount();
  await vi.waitFor(() => expect(host.textContent).toContain("無法確認 Codex 主機登入狀態"));
  expect(host.textContent).toContain("Current session");
  expect(button("登入 Codex")).toBeUndefined();
  expect(api.checkHostCodex).toHaveBeenCalledTimes(1);
});
it("offers every logged-out company host and omits authenticated or unavailable hosts", async () => {
  api.codexHosts.mockResolvedValue([
    { id: "remote-host-a", label: "Remote-host-A", available: true },
    { id: "remote-host-b", label: "Remote-host-B", available: true },
    { id: "offline", label: "Unavailable", available: false },
  ]);
  api.checkHostCodex.mockImplementation(async (_company: string, id: string) => ({ loggedIn: id === "remote-host-a" }));
  mount();
  await vi.waitFor(() => expect(host.textContent).toContain("Remote-host-B 尚未登入"));
  expect(host.textContent).not.toContain("Remote-host-A 尚未登入");
  expect(api.checkHostCodex).toHaveBeenCalledTimes(2);
  flushSync(() => button("登入 Codex").click());
  await vi.waitFor(() => expect(api.startHostCodex).toHaveBeenCalledWith("company", "remote-host-b"));
});
it("shows and copies the device code without an input, restores quotas and stops polling on success", async () => {
  const invalidate = vi.spyOn(client, "invalidateQueries");
  const writeText = vi.fn().mockResolvedValue(undefined);
  Object.defineProperty(navigator, "clipboard", { configurable: true, value: { writeText } });
  mount();
  await vi.waitFor(() => expect(button("登入 Codex")).toBeDefined());
  flushSync(() => button("登入 Codex").click());
  await vi.waitFor(() => expect(host.querySelector("a")).not.toBeNull());
  const link = host.querySelector("a")!;
  expect(link.href).toBe("https://auth.openai.com/codex/device");
  expect(link.textContent).toBe("開啟 OpenAI 裝置登入頁 ↗");
  expect(link.target).toBe("_blank");
  expect(link.rel).toContain("noopener"); expect(link.rel).toContain("noreferrer");
  expect(link.getAttribute("referrerpolicy")).toBe("no-referrer");
  expect(host.querySelector("input")).toBeNull();
  expect(host.querySelector("code")?.textContent).toBe("AB12-CD345");
  expect(host.textContent).toContain("在頁面輸入這組代碼，完成後這裡會自動更新；10 分鐘內有效");
  flushSync(() => button("複製代碼").click());
  await vi.waitFor(() => expect(writeText).toHaveBeenCalledWith("AB12-CD345"));
  await vi.waitFor(() => expect(host.textContent).toContain("Current session"), { timeout: 2500 });
  expect(invalidate).toHaveBeenCalledWith({ queryKey: ["dashboard-subscription-quotas", "company"] });
  expect(host.querySelector("a")).toBeNull(); expect(host.textContent).not.toContain("AB12-CD345");
  vi.useFakeTimers(); await vi.advanceTimersByTimeAsync(10_000);
  expect(api.hostCodexSession).toHaveBeenCalledTimes(1);
});
it("cancels only the selected sign-in", async () => {
  mount();
  await vi.waitFor(() => expect(button("登入 Codex")).toBeDefined());
  flushSync(() => button("登入 Codex").click());
  await vi.waitFor(() => expect(host.querySelector("a")).not.toBeNull());
  api.cancelHostCodex.mockResolvedValue({ id: "s1", status: "cancelled" });
  flushSync(() => button("取消登入").click());
  await vi.waitFor(() => expect(api.cancelHostCodex).toHaveBeenCalledWith("company", "s1"));
  await vi.waitFor(() => expect(button("登入 Codex")).toBeDefined());
  expect(host.querySelector("a")).toBeNull();
});
it("drops the prior company's sign-in form when switching company", async () => {
  mount();
  await vi.waitFor(() => expect(button("登入 Codex")).toBeDefined());
  flushSync(() => button("登入 Codex").click());
  await vi.waitFor(() => expect(host.querySelector("a")).not.toBeNull());
  api.codexHosts.mockResolvedValue([]);
  mount("other-company");
  await vi.waitFor(() => expect(api.codexHosts).toHaveBeenCalledWith("other-company"));
  expect(host.querySelector("a")).toBeNull();
  expect(host.textContent).toContain("Current session");
  vi.useFakeTimers(); await vi.advanceTimersByTimeAsync(10_000);
  expect(api.hostCodexSession).not.toHaveBeenCalled();
});

it("surfaces session read failures without retrying and keeps cancellation available", async () => {
  api.hostCodexSession.mockRejectedValue(new Error("fixture"));
  mount(); await vi.waitFor(() => expect(button("登入 Codex")).toBeDefined());
  flushSync(() => button("登入 Codex").click());
  await vi.waitFor(() => expect(host.textContent).toContain("無法取得登入狀態"), { timeout: 2500 });
  expect(button("取消登入")).toBeDefined();
  vi.useFakeTimers(); await vi.advanceTimersByTimeAsync(10_000);
  expect(api.hostCodexSession).toHaveBeenCalledTimes(1);
});
it("removes the device prompt on expiry even when the native status request does not return", async () => {
  api.startHostCodex.mockResolvedValue({ id: "s1", hostId: "remote-host-a", status: "waiting", verificationUrl: "https://auth.openai.com/codex/device", userCode: "AB12-CD345", expiresAt: new Date(Date.now() + 3000).toISOString() });
  api.hostCodexSession.mockImplementation(() => new Promise(() => {}));
  mount(); await vi.waitFor(() => expect(button("登入 Codex")).toBeDefined());
  vi.useFakeTimers();
  flushSync(() => button("登入 Codex").click());
  await vi.waitFor(() => expect(host.querySelector("a")).not.toBeNull());
  await vi.advanceTimersByTimeAsync(3001); vi.useRealTimers();
  await vi.waitFor(() => expect(host.textContent).toContain("登入失敗或已逾時"));
  expect(host.querySelector("a")).toBeNull(); expect(host.textContent).not.toContain("AB12-CD345");
  expect(button("登入 Codex")).toBeDefined();
});
it("surfaces start and clipboard failures without retrying", async () => {
  api.startHostCodex.mockRejectedValueOnce(new Error("fixture"));
  mount(); await vi.waitFor(() => expect(button("登入 Codex")).toBeDefined());
  flushSync(() => button("登入 Codex").click());
  await vi.waitFor(() => expect(host.textContent).toContain("操作失敗"));
  expect(api.startHostCodex).toHaveBeenCalledTimes(1);
  flushSync(() => button("登入 Codex").click());
  await vi.waitFor(() => expect(host.querySelector("a")).not.toBeNull());
  Object.defineProperty(navigator, "clipboard", { configurable: true, value: { writeText: vi.fn().mockRejectedValue(new Error("denied")) } });
  flushSync(() => button("複製代碼").click());
  await vi.waitFor(() => expect(host.textContent).toContain("操作失敗"));
  expect(button("已複製")).toBeUndefined();
});
it("refreshes quotas and invalidates both providers' host lists and login statuses", async () => {
  api.subscriptionQuotas.mockResolvedValue([{ provider: "openai", ok: true, accountLabel: "host", windows: [] }]);
  const invalidate = vi.spyOn(client, "invalidateQueries");
  flushSync(() => root.render(<QueryClientProvider client={client}><SubscriptionQuotaCards companyId="company" /></QueryClientProvider>));
  await vi.waitFor(() => expect(button("Refresh")).toBeDefined());
  flushSync(() => button("Refresh").click());
  for (const prefix of ["host-claude-logins", "host-claude-status", "host-codex-logins", "host-codex-status"]) {
    expect(invalidate).toHaveBeenCalledWith({ queryKey: [prefix, "company"] });
  }
  await vi.waitFor(() => expect(api.subscriptionQuotas).toHaveBeenCalledTimes(2));
});

it("polls the explicit login only while the Dashboard is visible", async () => {
  const hidden = vi.spyOn(document, "hidden", "get").mockReturnValue(true);
  try {
    mount(); await vi.waitFor(() => expect(button("登入 Codex")).toBeDefined());
    vi.useFakeTimers();
    flushSync(() => button("登入 Codex").click());
    await vi.waitFor(() => expect(host.querySelector("a")).not.toBeNull());
    await vi.advanceTimersByTimeAsync(10_000);
    expect(api.hostCodexSession).not.toHaveBeenCalled();
    hidden.mockReturnValue(false);
    document.dispatchEvent(new Event("visibilitychange"));
    await vi.advanceTimersByTimeAsync(1501); vi.useRealTimers();
    await vi.waitFor(() => expect(host.textContent).toContain("Current session"));
    expect(api.hostCodexSession).toHaveBeenCalledExactlyOnceWith("company", "s1");
  } finally { hidden.mockRestore(); }
});
