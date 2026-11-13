import { describe, expect, it } from "vitest";
import {
  createHostCircuitBreaker,
  hostCircuitKeyForAgent,
  HOST_CIRCUIT_BASE_MS,
  HOST_CIRCUIT_CAP_MS,
  HOST_CIRCUIT_NOTICE_AFTER_MS,
} from "../services/host-circuit-breaker.js";

// Pure unit test with an injected clock; no database, adapter or network.
function clock(start = 1_000_000) {
  let now = start;
  return { now: () => now, advance: (ms: number) => { now += ms; }, at: () => now };
}

describe("host circuit breaker", () => {
  it("opens on a host failure and defers wakes until openUntil, then closes by itself", () => {
    const time = clock();
    const breaker = createHostCircuitBreaker({ now: time.now });
    expect(breaker.openUntil("remote-e")).toBeNull();
    const until = breaker.recordFailure("remote-e", "host_unavailable");
    expect(until?.getTime()).toBe(time.at() + HOST_CIRCUIT_BASE_MS);
    expect(breaker.openUntil("remote-e")?.getTime()).toBe(time.at() + HOST_CIRCUIT_BASE_MS);
    // Other hosts are unaffected.
    expect(breaker.openUntil("remote-d")).toBeNull();
    time.advance(HOST_CIRCUIT_BASE_MS - 1);
    expect(breaker.openUntil("remote-e")).not.toBeNull();
    time.advance(1);
    // Deferral only: once the window passes, dispatch may probe the host again.
    expect(breaker.openUntil("remote-e")).toBeNull();
  });

  it("backs off 30s doubling per consecutive failure and caps at 30 minutes", () => {
    const time = clock();
    const breaker = createHostCircuitBreaker({ now: time.now });
    const delays: number[] = [];
    for (let n = 0; n < 12; n++) {
      const until = breaker.recordFailure("remote-e", n % 2 ? "bridge_unavailable" : "host_unavailable")!;
      delays.push(until.getTime() - time.at());
      time.advance(until.getTime() - time.at());
    }
    expect(delays.slice(0, 7)).toEqual([30_000, 60_000, 120_000, 240_000, 480_000, 960_000, HOST_CIRCUIT_CAP_MS]);
    expect(delays.slice(6).every(delay => delay === HOST_CIRCUIT_CAP_MS)).toBe(true);
    expect(Math.max(...delays)).toBe(HOST_CIRCUIT_CAP_MS);
    expect(breaker.snapshot()).toEqual([expect.objectContaining({ hostId: "remote-e", consecutiveFailures: 12 })]);
  });

  it("ignores non-host failure codes and missing host ids", () => {
    const time = clock();
    const breaker = createHostCircuitBreaker({ now: time.now });
    expect(breaker.recordFailure("remote-e", "configuration_incomplete")).toBeNull();
    expect(breaker.recordFailure("remote-e", "inactivity_timeout")).toBeNull();
    expect(breaker.recordFailure(null, "host_unavailable")).toBeNull();
    expect(breaker.recordFailure("   ", "host_unavailable")).toBeNull();
    expect(breaker.openUntil("remote-e")).toBeNull();
    expect(breaker.snapshot()).toEqual([]);
  });

  it("closes on one success and restarts the backoff from the base delay", () => {
    const time = clock();
    const breaker = createHostCircuitBreaker({ now: time.now });
    breaker.recordFailure("remote-e", "host_unavailable");
    breaker.recordFailure("remote-e", "host_unavailable");
    breaker.recordFailure("remote-e", "host_unavailable");
    expect(breaker.openUntil("remote-e")?.getTime()).toBe(time.at() + 120_000);
    breaker.recordSuccess("remote-e");
    expect(breaker.openUntil("remote-e")).toBeNull();
    expect(breaker.snapshot()).toEqual([]);
    expect(breaker.recordFailure("remote-e", "host_unavailable")?.getTime()).toBe(time.at() + HOST_CIRCUIT_BASE_MS);
  });

  it("allows exactly one notice once the breaker has stayed open for more than an hour", () => {
    const time = clock();
    const breaker = createHostCircuitBreaker({ now: time.now });
    breaker.recordFailure("remote-e", "host_unavailable");
    expect(breaker.takeNotice("remote-e")).toBe(false);
    // Keep failing; the open period is measured from the first failure.
    while (time.at() < 1_000_000 + HOST_CIRCUIT_NOTICE_AFTER_MS) {
      time.advance(HOST_CIRCUIT_CAP_MS / 2);
      expect(breaker.takeNotice("remote-e")).toBe(time.at() - 1_000_000 > HOST_CIRCUIT_NOTICE_AFTER_MS);
      breaker.recordFailure("remote-e", "host_unavailable");
    }
    time.advance(1);
    expect(breaker.takeNotice("remote-e")).toBe(true);
    expect(breaker.takeNotice("remote-e")).toBe(false);
    breaker.recordFailure("remote-e", "host_unavailable");
    expect(breaker.takeNotice("remote-e")).toBe(false);
    // A success ends the open period; a new outage needs another hour for its own notice.
    breaker.recordSuccess("remote-e");
    breaker.recordFailure("remote-e", "host_unavailable");
    time.advance(HOST_CIRCUIT_NOTICE_AFTER_MS);
    expect(breaker.takeNotice("remote-e")).toBe(false);
    time.advance(1);
    expect(breaker.takeNotice("remote-e")).toBe(true);
    expect(breaker.takeNotice("unknown-host")).toBe(false);
  });

  it("keys CC Pocket agents by their configured host and the local Bridge otherwise", () => {
    expect(hostCircuitKeyForAgent({ adapterType: "ccpocket_bridge", adapterConfig: { hostId: "remote-e" } })).toBe("ccpocket_bridge:remote-e");
    expect(hostCircuitKeyForAgent({ adapterType: "ccpocket_bridge", adapterConfig: {} })).toBe("ccpocket_bridge:local");
    expect(hostCircuitKeyForAgent({ adapterType: "codex_local", adapterConfig: {} })).toBeNull();
    expect(hostCircuitKeyForAgent(null)).toBeNull();
  });
});
