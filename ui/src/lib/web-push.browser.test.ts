// @vitest-environment node
import { readFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { chromium, type Browser, type Page, type Worker } from "@playwright/test";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

/** Real Chromium Service Worker/IndexedDB/Notifications APIs. Push arrival is
 * injected; this is not evidence of APNs or physical iPhone delivery. */
describe("Web Push Service Worker in Chromium", () => {
  let server: Server; let browser: Browser; let page: Page; let worker: Worker; let origin: string;
  const script = readFileSync(new URL("../../public/sw.js", import.meta.url), "utf8");
  let revision = 1;
  beforeAll(async () => {
    server = createServer((req, res) => {
      res.setHeader("Content-Type", req.url === "/sw.js" ? "application/javascript" : "text/html");
      res.end(req.url === "/sw.js" ? script.replace("__PAPERCLIP_BUILD_ID__", `fixture-${revision}`) : "<!doctype html><title>Push fixture</title>");
    });
    await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
    origin = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
    browser = await chromium.launch({ headless: true, channel: "chromium" });
    const context = await browser.newContext();
    await context.grantPermissions(["notifications"], { origin });
    page = await context.newPage(); await page.goto(origin);
    const ready = context.waitForEvent("serviceworker");
    await page.evaluate(async () => { await navigator.serviceWorker.register("/sw.js"); await navigator.serviceWorker.ready; });
    worker = await ready;
    await bind("device-a");
  }, 30_000);
  afterAll(async () => { await browser?.close(); if (server) await new Promise<void>(resolve => server.close(() => resolve())); });
  async function bind(id: string | null) {
    await page.evaluate(async id => {
      const reg = await navigator.serviceWorker.ready;
      await new Promise<void>((resolve, reject) => {
        const c = new MessageChannel(); c.port1.onmessage = e => e.data.ok ? resolve() : reject(new Error("binding failed"));
        reg.active!.postMessage({ type: "paperclip.push.bind", binding: id ? { subscriptionId: id, userId: "alice" } : null }, [c.port2]);
      });
    }, id);
  }
  async function push(payload: Record<string, unknown>) {
    await worker.evaluate(async payload => {
      const event = new Event("push"); let work: Promise<unknown> = Promise.resolve();
      Object.defineProperty(event, "data", { value: { json: () => payload } });
      Object.defineProperty(event, "waitUntil", { value: (promise: Promise<unknown>) => { work = promise; } });
      self.dispatchEvent(event); await work;
    }, payload);
  }
  async function notifications() {
    return page.evaluate(async () => (await (await navigator.serviceWorker.ready).getNotifications()).map(n => ({ title: n.title, body: n.body, tag: n.tag, data: n.data })));
  }
  it("shows a self-contained notification without a protected API fetch", async () => {
    const apiCalls: string[] = []; page.context().on("request", req => { if (req.url().includes("/api/")) apiCalls.push(req.url()); });
    await push({ title: "需要批准", body: "部署方案已準備完成", url: "/PUSH/issues/PUSH-1", tag: "receipt-1", subscriptionId: "device-a" });
    expect(await notifications()).toEqual([{ title: "需要批准", body: "部署方案已準備完成", tag: "paperclip:receipt-1",
      data: { url: `${origin}/PUSH/issues/PUSH-1`, subscriptionId: "device-a" } }]);
    expect(apiCalls).toEqual([]);
  });
  it("uses a stable tag to replace a repeated delivery", async () => {
    await push({ title: "任務完成", body: "完成", url: "/PUSH/issues/PUSH-1", tag: "receipt-1", subscriptionId: "device-a" });
    expect(await notifications()).toHaveLength(1);
  });
  it("ignores another account binding and external click targets", async () => {
    await push({ title: "private", body: "private", url: "/", tag: "bad", subscriptionId: "device-other" });
    await push({ title: "redirect", body: "redirect", url: "//evil.test/", tag: "bad", subscriptionId: "device-a" });
    expect(await notifications()).toHaveLength(1);
  });
  it("navigates to the same-origin task; an untrusted injected click cannot focus", async () => {
    const click = worker.evaluate(async () => {
      const reg = (self as unknown as { registration: ServiceWorkerRegistration }).registration;
      const [notification] = await reg.getNotifications();
      const event = new Event("notificationclick"); let work: Promise<unknown> = Promise.resolve();
      Object.defineProperty(event, "notification", { value: notification });
      Object.defineProperty(event, "waitUntil", { value: (promise: Promise<unknown>) => { work = promise; } });
      self.dispatchEvent(event); await work;
    });
    // A synthetic event has no browser user activation. Assert its exact focus
    // denial after real navigation; physical/trusted-click acceptance is separate.
    await expect(click).rejects.toThrow("Not allowed to focus a window");
    await page.waitForURL(`${origin}/PUSH/issues/PUSH-1`); expect(page.url()).toBe(`${origin}/PUSH/issues/PUSH-1`);
  });
  it("revocation persists in IndexedDB and blocks subsequent old payloads", async () => {
    await bind(null);
    await push({ title: "old", body: "private", url: "/", tag: "old", subscriptionId: "device-a" });
    expect(await notifications()).toHaveLength(0);
  });
  it("a real Service Worker update preserves account binding independently of asset caches", async () => {
    await bind("device-a"); revision++;
    const nextWorker = page.context().waitForEvent("serviceworker");
    await page.evaluate(async () => {
      const changed = new Promise<void>(resolve => navigator.serviceWorker.addEventListener("controllerchange", () => resolve(), { once: true }));
      await (await navigator.serviceWorker.ready).update(); await changed;
    });
    worker = await nextWorker;
    await push({ title: "Updated", body: "Enrollment retained", url: "/PUSH/issues/PUSH-1", tag: "updated", subscriptionId: "device-a" });
    expect((await notifications())[0].body).toBe("Enrollment retained");
    await bind(null); expect(await notifications()).toHaveLength(0);
  });
});
