// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from "vitest";
import { clearLocalPush, currentPushBinding, disableWebPush, enableWebPush, pushSupportMessage, reconcilePushAccount } from "./web-push";
const api = vi.hoisted(() => ({ remove: vi.fn(), subscribe: vi.fn() }));
vi.mock("../api/push", () => ({ pushApi: api }));
describe("browser push enrollment and account transitions", () => {
  const unsubscribe = vi.fn(async () => true);
  const requestPermission = vi.fn(async () => "granted");
  const json = { endpoint: "https://web.push.apple.com/test", keys: { p256dh: "key", auth: "auth" } };
  const subscription = { unsubscribe, toJSON: () => json };
  const getSubscription = vi.fn(async () => subscription as typeof subscription | null);
  const subscribe = vi.fn(async () => subscription);
  const postMessage = vi.fn((_data, ports) => ports[0].other.onmessage({ data: { ok: true } }));
  const registration = { active: { postMessage }, pushManager: { getSubscription, subscribe }, getNotifications: async () => [] };
  beforeEach(() => {
    vi.clearAllMocks(); localStorage.clear();
    vi.stubGlobal("isSecureContext", true); vi.stubGlobal("PushManager", function () {});
    vi.stubGlobal("matchMedia", () => ({ matches: true }));
    vi.stubGlobal("Notification", { permission: "default", requestPermission });
    vi.stubGlobal("MessageChannel", class {
      port1 = { onmessage: null, close: vi.fn() }; port2 = { other: this.port1 };
    });
    Object.defineProperty(navigator, "serviceWorker", { configurable: true, value: { getRegistration: async () => registration } });
    requestPermission.mockResolvedValue("granted"); unsubscribe.mockResolvedValue(true); getSubscription.mockResolvedValue(subscription);
    api.subscribe.mockResolvedValue({ id: "device-a", name: "Phone", active: true }); api.remove.mockResolvedValue(undefined);
  });
  it("requests permission before subscribing, stores ownership, and binds the worker", async () => {
    const promise = enableWebPush("alice", "company", btoa("public-key"), "Phone");
    expect(requestPermission).toHaveBeenCalledOnce(); expect(subscribe).not.toHaveBeenCalled();
    await promise;
    expect(api.subscribe).toHaveBeenCalledWith("company", "alice", { ...json, name: "Phone" });
    expect(currentPushBinding()).toEqual({ userId: "alice", companyId: "company", subscriptionId: "device-a" });
    expect(postMessage.mock.calls[0][0].binding.subscriptionId).toBe("device-a");
  });
  it("denied permission makes no subscription request", async () => {
    requestPermission.mockResolvedValue("denied");
    await expect(enableWebPush("alice", "company", btoa("key"), "Phone")).rejects.toThrow("尚未允許");
    expect(api.subscribe).not.toHaveBeenCalled();
  });
  it("a subscription response arriving after sign-out cannot bind the old account", async () => {
    let finish!: (value: unknown) => void;
    let entered!: () => void;
    const requested = new Promise<void>(resolve => { entered = resolve; });
    api.subscribe.mockImplementationOnce(() => { entered(); return new Promise(resolve => { finish = resolve; }); });
    const result = enableWebPush("alice", "company", btoa("key"), "Phone");
    await requested; await disableWebPush(); finish({ id: "late-device" });
    await expect(result).rejects.toThrow("帳號已變更");
    expect(currentPushBinding()).toBeNull();
    expect(postMessage.mock.calls.every(call => call[0].binding === null)).toBe(true);
  });
  it("HTTP and unsupported browsers show an actionable reason", () => {
    vi.stubGlobal("isSecureContext", false); expect(pushSupportMessage()).toContain("HTTPS");
    vi.stubGlobal("isSecureContext", true); vi.stubGlobal("Notification", { permission: "denied" });
    expect(pushSupportMessage()).toContain("拒絕");
  });
  it("sign-out revokes server ownership before clearing local state", async () => {
    localStorage.setItem("paperclip.push.device", JSON.stringify({ userId: "alice", companyId: "company", subscriptionId: "device-a" }));
    await disableWebPush();
    expect(api.remove).toHaveBeenCalledWith("company", "alice", "device-a"); expect(unsubscribe).toHaveBeenCalledOnce();
    expect(currentPushBinding()).toBeNull(); expect(postMessage.mock.calls[0][0].binding).toBeNull();
  });
  it("failed revocation remains visible and does not pretend sign-out cleanup succeeded", async () => {
    localStorage.setItem("paperclip.push.device", JSON.stringify({ userId: "alice", companyId: "company", subscriptionId: "device-a" }));
    api.remove.mockRejectedValue(new Error("offline"));
    await expect(disableWebPush()).rejects.toThrow("offline"); expect(currentPushBinding()?.userId).toBe("alice");
    expect(unsubscribe).not.toHaveBeenCalled();
  });
  it("account switching removes the old browser subscription without transferring it", async () => {
    localStorage.setItem("paperclip.push.device", JSON.stringify({ userId: "alice", companyId: "company", subscriptionId: "device-a" }));
    await reconcilePushAccount("bob");
    expect(currentPushBinding()).toBeNull(); expect(unsubscribe).toHaveBeenCalledOnce(); expect(api.subscribe).not.toHaveBeenCalled();
  });
  it("a still-valid account binding is unchanged on normal visits", async () => {
    localStorage.setItem("paperclip.push.device", JSON.stringify({ userId: "alice", companyId: "company", subscriptionId: "device-a" }));
    await reconcilePushAccount("alice"); expect(unsubscribe).not.toHaveBeenCalled();
  });
});
