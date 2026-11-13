import { hostname } from "node:os";
import type { ProviderQuotaResult, QuotaWindow } from "@paperclipai/shared";
import { fetchCodexRpcQuota } from "@paperclipai/adapter-codex-local/server";
import { fetchClaudeQuota, readClaudeToken } from "@paperclipai/adapter-claude-local/server";
import { fetchAntigravityQuota, HostQuotaError } from "./antigravity-quota.js";

export async function collectHostSubscriptionQuotas(host = hostname()): Promise<ProviderQuotaResult[]> {
  const sources: { provider: string; read: (signal: AbortSignal) => Promise<QuotaWindow[]> }[] = [
    { provider: "openai", read: async () => (await fetchCodexRpcQuota()).windows },
    { provider: "anthropic", read: async (signal) => {
      const token = await readClaudeToken();
      if (!token) throw new HostQuotaError("credentials_unavailable", "Claude is not logged in on this host, or its login has expired.");
      return fetchClaudeQuota(token, signal);
    } },
    { provider: "antigravity", read: fetchAntigravityQuota },
  ];
  return Promise.all(sources.map(async ({ provider, read }): Promise<ProviderQuotaResult> => {
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
  }));
}

