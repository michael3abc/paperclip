import { EventEmitter } from "node:events";
import { createECDH, randomBytes } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import webpush from "web-push";
import { createWebPushSender } from "../services/web-push-transport.js";

const transport = vi.hoisted(() => ({ request: vi.fn() }));
vi.mock("node:https", async original => ({ ...await original<typeof import("node:https")>(), request: transport.request }));

describe("encrypted Web Push transport", () => {
  const config = { ...webpush.generateVAPIDKeys(), subject: "mailto:operator@example.test" };
  const browserKey = createECDH("prime256v1"); browserKey.generateKeys();
  const subscription = { endpoint: "https://web.push.apple.com/fixture",
    keys: { p256dh: browserKey.getPublicKey().toString("base64url"), auth: randomBytes(16).toString("base64url") } };
  const payload = { title: "Test", body: "private summary", tag: "stable-id", url: "/PUSH/issues/one" };
  let response: { statusCode: number; headers: Record<string, string>; destroy: ReturnType<typeof vi.fn> };
  let body: Buffer | undefined;
  beforeEach(() => {
    response = { statusCode: 201, headers: {}, destroy: vi.fn() }; body = undefined;
    transport.request.mockReset().mockImplementation((_url, _options, callback) => {
      const outgoing = new EventEmitter() as EventEmitter & { end: (value: Buffer) => void };
      outgoing.end = value => { body = value; queueMicrotask(() => callback(response)); };
      return outgoing;
    });
  });
  afterEach(() => vi.useRealTimers());
  it("encrypts the entire payload and uses VAPID authorization", async () => {
    const result = await createWebPushSender(config)(subscription, payload, new AbortController().signal);
    expect(result).toEqual({ statusCode: 201, code: null, retryAfterMs: undefined });
    expect(Buffer.isBuffer(body)).toBe(true); expect(body!.includes(Buffer.from(payload.body))).toBe(false);
    const options = transport.request.mock.calls[0][1];
    expect(options.headers["Content-Encoding"]).toBe("aes128gcm");
    expect(options.headers.Authorization).toMatch(/^vapid /);
    expect(response.destroy).toHaveBeenCalledOnce();
  });
  it("returns redirects as terminal responses without following them", async () => {
    response.statusCode = 302; response.headers.location = "http://127.0.0.1/private";
    expect(await createWebPushSender(config)(subscription, payload, new AbortController().signal)).toMatchObject({ statusCode: 302, code: "push_http_302" });
    expect(transport.request).toHaveBeenCalledOnce();
  });
  it("honors provider Retry-After without retaining response bodies", async () => {
    response.statusCode = 429; response.headers["retry-after"] = "120";
    expect(await createWebPushSender(config)(subscription, payload, new AbortController().signal)).toMatchObject({ statusCode: 429, retryAfterMs: 120000 });
  });
  it("configuration errors are terminal and never reach the network", async () => {
    expect(await createWebPushSender({ ...config, privateKey: "invalid" })(subscription, payload, new AbortController().signal))
      .toEqual({ statusCode: 400, code: "push_configuration_error" });
    expect(transport.request).not.toHaveBeenCalled();
  });
  it("rejects private endpoints before DNS or network access", async () => {
    expect(await createWebPushSender(config)({ ...subscription, endpoint: "https://127.0.0.1/private" }, payload, new AbortController().signal))
      .toEqual({ statusCode: 400, code: "push_invalid_subscription" });
    expect(transport.request).not.toHaveBeenCalled();
  });
  it("cancels an in-flight request without leaking the underlying error", async () => {
    transport.request.mockImplementation((_url, options) => {
      const outgoing = new EventEmitter() as EventEmitter & { end: () => void };
      outgoing.end = () => {};
      options.signal.addEventListener("abort", () => outgoing.emit("error", new Error("private provider response")));
      return outgoing;
    });
    const controller = new AbortController();
    const result = createWebPushSender(config)(subscription, payload, controller.signal); controller.abort();
    expect(await result).toEqual({ statusCode: 0, retryAfterMs: undefined, code: "push_interrupted" });
  });
});
