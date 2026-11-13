import { execFile } from "node:child_process";
import { readFile } from "node:fs/promises";
import { hostname } from "node:os";
import { promisify } from "node:util";
import type { ProviderQuotaResult } from "@paperclipai/shared";
import { collectHostSubscriptionQuotas } from "./host-subscription-quota-reader.js";
import { isIdleTaskDrainActive, trackIdleWork } from "./task-admission.js";

const execFileAsync = promisify(execFile);
const CACHE_MS = 60_000;
const cached = new Map<string, { expiresAt: number; accounts: ProviderQuotaResult[] }>();
const pending = new Map<string, Promise<ProviderQuotaResult[]>>();
const PROVIDERS = ["openai", "anthropic", "antigravity"];
interface QuotaSource { hostId: string; kind: "local" | "ssh"; sshAlias?: string; readerPath?: string }

export function hostSubscriptionQuotasEnabled(): boolean {
  return process.env.PAPERCLIP_HOST_SUBSCRIPTION_QUOTAS === "1";
}

async function sourceForCompany(companyId: string): Promise<QuotaSource> {
  const file = process.env.PAPERCLIP_HOST_SUBSCRIPTION_QUOTA_SOURCES_FILE;
  if (!file) return { hostId: hostname(), kind: "local" };
  const config = JSON.parse(await readFile(file, "utf8"));
  const source = config.version === 1 && Object.hasOwn(config.companies ?? {}, companyId)
    ? config.companies[companyId] as QuotaSource : undefined;
  if (!source || !/^[a-zA-Z0-9][a-zA-Z0-9_.-]*$/.test(source.hostId)
    || !["local", "ssh"].includes(source.kind)) {
    throw new Error("Subscription quota source is not configured for this company.");
  }
  if (source.kind === "ssh" && (!/^[a-zA-Z0-9][a-zA-Z0-9_.-]*$/.test(source.sshAlias ?? "")
    || !/^\/[a-zA-Z0-9/_.-]+\.mjs$/.test(source.readerPath ?? ""))) {
    throw new Error("Subscription quota SSH source is invalid.");
  }
  return source;
}

async function collectRemote(source: QuotaSource): Promise<ProviderQuotaResult[]> {
  const base = (provider: string) => ({ provider, source: "host-subscription",
    accountKey: `host:${source.hostId}:${provider}`, accountLabel: source.hostId });
  try {
    const { stdout } = await execFileAsync("ssh", ["-T", "-o", "BatchMode=yes", "-o",
      "StrictHostKeyChecking=yes", "-o", "ConnectTimeout=10", source.sshAlias!,
      `/usr/bin/node ${source.readerPath} ${source.hostId}`], { timeout: 45_000, maxBuffer: 128 * 1024 });
    const rows = JSON.parse(stdout) as ProviderQuotaResult[];
    if (!Array.isArray(rows) || rows.length !== PROVIDERS.length) throw new Error("Invalid quota response");
    return PROVIDERS.map(provider => {
      const row = rows.find(value => value.provider === provider);
      if (!row || typeof row.ok !== "boolean" || !Array.isArray(row.windows)
        || !Number.isFinite(Date.parse(row.capturedAt ?? ""))) throw new Error("Invalid quota response");
      if (!row.ok) return { ...base(provider), ok: false, windows: [], capturedAt: row.capturedAt,
        errorFamily: "provider_unavailable", error: "Subscription quota is unavailable on the selected host. Check its CLI login." };
      if (!row.windows.length) throw new Error("Missing quota windows");
      const windows = row.windows.map(window => {
        if (typeof window.label !== "string" || window.label.length > 200
          || (window.usedPercent !== null && (typeof window.usedPercent !== "number"
            || !Number.isFinite(window.usedPercent) || window.usedPercent < 0 || window.usedPercent > 100))
          || (window.resetsAt !== null && !Number.isFinite(Date.parse(window.resetsAt)))
          || (window.valueLabel !== null && typeof window.valueLabel !== "string")
          || (window.detail != null && typeof window.detail !== "string")) throw new Error("Invalid quota window");
        return { label: window.label, usedPercent: window.usedPercent, resetsAt: window.resetsAt,
          valueLabel: window.valueLabel, ...(window.detail != null ? { detail: window.detail } : {}) };
      });
      return { ...base(provider), ok: true, capturedAt: row.capturedAt, windows };
    });
  } catch {
    // SSH diagnostics and provider bodies may contain account details or tokens.
    return PROVIDERS.map(provider => ({ ...base(provider), ok: false, windows: [],
      capturedAt: new Date().toISOString(), errorFamily: "remote_unavailable",
      error: "Could not read subscription quota from the selected host." }));
  }
}

/** Company and source are server-selected after dashboard authorization. */
export async function fetchHostSubscriptionQuotas(companyId: string): Promise<ProviderQuotaResult[]> {
  if (!hostSubscriptionQuotasEnabled()) return [];
  if (isIdleTaskDrainActive()) throw new Error("Subscription quota refresh is paused for maintenance.");
  const source = await sourceForCompany(companyId);
  // Source configuration is asynchronous; maintenance may start during the read.
  if (isIdleTaskDrainActive()) throw new Error("Subscription quota refresh is paused for maintenance.");
  const key = JSON.stringify([companyId, source]);
  const hit = cached.get(key);
  if (hit && hit.expiresAt > Date.now()) return hit.accounts;
  const existing = pending.get(key);
  if (existing) return existing;
  const reading = trackIdleWork(source.kind === "local"
    ? collectHostSubscriptionQuotas(source.hostId) : collectRemote(source)).then(accounts => {
    cached.set(key, { expiresAt: Date.now() + CACHE_MS, accounts });
    return accounts;
  }).finally(() => { pending.delete(key); });
  pending.set(key, reading);
  return reading;
}
