// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DEFAULT_PUSH_CATEGORIES } from "@paperclipai/shared";
import { PushNotificationSettings } from "./PushNotificationSettings";
const api = vi.hoisted(() => ({ get: vi.fn(), preferences: vi.fn(), test: vi.fn(), remove: vi.fn() }));
vi.mock("@/api/push", () => ({ pushApi: api }));
vi.mock("@/lib/web-push", () => ({ currentPushBinding: () => ({ userId: "alice", subscriptionId: "phone", companyId: "company" }),
  pushSupportMessage: () => null, enableWebPush: vi.fn(), disableWebPush: vi.fn(), clearLocalPush: vi.fn() }));
describe("Push notification settings", () => {
  let container: HTMLDivElement; let root: Root; let client: QueryClient;
  beforeEach(() => {
    vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
    vi.clearAllMocks();
    api.get.mockResolvedValue({ userId: "alice", configured: true, publicKey: "fixture", preferences: { enabled: true, categories: DEFAULT_PUSH_CATEGORIES },
      devices: [{ id: "phone", name: "iPhone", active: true, createdAt: new Date().toISOString() }], recent: [] });
    api.preferences.mockImplementation(async (_companyId, _userId, preferences) => preferences);
    container = document.createElement("div"); document.body.append(container); root = createRoot(container);
    client = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  });
  afterEach(async () => { await act(async () => root.unmount()); client.clear(); container.remove(); vi.unstubAllGlobals(); });
  async function render() {
    await act(async () => root.render(<QueryClientProvider client={client}><PushNotificationSettings userId="alice" companyId="company" /></QueryClientProvider>));
    await act(async () => { await new Promise(resolve => setTimeout(resolve, 20)); });
  }
  it("renders the agreed defaults and saves category changes at account scope", async () => {
    await render();
    const inputs = [...container.querySelectorAll<HTMLInputElement>('input[type="checkbox"]')];
    expect(inputs.map(i => i.checked)).toEqual([true, true, true, true, true, true, false, false]);
    await act(async () => inputs[6].click());
    expect(api.preferences).toHaveBeenCalledWith("company", "alice", { enabled: true, categories: { ...DEFAULT_PUSH_CATEGORIES, progress: true } });
  });
  it("calls the dedicated test endpoint and describes queued delivery honestly", async () => {
    await render(); const button = [...container.querySelectorAll("button")].find(b => b.textContent === "發送測試通知")!;
    await act(async () => button.click());
    expect(api.test).toHaveBeenCalledWith("company", "alice", "phone");
    expect(container.textContent).toContain("已排入佇列");
  });
  it("surfaces configuration failures and does not request notification permission", async () => {
    api.get.mockRejectedValue(new Error("伺服器設定錯誤")); await render();
    expect(container.querySelector('[role="alert"]')?.textContent).toContain("伺服器設定錯誤");
    expect(container.textContent).not.toContain("發送測試通知");
  });
});
