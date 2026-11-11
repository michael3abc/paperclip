import { and, eq, ne } from "drizzle-orm";
import { agents, type Db } from "@paperclipai/db";
import type { ProviderQuotaResult } from "@paperclipai/shared";
import { getServerAdapter } from "../adapters/registry.js";
import { fetchHostSubscriptionQuotas, hostSubscriptionQuotasEnabled } from "./host-subscription-quotas.js";
import { isIdleTaskDrainActive, trackIdleWork } from "./task-admission.js";

const localProviders: Record<string, string> = { codex_local: "openai", claude_local: "anthropic" };

/** Company selection owns membership; each adapter owns its account/host selection and transport. */
export async function fetchCompanySubscriptionQuotas(db: Db, companyId: string): Promise<ProviderQuotaResult[]> {
  if (!hostSubscriptionQuotasEnabled()) return [];
  if (isIdleTaskDrainActive()) throw new Error("Subscription quota refresh is paused for maintenance.");
  return trackIdleWork((async () => {
    const rows = await db.select({ type: agents.adapterType, config: agents.adapterConfig }).from(agents)
      .where(and(eq(agents.companyId, companyId), ne(agents.status, "terminated")));
    const groups = new Map<string, Record<string, unknown>[]>();
    for (const row of rows) {
      if (!groups.has(row.type)) groups.set(row.type, []);
      groups.get(row.type)!.push(row.config as Record<string, unknown>);
    }
    const results = await Promise.allSettled([...groups].map(async ([type, configs]) => {
      const adapter = getServerAdapter(type);
      if (adapter.getSubscriptionQuotas) {
        return adapter.getSubscriptionQuotas({ configs, fetchLocal: fetchHostSubscriptionQuotas });
      }
      const provider = localProviders[type];
      return provider ? fetchHostSubscriptionQuotas([provider]) : [];
    }));
    // A failed adapter must not release maintenance accounting while a sibling still reads.
    const failed = results.find(result => result.status === "rejected");
    if (failed?.status === "rejected") throw failed.reason;
    const snapshots = results.flatMap(result => result.status === "fulfilled" ? result.value : []);
    const accounts = new Map<string, ProviderQuotaResult>();
    for (const value of snapshots) accounts.set(value.accountKey ?? value.provider, value);
    return [...accounts.values()].sort((a, b) => (a.accountLabel ?? "").localeCompare(b.accountLabel ?? "")
      || a.provider.localeCompare(b.provider));
  })());
}
