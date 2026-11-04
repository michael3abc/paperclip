import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const execFileSyncMock = vi.hoisted(() => vi.fn());

vi.mock("node:child_process", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:child_process")>();
  return { ...actual, execFileSync: execFileSyncMock };
});

const missingConfigPath = path.join(os.tmpdir(), `paperclip-tailnet-probe-config-${process.pid}.json`);

function useTailnetConfigEnvironment() {
  vi.stubEnv("PAPERCLIP_CONFIG", missingConfigPath);
  vi.stubEnv("PAPERCLIP_PUBLIC_URL", "");
  vi.stubEnv("PAPERCLIP_AUTH_PUBLIC_BASE_URL", "");
  vi.stubEnv("BETTER_AUTH_URL", "");
  vi.stubEnv("BETTER_AUTH_BASE_URL", "");
  vi.stubEnv("PAPERCLIP_AUTH_BASE_URL_MODE", "");
  // bind=tailnet is only valid for authenticated/private deployments.
  vi.stubEnv("PAPERCLIP_DEPLOYMENT_MODE", "authenticated");
  vi.stubEnv("BETTER_AUTH_SECRET", "tailnet-probe-test-secret");
  vi.stubEnv("PAPERCLIP_DEPLOYMENT_EXPOSURE", "private");
  vi.stubEnv("PAPERCLIP_BIND", "tailnet");
  vi.stubEnv("PAPERCLIP_BIND_HOST", "");
  vi.stubEnv("HOST", "127.0.0.1");
  vi.stubEnv("PAPERCLIP_TAILNET_BIND_HOST", "");
}

function tailscaleCalls() {
  return execFileSyncMock.mock.calls.filter(([command]) => command === "tailscale");
}

beforeEach(() => {
  vi.resetModules();
  execFileSyncMock.mockReset();
  execFileSyncMock.mockImplementation((command: string) => {
    if (command === "tailscale") return "100.64.0.9\n";
    throw new Error(`unexpected execFileSync(${command})`);
  });
});

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("tailnet bind host detection", () => {
  it("probes tailscale once per process instead of on every loadConfig()", async () => {
    useTailnetConfigEnvironment();
    const { loadConfig } = await import("../config.js");

    const first = loadConfig();
    loadConfig();
    const third = loadConfig();

    expect(first.host).toBe("100.64.0.9");
    expect(third.host).toBe("100.64.0.9");
    expect(tailscaleCalls()).toHaveLength(1);
  });

  it("caches a failed probe instead of respawning tailscale", async () => {
    useTailnetConfigEnvironment();
    vi.stubEnv("PAPERCLIP_BIND", "loopback");
    execFileSyncMock.mockImplementation(() => {
      throw Object.assign(new Error("spawn tailscale ENOENT"), { code: "ENOENT" });
    });
    const { loadConfig } = await import("../config.js");

    loadConfig();
    loadConfig();

    expect(tailscaleCalls()).toHaveLength(1);
  });

  it("honors PAPERCLIP_TAILNET_BIND_HOST on every call without probing", async () => {
    useTailnetConfigEnvironment();
    vi.stubEnv("PAPERCLIP_TAILNET_BIND_HOST", "100.100.0.1");
    const { loadConfig } = await import("../config.js");

    expect(loadConfig().host).toBe("100.100.0.1");
    vi.stubEnv("PAPERCLIP_TAILNET_BIND_HOST", "100.100.0.2");
    expect(loadConfig().host).toBe("100.100.0.2");
    expect(tailscaleCalls()).toHaveLength(0);
  });
});
