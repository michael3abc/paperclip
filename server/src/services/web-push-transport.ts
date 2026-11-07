import { createECDH, ECDH } from "node:crypto";
import { readFileSync, statSync } from "node:fs";
import { Agent, request } from "node:https";
import { lookup } from "node:dns";
import { isIP } from "node:net";
import webpush from "web-push";
import { z } from "zod";
import type { PushPayload, PushSubscriptionInput } from "@paperclipai/shared";

const configSchema = z.object({ publicKey: z.string(), privateKey: z.string(), subject: z.string().url() }).strict();
export type WebPushConfig = z.infer<typeof configSchema>;
let cached: { path: string; value: WebPushConfig } | undefined;
export function loadWebPushConfig(): WebPushConfig | null {
  const path = process.env.PAPERCLIP_WEB_PUSH_CONFIG_FILE;
  if (!path) return null;
  if (cached?.path === path) return cached.value;
  try {
    const stat = statSync(path);
    if (!stat.isFile() || (stat.mode & 0o077) !== 0 || stat.size > 8192) throw new Error();
    const config = configSchema.parse(JSON.parse(readFileSync(path, "utf8")));
    const key = createECDH("prime256v1");
    key.setPrivateKey(Buffer.from(config.privateKey, "base64url"));
    if (key.getPublicKey().toString("base64url") !== config.publicKey) throw new Error();
    if (!/^(https:|mailto:)/.test(config.subject)) throw new Error();
    cached = { path, value: config };
    return config;
  } catch { throw new Error("Invalid Web Push configuration; check the private config file and permissions (0600)"); }
}

export function validatePushEndpoint(endpoint: string) {
  const url = new URL(endpoint);
  const allowed = url.hostname === "web.push.apple.com" || url.hostname.endsWith(".push.apple.com") ||
    url.hostname === "fcm.googleapis.com" || url.hostname === "updates.push.services.mozilla.com";
  if (url.protocol !== "https:" || url.port || url.username || url.password || url.hash || !allowed) {
    throw new Error("Unsupported push service endpoint");
  }
}
export function validatePushSubscription(subscription: Pick<PushSubscriptionInput, "endpoint" | "keys">) {
  validatePushEndpoint(subscription.endpoint);
  try {
    const key = Buffer.from(subscription.keys.p256dh, "base64url");
    if (key.length !== 65 || Buffer.from(subscription.keys.auth, "base64url").length !== 16) throw new Error();
    ECDH.convertKey(key, "prime256v1");
  } catch { throw new Error("Invalid push subscription encryption keys"); }
}

export function isPublicPushAddress(address: string): boolean {
  if (isIP(address) === 4) {
    const [a, b] = address.split(".").map(Number);
    return !(a === 0 || a === 10 || a === 127 || a >= 224 || a === 169 && b === 254 ||
      a === 172 && b >= 16 && b <= 31 || a === 192 && b === 168 || a === 100 && b >= 64 && b <= 127 ||
      a === 198 && [18, 19].includes(b));
  }
  // Only global unicast IPv6. In particular exclude mapped IPv4 and local ranges.
  return isIP(address) === 6 && /^[23][0-9a-f]{3}:/i.test(address);
}

export type PushSendResult = { statusCode: number; retryAfterMs?: number; code: string | null };
export type PushSender = (subscription: Pick<PushSubscriptionInput, "endpoint" | "keys">,
  payload: PushPayload, signal: AbortSignal, ttlSeconds?: number) => Promise<PushSendResult>;
export function createWebPushSender(config: WebPushConfig): PushSender {
  return async (subscription, payload, signal, ttlSeconds = 3600) => {
    try { validatePushSubscription(subscription); }
    catch { return { statusCode: 400, code: "push_invalid_subscription" }; }
    const agent = new Agent({ keepAlive: false, lookup: ((hostname: string, options: object, callback: Function) => {
      lookup(hostname, { ...options, all: true }, (error, addresses) => {
        if (error || !addresses.length || addresses.some(a => !isPublicPushAddress(a.address))) {
          callback(new Error("Push endpoint DNS rejected")); return;
        }
        if ((options as { all?: boolean }).all) callback(null, addresses);
        else callback(null, addresses[0].address, addresses[0].family);
      });
    }) as typeof lookup });
    try {
      signal.throwIfAborted();
      let details: ReturnType<typeof webpush.generateRequestDetails>;
      try {
        details = webpush.generateRequestDetails(subscription, JSON.stringify(payload), {
          vapidDetails: config, contentEncoding: "aes128gcm", TTL: Math.max(0, Math.min(3600, Math.floor(ttlSeconds))),
        });
      } catch { return { statusCode: 400, code: "push_configuration_error" }; }
      // Native request does not follow redirects. Abort covers DNS, connection,
      // TLS and response time, not just a socket's inactivity timeout.
      return await new Promise<PushSendResult>((resolve, reject) => {
        const outgoing = request(details.endpoint, { method: details.method, headers: details.headers, agent,
          signal: AbortSignal.any([signal, AbortSignal.timeout(10_000)]) }, response => {
          const statusCode = response.statusCode ?? 0;
          const retry = response.headers["retry-after"];
          const delay = retry ? (/^\d+$/.test(retry) ? Number(retry) * 1000 : Date.parse(retry) - Date.now()) : undefined;
          // Neither collect nor log the provider's response body.
          response.destroy();
          resolve({ statusCode, code: statusCode >= 200 && statusCode < 300 ? null : `push_http_${statusCode}`,
            retryAfterMs: Number.isFinite(delay) ? Math.max(0, delay!) : undefined });
        });
        outgoing.on("error", reject);
        outgoing.end(details.body);
      });
    } catch (error) {
      const e = error as { statusCode?: number; headers?: Record<string, string>; code?: string };
      const retry = e.headers?.["retry-after"];
      const retryAfterMs = retry ? (/^\d+$/.test(retry) ? Number(retry) * 1000 : Date.parse(retry) - Date.now()) : undefined;
      // Provider errors contain endpoint/key/payload details. Never retain them.
      return { statusCode: e.statusCode ?? 0, retryAfterMs: Number.isFinite(retryAfterMs) ? Math.max(0, retryAfterMs!) : undefined,
        code: e.statusCode ? `push_http_${e.statusCode}` : signal.aborted ? "push_interrupted" : "push_network_error" };
    } finally {
      agent.destroy();
    }
  };
}
