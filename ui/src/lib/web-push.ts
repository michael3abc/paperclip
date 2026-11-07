import { pushApi } from "../api/push";
const bindingKey = "paperclip.push.device";
let accountGeneration = 0;
let activeAccount: string | null = null;
let enrolling = false;
export interface PushBinding { userId: string; subscriptionId: string; companyId: string; }
export function currentPushBinding(): PushBinding | null {
  const raw = localStorage.getItem(bindingKey);
  if (!raw) return null;
  const value = JSON.parse(raw) as PushBinding;
  if (!value.userId || !value.subscriptionId || !value.companyId) throw new Error("推播裝置資料無效，請停用後重新啟用。");
  return value;
}
export function pushSupportMessage(): string | null {
  if (!window.isSecureContext) return "請從 HTTPS 網址開啟 Paperclip，再啟用推播。";
  const ios = /iPad|iPhone|iPod/.test(navigator.userAgent) || navigator.platform === "MacIntel" && navigator.maxTouchPoints > 1;
  if (ios && !matchMedia("(display-mode: standalone)").matches && !(navigator as Navigator & { standalone?: boolean }).standalone)
    return "請用 Safari 將 Paperclip 加入主畫面，再從主畫面開啟並啟用通知。";
  if (!("serviceWorker" in navigator) || !("PushManager" in window) || !("Notification" in window)) return "此瀏覽器不支援推播通知。";
  if (Notification.permission === "denied") return "通知權限已拒絕；請到系統或瀏覽器設定允許 Paperclip 通知。";
  return null;
}
async function pushRegistration() {
  const registration = await navigator.serviceWorker.getRegistration("/");
  if (!registration?.active) throw new Error("通知服務尚未就緒，請重新整理後再試。");
  return registration;
}
async function bindWorker(registration: ServiceWorkerRegistration, binding: PushBinding | null) {
  await new Promise<void>((resolve, reject) => {
    const channel = new MessageChannel();
    const timer = setTimeout(() => { channel.port1.close(); reject(new Error("通知裝置同步逾時。")); }, 5000);
    channel.port1.onmessage = event => {
      clearTimeout(timer); channel.port1.close();
      if (event.data?.ok) resolve(); else reject(new Error("無法儲存通知裝置設定。"));
    };
    registration.active!.postMessage({ type: "paperclip.push.bind", binding }, [channel.port2]);
  });
}
export async function enableWebPush(userId: string, companyId: string, publicKey: string, name: string) {
  if (enrolling) throw new Error("通知設定處理中，請稍候。");
  const unsupported = pushSupportMessage();
  if (unsupported) throw new Error(unsupported);
  enrolling = true;
  let generation = accountGeneration;
  const assertCurrent = () => {
    if (generation !== accountGeneration) throw new Error("帳號已變更，請重新開啟通知設定。");
  };
  try {
    // Request before network/worker awaits: iOS requires the user's click gesture.
    if (await Notification.requestPermission() !== "granted") throw new Error("尚未允許通知。請在系統設定中允許後再啟用。");
    assertCurrent();
    const registration = await pushRegistration();
    assertCurrent();
    const previous = currentPushBinding();
    if (previous && previous.userId !== userId) { await clearLocalPush(); generation = accountGeneration; }
    let subscription = await registration.pushManager.getSubscription();
    assertCurrent();
    if (subscription && !currentPushBinding()) {
      if (!await subscription.unsubscribe()) throw new Error("無法停用舊訂閱，請稍後再試。");
      subscription = null;
    }
    assertCurrent();
    const bytes = Uint8Array.from(atob(publicKey.replace(/-/g, "+").replace(/_/g, "/")), c => c.charCodeAt(0));
    subscription ??= await registration.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: bytes });
    assertCurrent();
    const json = subscription.toJSON();
    if (!json.endpoint || !json.keys?.auth || !json.keys.p256dh) throw new Error("瀏覽器未提供有效的通知訂閱。");
    const device = await pushApi.subscribe(companyId, userId, { endpoint: json.endpoint,
      keys: { auth: json.keys.auth, p256dh: json.keys.p256dh }, name });
    assertCurrent();
    const binding = { userId, companyId, subscriptionId: device.id };
    await bindWorker(registration, binding);
    if (generation !== accountGeneration) { await clearLocalPush(); assertCurrent(); }
    localStorage.setItem(bindingKey, JSON.stringify(binding));
    return device;
  } finally { enrolling = false; }
}
export async function clearLocalPush() {
  accountGeneration++;
  if (!("serviceWorker" in navigator)) { localStorage.removeItem(bindingKey); return; }
  const registration = await navigator.serviceWorker.getRegistration("/");
  if (registration?.active) {
    await bindWorker(registration, null);
    for (const notification of await registration.getNotifications()) notification.close();
    const subscription = await registration.pushManager.getSubscription();
    if (subscription && !await subscription.unsubscribe()) throw new Error("無法停用此裝置的推播訂閱。");
  }
  localStorage.removeItem(bindingKey);
}
export async function disableWebPush() {
  accountGeneration++;
  const binding = currentPushBinding();
  if (!binding) { if (enrolling) await clearLocalPush(); return; }
  // Revoke on the server while the human session is still valid. If this fails,
  // leave sign-out visibly failed rather than silently retaining delivery.
  await pushApi.remove(binding.companyId, binding.userId, binding.subscriptionId);
  await clearLocalPush();
}
export async function reconcilePushAccount(userId: string) {
  if (activeAccount !== userId) { activeAccount = userId; accountGeneration++; }
  const binding = currentPushBinding();
  if (binding && binding.userId !== userId) await clearLocalPush();
}
