import { hostname } from "node:os";
import type { ProviderQuotaResult, QuotaWindow } from "@paperclipai/shared";
import { fetchCodexRpcQuota } from "@paperclipai/adapter-codex-local/server";
import { fetchClaudeQuota, readClaudeToken } from "@paperclipai/adapter-claude-local/server";
import { fetchAntigravityQuota, HostQuotaError } from "./antigravity-quota.js";
import { isIdleTaskDrainActive, trackIdleWork } from "./task-admission.js";

const CACHE_MS = 60_000;
const cached = new Map<string, { expiresAt: number; account: ProviderQuotaResult }>();
const pending = new Map<string, Promise<ProviderQuotaResult>>();

/** Explicit operator opt-in, separate from all managed AI connections. */
export function hostSubscriptionQuotasEnabled(): boolean {
  return process.env.PAPERCLIP_HOST_SUBSCRIPTION_QUOTAS === "1";
}

function collect(providers: readonly string[]): Promise<ProviderQuotaResult[]> {
  const host = hostname();
  const sources: { provider: string; read: (signal: AbortSignal) => Promise<QuotaWindow[]> }[] = [
    { provider: "openai", read: async () => (await fetchCodexRpcQuota()).windows },
    { provider: "anthropic", read: async (signal) => {
      const token = await readClaudeToken();
      if (!token) throw new HostQuotaError("credentials_unavailable", "Claude is not logged in on this host, or its login has expired.");
      return fetchClaudeQuota(token, signal);
    } },
    { provider: "antigravity", read: fetchAntigravityQuota },
  ];
  const selected = [...new Set(providers)].map(provider => {
    const source = sources.find(value => value.provider === provider);
    if (!source) throw new Error("Unsupported subscription quota provider");
    return source;
  });
  return Promise.all(selected.map(({ provider, read }): Promise<ProviderQuotaResult> => {
    const previous = cached.get(provider);
    if (previous && previous.expiresAt > Date.now()) return Promise.resolve(previous.account);
    const inflight = pending.get(provider);
    if (inflight) return inflight;
    const reading = (async (): Promise<ProviderQuotaResult> => {
      const base = { provider, source: "host-subscription", accountKey: "host:" + host + ":" + provider, accountLabel: host };
      try {
        const windows = await read(AbortSignal.timeout(20_000));
        if (!windows.length) throw new HostQuotaError("quota_not_reported", "The provider did not report subscription quota.");
        return { ...base, ok: true, windows, capturedAt: new Date().toISOString() };
      } catch (error) {
        // Raw CLI/HTTP errors can include credentials, paths or account details.
        // Neither responses nor logs receive their message or provider body.
        const family = error instanceof HostQuotaError ? error.family
          : (error as NodeJS.ErrnoException)?.code === "ENOENT" ? "credentials_unavailable" : "provider_unavailable";
        return { ...base, ok: false, errorFamily: family, windows: [], capturedAt: new Date().toISOString(),
          error: error instanceof HostQuotaError ? error.message : "Subscription quota is unavailable. Check the provider's CLI login and usage page." };
      }
    })().then(account => {
      cached.set(provider, { expiresAt: Date.now() + CACHE_MS, account });
      return account;
    }).finally(() => { pending.delete(provider); });
    pending.set(provider, reading);
    return reading;
  }));
}

/** Only an authorized dashboard request triggers work. No idle timers/polling. */
export function fetchHostSubscriptionQuotas(providers: readonly string[]): Promise<ProviderQuotaResult[]> {
  if (!hostSubscriptionQuotasEnabled()) return Promise.resolve([]);
  if (isIdleTaskDrainActive()) throw new Error("Subscription quota refresh is paused for maintenance.");
  return trackIdleWork(collect(providers));
}
