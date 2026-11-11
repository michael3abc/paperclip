import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ codex: vi.fn(), token: vi.fn(), claude: vi.fn(), antigravity: vi.fn() }));
vi.mock("@paperclipai/adapter-codex-local/server", () => ({ fetchCodexRpcQuota: mocks.codex }));
vi.mock("@paperclipai/adapter-claude-local/server", () => ({ readClaudeToken: mocks.token, fetchClaudeQuota: mocks.claude }));
vi.mock("../services/antigravity-quota.js", async (original) => ({
  ...await original<typeof import("../services/antigravity-quota.js")>(), fetchAntigravityQuota: mocks.antigravity,
}));

const window = { label: "7d", usedPercent: 20, resetsAt: null, valueLabel: null };
beforeEach(() => {
  vi.resetModules();
  vi.clearAllMocks();
  vi.stubEnv("PAPERCLIP_HOST_SUBSCRIPTION_QUOTAS", "1");
  mocks.codex.mockResolvedValue({ windows: [window] });
  mocks.token.mockResolvedValue("fixture-token");
  mocks.claude.mockResolvedValue([window]);
  mocks.antigravity.mockResolvedValue([window]);
});
afterEach(() => { vi.unstubAllEnvs(); vi.useRealTimers(); });

describe("host subscription quotas", () => {
  it("reads only selected providers and shares their caches across company selections", async () => {
    const { fetchHostSubscriptionQuotas } = await import("../services/host-subscription-quotas.js");
    const first = await fetchHostSubscriptionQuotas(["openai"]);
    expect(first.map(value => value.provider)).toEqual(["openai"]);
    expect(mocks.token).not.toHaveBeenCalled(); expect(mocks.antigravity).not.toHaveBeenCalled();
    const second = await fetchHostSubscriptionQuotas(["openai", "anthropic"]);
    expect(second[0]).toBe(first[0]); expect(mocks.codex).toHaveBeenCalledTimes(1);
    expect(mocks.claude).toHaveBeenCalledTimes(1); expect(mocks.antigravity).not.toHaveBeenCalled();
  });

  it("does no provider work without explicit opt-in", async () => {
    vi.stubEnv("PAPERCLIP_HOST_SUBSCRIPTION_QUOTAS", "0");
    const { fetchHostSubscriptionQuotas } = await import("../services/host-subscription-quotas.js");
    expect(await fetchHostSubscriptionQuotas(["openai", "anthropic", "antigravity"])).toEqual([]);
    expect(mocks.codex).not.toHaveBeenCalled();
    expect(mocks.token).not.toHaveBeenCalled();
    expect(mocks.antigravity).not.toHaveBeenCalled();
  });

  it("shares simultaneous reads and caches without scheduling idle provider calls", async () => {
    vi.useFakeTimers();
    const { fetchHostSubscriptionQuotas } = await import("../services/host-subscription-quotas.js");
    const [first, second] = await Promise.all([fetchHostSubscriptionQuotas(["openai", "anthropic", "antigravity"]), fetchHostSubscriptionQuotas(["openai", "anthropic", "antigravity"])]);
    expect(first).toEqual(second);
    expect(first.map((value) => value.provider)).toEqual(["openai", "anthropic", "antigravity"]);
    expect(first.every((value) => value.ok && value.source === "host-subscription")).toBe(true);
    await fetchHostSubscriptionQuotas(["openai", "anthropic", "antigravity"]);
    expect(mocks.codex).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(120_000);
    expect(mocks.codex).toHaveBeenCalledTimes(1);
    expect(mocks.antigravity).toHaveBeenCalledTimes(1);
    await fetchHostSubscriptionQuotas(["openai", "anthropic", "antigravity"]);
    expect(mocks.codex).toHaveBeenCalledTimes(2);
  });

  it("keeps one provider failure explicit, without leaking its raw diagnostic or falling back", async () => {
    mocks.codex.mockRejectedValue(new Error("Authorization: Bearer fixture-secret-private /private/auth.json"));
    mocks.token.mockResolvedValue(null);
    const { fetchHostSubscriptionQuotas } = await import("../services/host-subscription-quotas.js");
    const result = await fetchHostSubscriptionQuotas(["openai", "anthropic", "antigravity"]);
    expect(result[0]).toMatchObject({ ok: false, errorFamily: "provider_unavailable", windows: [] });
    expect(result[1]).toMatchObject({ ok: false, errorFamily: "credentials_unavailable", windows: [] });
    expect(result[2].ok).toBe(true);
    expect(JSON.stringify(result)).not.toContain("fixture-secret-private");
    expect(JSON.stringify(result)).not.toContain("/private/");
    expect(mocks.claude).not.toHaveBeenCalled();
    expect(mocks.codex).toHaveBeenCalledTimes(1);
  });

  it("does not start probes under the maintenance drain and tracks actual work", async () => {
    const { fetchHostSubscriptionQuotas } = await import("../services/host-subscription-quotas.js");
    const { startTaskDrain, stopTaskDrain, idleWorkSnapshot } = await import("../services/task-admission.js");
    startTaskDrain({ purpose: "idle", ttlMs: 60_000 });
    expect(() => fetchHostSubscriptionQuotas(["openai", "anthropic", "antigravity"])).toThrow("maintenance");
    expect(mocks.codex).not.toHaveBeenCalled();
    stopTaskDrain();
    let settle!: (value: unknown) => void;
    mocks.codex.mockImplementation(() => new Promise((resolve) => { settle = resolve; }));
    const reading = fetchHostSubscriptionQuotas(["openai", "anthropic", "antigravity"]);
    expect(idleWorkSnapshot().active).toBe(1);
    settle({ windows: [window] });
    await reading;
    expect(idleWorkSnapshot().active).toBe(0);
  });
});
