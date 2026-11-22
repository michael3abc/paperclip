// @vitest-environment jsdom
import { flushSync } from "react-dom";
import { createRoot } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { SubscriptionQuotaPanels } from "./SubscriptionQuotaCards";
const api = vi.hoisted(() => ({ claudeHosts: vi.fn(), checkHostClaude: vi.fn(), startHostClaude: vi.fn(), hostClaudeSession: vi.fn(), hostClaudeAction: vi.fn() }));
vi.mock("@/api/dashboard", () => ({ dashboardApi: { ...api, codexHosts: async () => [] } }));
let root: ReturnType<typeof createRoot>, host: HTMLDivElement, client: QueryClient;
beforeEach(() => {
  vi.resetAllMocks();
  api.claudeHosts.mockResolvedValue([{ id: "shopee-e", label: "Shopee-E", available: true }]);
  api.checkHostClaude.mockResolvedValue({ loggedIn: false });
  api.startHostClaude.mockResolvedValue({ id: "s1", hostId: "shopee-e", status: "waiting", authorizationUrl: "https://claude.com/cai/oauth/authorize?state=fixture", expiresAt: "2099-01-01" });
  api.hostClaudeSession.mockResolvedValue({ id: "s1", status: "authenticated" });
  api.hostClaudeAction.mockResolvedValue({ id: "s1", status: "verifying" });
  host = document.createElement("div"); document.body.append(host); root = createRoot(host);
  client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
});
afterEach(() => { flushSync(() => root.unmount()); client.clear(); host.remove(); vi.useRealTimers(); });
function mount(companyId = "company") {
  flushSync(() => root.render(<QueryClientProvider client={client}>
    <SubscriptionQuotaPanels companyId={companyId} accounts={[{ provider: "anthropic", ok: true, accountLabel: "shopee-e", windows: [{ label: "Current session", usedPercent: 20, resetsAt: null, valueLabel: null }] }]} refreshing={false} failed={false} onRefresh={vi.fn()} />
  </QueryClientProvider>));
}
function button(text: string) { return Array.from(host.querySelectorAll("button")).find(b => b.textContent === text)!; }
async function checked() {
  await vi.waitFor(() => expect(client.getQueryState(["host-claude-status", "company", "shopee-e"])?.fetchStatus).toBe("idle"));
}
it("replaces only the Claude card body after native status confirms logged out; login needs a human click", async () => {
  mount();
  await vi.waitFor(() => expect(button("登入 Claude")).toBeDefined());
  const card = button("登入 Claude").closest('[data-slot="card"]')!;
  expect(card.textContent).toContain("Claude");
  expect(card.textContent).not.toContain("Current session");
  expect(host.textContent).toContain("Codex");
  expect(host.textContent).toContain("Antigravity");
  expect(host.querySelector('[aria-label="主機 Claude 登入"]')).toBeNull();
  expect(api.checkHostClaude).toHaveBeenCalledWith("company", "shopee-e");
  expect(api.startHostClaude).not.toHaveBeenCalled();
});
it("keeps normal quotas and hides sign-in for an authenticated host", async () => {
  api.checkHostClaude.mockResolvedValue({ loggedIn: true });
  mount(); await checked();
  expect(host.textContent).toContain("Current session");
  expect(host.textContent).toContain("80% remaining");
  expect(button("登入 Claude")).toBeUndefined();
});
it("restores quotas when a manual status check confirms an external sign-in", async () => {
  mount();
  await vi.waitFor(() => expect(button("登入 Claude")).toBeDefined());
  api.checkHostClaude.mockResolvedValue({ loggedIn: true });
  flushSync(() => button("檢查狀態").click());
  await vi.waitFor(() => expect(host.textContent).toContain("Current session"));
  expect(button("登入 Claude")).toBeUndefined();
});
it.each(["unknown", "error"])("does not treat %s status as a logged-out host", async kind => {
  if (kind === "unknown") api.checkHostClaude.mockResolvedValue({ loggedIn: null });
  else api.checkHostClaude.mockRejectedValue(new Error("fixture"));
  mount();
  await vi.waitFor(() => expect(host.textContent).toContain("無法確認 Claude 主機登入狀態"));
  expect(host.textContent).toContain("Current session");
  expect(button("登入 Claude")).toBeUndefined();
  expect(api.checkHostClaude).toHaveBeenCalledTimes(1);
});
it("offers every logged-out company host and omits authenticated or unavailable hosts", async () => {
  api.claudeHosts.mockResolvedValue([
    { id: "shopee-e", label: "Shopee-E", available: true },
    { id: "shopee-d", label: "Shopee-D", available: true },
    { id: "offline", label: "Unavailable", available: false },
  ]);
  api.checkHostClaude.mockImplementation(async (_company: string, id: string) => ({ loggedIn: id === "shopee-e" }));
  mount();
  await vi.waitFor(() => expect(host.textContent).toContain("Shopee-D 尚未登入"));
  expect(host.textContent).not.toContain("Shopee-E 尚未登入");
  expect(api.checkHostClaude).toHaveBeenCalledTimes(2);
  flushSync(() => button("登入 Claude").click());
  await vi.waitFor(() => expect(api.startHostClaude).toHaveBeenCalledWith("company", "shopee-d"));
});
it("submits a private browser code, clears it, restores quotas, and stops polling on success", async () => {
  const invalidate = vi.spyOn(client, "invalidateQueries");
  mount();
  await vi.waitFor(() => expect(button("登入 Claude")).toBeDefined());
  flushSync(() => button("登入 Claude").click());
  await vi.waitFor(() => expect(host.querySelector("input")).not.toBeNull());
  const link = host.querySelector("a")!;
  expect(link.rel).toContain("noreferrer");
  const input = host.querySelector("input")!;
  expect(input.type).toBe("password");
  flushSync(() => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(input, "fixture-code");
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
  flushSync(() => host.querySelector("form")!.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true })));
  await vi.waitFor(() => expect(api.hostClaudeAction).toHaveBeenCalledWith("company", "s1", "code", "fixture-code"));
  expect(host.textContent).not.toContain("fixture-code");
  await vi.waitFor(() => expect(host.textContent).toContain("Current session"), { timeout: 2500 });
  expect(invalidate).toHaveBeenCalledWith({ queryKey: ["dashboard-subscription-quotas", "company"] });
  expect(host.querySelector("a")).toBeNull();
  expect(button("登入 Claude")).toBeUndefined();
  vi.useFakeTimers(); await vi.advanceTimersByTimeAsync(10_000);
  expect(api.hostClaudeSession).toHaveBeenCalledTimes(1);
});
it("cancels only the selected sign-in", async () => {
  mount();
  await vi.waitFor(() => expect(button("登入 Claude")).toBeDefined());
  flushSync(() => button("登入 Claude").click());
  await vi.waitFor(() => expect(host.querySelector("a")).not.toBeNull());
  api.hostClaudeAction.mockResolvedValue({ id: "s1", status: "cancelled" });
  flushSync(() => button("取消登入").click());
  await vi.waitFor(() => expect(api.hostClaudeAction).toHaveBeenCalledWith("company", "s1", "cancel"));
  await vi.waitFor(() => expect(button("登入 Claude")).toBeDefined());
  expect(host.querySelector("a")).toBeNull();
});
it("drops the prior company's sign-in form when switching company", async () => {
  mount();
  await vi.waitFor(() => expect(button("登入 Claude")).toBeDefined());
  flushSync(() => button("登入 Claude").click());
  await vi.waitFor(() => expect(host.querySelector("a")).not.toBeNull());
  api.claudeHosts.mockResolvedValue([]);
  mount("other-company");
  await vi.waitFor(() => expect(api.claudeHosts).toHaveBeenCalledWith("other-company"));
  expect(host.querySelector("a")).toBeNull();
  expect(host.textContent).toContain("Current session");
});
