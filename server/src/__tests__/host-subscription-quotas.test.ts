import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ codex: vi.fn(), token: vi.fn(), claude: vi.fn(), antigravity: vi.fn(), ssh: vi.fn() }));
vi.mock("node:child_process", async (original) => {
  const actual = await original<typeof import("node:child_process")>();
  const execFile = Object.assign(vi.fn(), { [Symbol.for("nodejs.util.promisify.custom")]: mocks.ssh });
  return { ...actual, execFile };
});
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
  vi.stubEnv("PAPERCLIP_HOST_SUBSCRIPTION_QUOTA_SOURCES_FILE", "");
  mocks.codex.mockResolvedValue({ windows: [window] });
  mocks.token.mockResolvedValue("fixture-token");
  mocks.claude.mockResolvedValue([window]);
  mocks.antigravity.mockResolvedValue([window]);
});
afterEach(() => { vi.unstubAllEnvs(); vi.useRealTimers(); });

describe("host subscription quotas", () => {
  it("does no provider work without explicit opt-in", async () => {
    vi.stubEnv("PAPERCLIP_HOST_SUBSCRIPTION_QUOTAS", "0");
    const { fetchHostSubscriptionQuotas } = await import("../services/host-subscription-quotas.js");
    expect(await fetchHostSubscriptionQuotas("home")).toEqual([]);
    expect(mocks.codex).not.toHaveBeenCalled();
    expect(mocks.token).not.toHaveBeenCalled();
    expect(mocks.antigravity).not.toHaveBeenCalled();
  });

  it("shares simultaneous reads and caches without scheduling idle provider calls", async () => {
    vi.useFakeTimers();
    const { fetchHostSubscriptionQuotas } = await import("../services/host-subscription-quotas.js");
    const [first, second] = await Promise.all([fetchHostSubscriptionQuotas("home"), fetchHostSubscriptionQuotas("home")]);
    expect(first).toBe(second);
    expect(first.map((value) => value.provider)).toEqual(["openai", "anthropic", "antigravity"]);
    expect(first.every((value) => value.ok && value.source === "host-subscription")).toBe(true);
    await fetchHostSubscriptionQuotas("home");
    expect(mocks.codex).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(120_000);
    expect(mocks.codex).toHaveBeenCalledTimes(1);
    expect(mocks.antigravity).toHaveBeenCalledTimes(1);
    await fetchHostSubscriptionQuotas("home");
    expect(mocks.codex).toHaveBeenCalledTimes(2);
  });

  it("keeps one provider failure explicit, without leaking its raw diagnostic or falling back", async () => {
    mocks.codex.mockRejectedValue(new Error("Authorization: Bearer fixture-secret-private /private/auth.json"));
    mocks.token.mockResolvedValue(null);
    const { fetchHostSubscriptionQuotas } = await import("../services/host-subscription-quotas.js");
    const result = await fetchHostSubscriptionQuotas("home");
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
    await expect(fetchHostSubscriptionQuotas("home")).rejects.toThrow("maintenance");
    expect(mocks.codex).not.toHaveBeenCalled();
    stopTaskDrain();
    const interrupted = fetchHostSubscriptionQuotas("home");
    startTaskDrain({ purpose: "idle", ttlMs: 60_000 });
    await expect(interrupted).rejects.toThrow("maintenance");
    expect(mocks.codex).not.toHaveBeenCalled();
    stopTaskDrain();
    let settle!: (value: unknown) => void;
    mocks.codex.mockImplementation(() => new Promise((resolve) => { settle = resolve; }));
    const reading = fetchHostSubscriptionQuotas("home");
    await vi.waitFor(() => expect(idleWorkSnapshot().active).toBe(1));
    settle({ windows: [window] });
    await reading;
    expect(idleWorkSnapshot().active).toBe(0);
  });
});

describe("company quota sources", () => {
  let directory: string;
  let config: string;
  const local = { kind: "local", hostId: "michael-server" };
  const remote = { kind: "ssh", hostId: "shopee-e", sshAlias: "Shopee-E", readerPath: "/home/yoyo/runtimes/quota/reader.mjs" };
  const rows = () => ["openai", "anthropic", "antigravity"].map(provider => ({ provider, ok: true, windows: [window], capturedAt: new Date().toISOString() }));
  beforeEach(async () => {
    directory = await mkdtemp(path.join(tmpdir(), "quota-source-"));
    config = path.join(directory, "sources.json");
    await writeFile(config, JSON.stringify({ version: 1, companies: { home: local, shopee: remote, other: remote } }));
    vi.stubEnv("PAPERCLIP_HOST_SUBSCRIPTION_QUOTA_SOURCES_FILE", config);
    mocks.ssh.mockResolvedValue({ stdout: JSON.stringify(rows()) });
  });
  afterEach(async () => { await rm(directory, { recursive: true, force: true }); });

  it("keeps local and remote accounts, pending reads and caches company-scoped", async () => {
    const { fetchHostSubscriptionQuotas: read } = await import("../services/host-subscription-quotas.js");
    const [home, shopee, shared] = await Promise.all([read("home"), read("shopee"), read("shopee")]);
    expect(home.every(row => row.accountLabel === "michael-server")).toBe(true);
    expect(shopee).toBe(shared);
    expect(shopee.every(row => row.accountLabel === "shopee-e" && row.accountKey?.startsWith("host:shopee-e:"))).toBe(true);
    expect(mocks.ssh).toHaveBeenCalledTimes(1);
    expect(mocks.ssh.mock.calls[0][1]).toContain("Shopee-E");
    await read("shopee");
    expect(mocks.ssh).toHaveBeenCalledTimes(1);
    await read("other");
    expect(mocks.ssh).toHaveBeenCalledTimes(2);
    expect(mocks.codex).toHaveBeenCalledTimes(1);
  });

  it("never falls back to local accounts or exposes remote diagnostics", async () => {
    mocks.ssh.mockRejectedValue(new Error("Authorization: Bearer private-secret /private/credentials"));
    const { fetchHostSubscriptionQuotas: read } = await import("../services/host-subscription-quotas.js");
    const result = await read("shopee");
    expect(result.every(row => !row.ok && row.accountLabel === "shopee-e" && row.errorFamily === "remote_unavailable")).toBe(true);
    expect(JSON.stringify(result)).not.toContain("private-secret");
    expect(mocks.codex).not.toHaveBeenCalled();
    expect(mocks.token).not.toHaveBeenCalled();
  });

  it("rejects unconfigured companies and unsafe SSH coordinates before probing", async () => {
    const { fetchHostSubscriptionQuotas: read } = await import("../services/host-subscription-quotas.js");
    await expect(read("foreign")).rejects.toThrow("not configured");
    await writeFile(config, JSON.stringify({ version: 1, companies: { shopee: { ...remote, readerPath: "/tmp/reader.mjs; uname" } } }));
    await expect(read("shopee")).rejects.toThrow("invalid");
    expect(mocks.ssh).not.toHaveBeenCalled();
    expect(mocks.codex).not.toHaveBeenCalled();
  });

  it("does not reuse an old source snapshot after configuration changes", async () => {
    const { fetchHostSubscriptionQuotas: read } = await import("../services/host-subscription-quotas.js");
    await read("shopee");
    await writeFile(config, JSON.stringify({ version: 1, companies: { shopee: local } }));
    const result = await read("shopee");
    expect(result.every(row => row.accountLabel === "michael-server")).toBe(true);
    expect(mocks.codex).toHaveBeenCalledTimes(1);
  });

  it("retains per-provider failures while stripping untrusted remote fields", async () => {
    const data = rows();
    data[1] = { ...data[1], ok: false, windows: [], error: "private-secret" } as typeof data[1];
    mocks.ssh.mockResolvedValue({ stdout: JSON.stringify(data) });
    const { fetchHostSubscriptionQuotas: read } = await import("../services/host-subscription-quotas.js");
    const result = await read("shopee");
    expect(result.map(row => row.ok)).toEqual([true, false, true]);
    expect(JSON.stringify(result)).not.toContain("private-secret");
  });

  it("surfaces malformed remote quota windows instead of showing them", async () => {
    const data = rows(); data[0].windows[0] = { ...window, usedPercent: 150 };
    mocks.ssh.mockResolvedValue({ stdout: JSON.stringify(data) });
    const { fetchHostSubscriptionQuotas: read } = await import("../services/host-subscription-quotas.js");
    expect((await read("shopee")).every(row => !row.ok)).toBe(true);
  });
});
