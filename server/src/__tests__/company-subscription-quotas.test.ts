import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Db } from "@paperclipai/db";
import { PgDialect } from "drizzle-orm/pg-core";
const mocks = vi.hoisted(() => ({ rows: vi.fn(), adapter: vi.fn(), local: vi.fn(), remote: vi.fn() }));
vi.mock("../adapters/registry.js", () => ({ getServerAdapter: mocks.adapter }));
vi.mock("../services/host-subscription-quotas.js", () => ({ fetchHostSubscriptionQuotas: mocks.local, hostSubscriptionQuotasEnabled: () => process.env.PAPERCLIP_HOST_SUBSCRIPTION_QUOTAS === "1" }));
const db = { select: () => ({ from: () => ({ where: mocks.rows }) }) } as unknown as Db;
beforeEach(() => {
  vi.resetModules(); vi.clearAllMocks(); vi.stubEnv("PAPERCLIP_HOST_SUBSCRIPTION_QUOTAS", "1");
  mocks.rows.mockResolvedValue([{ type: "ccpocket_bridge", config: { hostId: "remote" } }]);
  mocks.adapter.mockReturnValue({ getSubscriptionQuotas: mocks.remote });
  mocks.remote.mockResolvedValue([{ provider: "openai", accountKey: "remote:openai", accountLabel: "remote", ok: true, windows: [] }]);
});
afterEach(() => vi.unstubAllEnvs());
describe("company subscription quotas", () => {
  it("does no company or provider work without opt-in", async () => {
    vi.stubEnv("PAPERCLIP_HOST_SUBSCRIPTION_QUOTAS", "0");
    const { fetchCompanySubscriptionQuotas } = await import("../services/company-subscription-quotas.js");
    expect(await fetchCompanySubscriptionQuotas(db, "company")).toEqual([]);
    expect(mocks.rows).not.toHaveBeenCalled(); expect(mocks.local).not.toHaveBeenCalled();
  });
  it("passes only the selected company's configs to the adapter without reading local accounts", async () => {
    const { fetchCompanySubscriptionQuotas } = await import("../services/company-subscription-quotas.js");
    const result = await fetchCompanySubscriptionQuotas(db, "company");
    expect(mocks.remote).toHaveBeenCalledWith({ configs: [{ hostId: "remote" }], fetchLocal: mocks.local });
    expect(result[0].accountLabel).toBe("remote"); expect(mocks.local).not.toHaveBeenCalled();
    const query = new PgDialect().sqlToQuery(mocks.rows.mock.calls[0][0]);
    expect(query.sql).toContain('company_id'); expect(query.sql).toContain('status');
    expect(query.params).toEqual(["company", "terminated"]);
  });
  it("coalesces configs by adapter and preserves separate host accounts", async () => {
    mocks.rows.mockResolvedValue([{ type: "ccpocket_bridge", config: { hostId: "a" } }, { type: "ccpocket_bridge", config: { hostId: "b" } }]);
    mocks.remote.mockResolvedValue([{ provider: "openai", accountKey: "a", ok: true, windows: [] }, { provider: "openai", accountKey: "b", ok: false, windows: [] }]);
    const { fetchCompanySubscriptionQuotas } = await import("../services/company-subscription-quotas.js");
    expect(await fetchCompanySubscriptionQuotas(db, "company")).toHaveLength(2); expect(mocks.remote).toHaveBeenCalledTimes(1);
  });
  it("returns empty for a company with no configured agents", async () => {
    mocks.rows.mockResolvedValue([]);
    const { fetchCompanySubscriptionQuotas } = await import("../services/company-subscription-quotas.js");
    expect(await fetchCompanySubscriptionQuotas(db, "empty")).toEqual([]); expect(mocks.adapter).not.toHaveBeenCalled();
  });
  it("reads only the selected local provider for built-in local agents", async () => {
    mocks.rows.mockResolvedValue([{ type: "codex_local", config: {} }]);
    mocks.adapter.mockReturnValue({}); mocks.local.mockResolvedValue([]);
    const { fetchCompanySubscriptionQuotas } = await import("../services/company-subscription-quotas.js");
    await fetchCompanySubscriptionQuotas(db, "company");
    expect(mocks.local).toHaveBeenCalledWith(["openai"]);
    expect(mocks.remote).not.toHaveBeenCalled();
  });
  it("surfaces adapter configuration failures without probing a local fallback", async () => {
    mocks.remote.mockRejectedValue(new Error("Unknown configured host"));
    const { fetchCompanySubscriptionQuotas } = await import("../services/company-subscription-quotas.js");
    await expect(fetchCompanySubscriptionQuotas(db, "company")).rejects.toThrow("Unknown configured host");
    expect(mocks.local).not.toHaveBeenCalled();
  });
  it("retains a remote read under maintenance accounting until actual settlement", async () => {
    let resolve!: (value: unknown[]) => void;
    mocks.remote.mockReturnValue(new Promise(r => { resolve = r; }));
    const { fetchCompanySubscriptionQuotas } = await import("../services/company-subscription-quotas.js");
    const { startTaskDrain, stopTaskDrain, idleWorkSnapshot } = await import("../services/task-admission.js");
    const reading = fetchCompanySubscriptionQuotas(db, "company");
    await vi.waitFor(() => expect(mocks.remote).toHaveBeenCalled());
    expect(idleWorkSnapshot().active).toBe(1);
    startTaskDrain({ purpose: "idle", ttlMs: 60000 });
    try { await expect(fetchCompanySubscriptionQuotas(db, "company")).rejects.toThrow("maintenance"); } finally { stopTaskDrain(); }
    resolve([]); await reading; expect(idleWorkSnapshot().active).toBe(0);
  });
  it("retains sibling reads under maintenance accounting after an adapter fails", async () => {
    mocks.rows.mockResolvedValue([{ type: "bad", config: {} }, { type: "ccpocket_bridge", config: {} }]);
    let resolve!: (value: unknown[]) => void;
    mocks.adapter.mockImplementation(type => ({ getSubscriptionQuotas: type === "bad"
      ? async () => { throw new Error("Invalid host"); }
      : () => new Promise(r => { resolve = r; }) }));
    const { fetchCompanySubscriptionQuotas } = await import("../services/company-subscription-quotas.js");
    const { idleWorkSnapshot } = await import("../services/task-admission.js");
    const reading = fetchCompanySubscriptionQuotas(db, "company");
    const failed = expect(reading).rejects.toThrow("Invalid host");
    await vi.waitFor(() => expect(resolve).toBeTypeOf("function"));
    expect(idleWorkSnapshot().active).toBe(1);
    resolve([]); await failed; expect(idleWorkSnapshot().active).toBe(0);
  });
});
