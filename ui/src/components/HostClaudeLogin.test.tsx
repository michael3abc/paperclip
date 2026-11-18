// @vitest-environment jsdom
import { flushSync } from "react-dom";
import { createRoot } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { HostClaudeLogin } from "./HostClaudeLogin";
const api = vi.hoisted(() => ({ claudeHosts: vi.fn(), checkHostClaude: vi.fn(), startHostClaude: vi.fn(), hostClaudeSession: vi.fn(), hostClaudeAction: vi.fn() }));
vi.mock("@/api/dashboard", () => ({ dashboardApi: api }));
let root: ReturnType<typeof createRoot>, host: HTMLDivElement;
beforeEach(() => {
  vi.resetAllMocks();
  api.claudeHosts.mockResolvedValue([{ id: "shopee-e", label: "Shopee-E", available: true }]);
  api.checkHostClaude.mockResolvedValue({ loggedIn: false });
  api.startHostClaude.mockResolvedValue({ id: "s1", hostId: "shopee-e", status: "waiting", authorizationUrl: "https://claude.com/cai/oauth/authorize?state=fixture", expiresAt: "2099-01-01" });
  api.hostClaudeSession.mockResolvedValue({ id: "s1", status: "authenticated" });
  api.hostClaudeAction.mockResolvedValue({ id: "s1", status: "verifying" });
  host = document.createElement("div"); document.body.append(host); root = createRoot(host);
  flushSync(() => root.render(<QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}><HostClaudeLogin companyId="company" /></QueryClientProvider>));
});
afterEach(() => { flushSync(() => root.unmount()); host.remove(); vi.useRealTimers(); });
function button(text: string) { return Array.from(host.querySelectorAll("button")).find(b => b.textContent === text)!; }
it("does no CLI work until a human clicks and reports actual status", async () => {
  await vi.waitFor(() => expect(host.textContent).toContain("Shopee-E"));
  expect(api.checkHostClaude).not.toHaveBeenCalled(); expect(api.startHostClaude).not.toHaveBeenCalled();
  flushSync(() => button("檢查狀態").click());
  await vi.waitFor(() => expect(host.textContent).toContain("尚未登入 Claude 訂閱"));
  expect(api.checkHostClaude).toHaveBeenCalledWith("company", "shopee-e");
});
it("submits a private browser code, clears it, and stops polling on success", async () => {
  await vi.waitFor(() => expect(host.textContent).toContain("Shopee-E"));
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
  await vi.waitFor(() => expect(host.textContent).toContain("已登入 Claude 訂閱"), { timeout: 2500 });
  expect(host.querySelector("a")).toBeNull();
  vi.useFakeTimers(); await vi.advanceTimersByTimeAsync(10_000);
  expect(api.hostClaudeSession).toHaveBeenCalledTimes(1);
});
it("cancels only the selected sign-in", async () => {
  await vi.waitFor(() => expect(host.textContent).toContain("Shopee-E"));
  flushSync(() => button("登入 Claude").click());
  await vi.waitFor(() => expect(host.querySelector("a")).not.toBeNull());
  api.hostClaudeAction.mockResolvedValue({ id: "s1", status: "cancelled" });
  flushSync(() => button("取消登入").click());
  await vi.waitFor(() => expect(api.hostClaudeAction).toHaveBeenCalledWith("company", "s1", "cancel"));
  await vi.waitFor(() => expect(host.querySelector("a")).toBeNull());
});
