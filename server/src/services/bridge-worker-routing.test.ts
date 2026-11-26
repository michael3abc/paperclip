import { describe, expect, it } from "vitest";
import { bridgeWorkerCapacities, bridgeWorkerCapacity, bridgeWorkerSupportsHost, resolveBridgeWorkerRoute } from "./bridge-worker-routing.js";

const worker = { adapterType: "ccpocket_bridge", adapterConfig: { provider: "codex", hostId: "remote-host-a" },
  runtimeConfig: { bridgeWorkerHostCapacity: { "remote-host-b": 4, "remote-host-a": 4 } } };
const overrides = (host: string, provider = "codex") => ({ adapterConfig: { model: `${host}/${provider}/model` } });

describe("shared Bridge worker routes", () => {
  it("keeps fixed workers unchanged and requires explicit valid opt-in", () => {
    const fixed = { ...worker, runtimeConfig: {} };
    expect(resolveBridgeWorkerRoute(fixed, null)).toBeNull();
    expect(bridgeWorkerSupportsHost(fixed, "remote-host-b")).toBe(false);
    expect(bridgeWorkerSupportsHost(worker, "remote-host-b")).toBe(true);
    for (const value of [{}, { d: 0 }, { d: 1.5 }, { d: "4" }]) {
      expect(() => bridgeWorkerCapacities({ ...worker, runtimeConfig: { bridgeWorkerHostCapacity: value } })).toThrow();
    }
    expect(() => bridgeWorkerCapacities({ ...worker, adapterConfig: { ...worker.adapterConfig, role: "main" } })).toThrow();
  });
  it("preserves the full selector and prevents cross-host/provider resume or default substitution", () => {
    const d = resolveBridgeWorkerRoute(worker, overrides("remote-host-b"))!;
    expect(d).toEqual({ hostId: "remote-host-b", provider: "codex", model: "remote-host-b/codex/model" });
    expect(resolveBridgeWorkerRoute(worker, overrides("remote-host-b"), d)).toEqual(d);
    for (const config of [null, overrides("controller-host"), overrides("remote-host-b", "claude"), { adapterConfig: { model: "model" } },
      { adapterConfig: { model: d.model, hostId: "remote-host-a" } }]) expect(() => resolveBridgeWorkerRoute(worker, config)).toThrow();
    expect(() => resolveBridgeWorkerRoute(worker, overrides("remote-host-a"), d)).toThrow("original");
    expect(() => resolveBridgeWorkerRoute(worker, { adapterConfig: { model: "remote-host-b/claude/model" } }, d)).toThrow();
    // Same host and provider: a model change (e.g. to its family route) is accepted and re-pinned.
    expect(resolveBridgeWorkerRoute(worker, { adapterConfig: { model: "remote-host-b/codex/family:gpt-6-astra" } }, d))
      .toEqual({ hostId: "remote-host-b", provider: "codex", model: "remote-host-b/codex/family:gpt-6-astra" });
    expect(() => resolveBridgeWorkerRoute(worker, overrides("remote-host-b"), {})).toThrow("original");
  });
  it("keeps independent host capacity; a full D lane leaves all E slots available", () => {
    const d = resolveBridgeWorkerRoute(worker, overrides("remote-host-b"))!;
    const e = resolveBridgeWorkerRoute(worker, overrides("remote-host-a"))!;
    const capacity = bridgeWorkerCapacity(bridgeWorkerCapacities(worker)!, [d, d, d, d]);
    expect(capacity.hasRoom(d)).toBe(false);
    for (let i = 0; i < 4; i++) { expect(capacity.hasRoom(e)).toBe(true); capacity.take(e); }
    expect(capacity.hasRoom(e)).toBe(false);
    expect(bridgeWorkerCapacity({ "remote-host-b": 1, "remote-host-a": 1 }, [null]).hasRoom(e)).toBe(false);
  });
});
