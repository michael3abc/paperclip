import { describe, expect, it } from "vitest";
import { bridgeWorkerCapacities, bridgeWorkerCapacity, bridgeWorkerSupportsHost, resolveBridgeWorkerRoute } from "./bridge-worker-routing.js";

const worker = { adapterType: "ccpocket_bridge", adapterConfig: { provider: "codex", hostId: "shopee-e" },
  runtimeConfig: { bridgeWorkerHostCapacity: { "shopee-d": 4, "shopee-e": 4 } } };
const overrides = (host: string, provider = "codex") => ({ adapterConfig: { model: `${host}/${provider}/model` } });

describe("shared Bridge worker routes", () => {
  it("keeps fixed workers unchanged and requires explicit valid opt-in", () => {
    const fixed = { ...worker, runtimeConfig: {} };
    expect(resolveBridgeWorkerRoute(fixed, null)).toBeNull();
    expect(bridgeWorkerSupportsHost(fixed, "shopee-d")).toBe(false);
    expect(bridgeWorkerSupportsHost(worker, "shopee-d")).toBe(true);
    for (const value of [{}, { d: 0 }, { d: 1.5 }, { d: "4" }]) {
      expect(() => bridgeWorkerCapacities({ ...worker, runtimeConfig: { bridgeWorkerHostCapacity: value } })).toThrow();
    }
    expect(() => bridgeWorkerCapacities({ ...worker, adapterConfig: { ...worker.adapterConfig, role: "main" } })).toThrow();
  });
  it("preserves the full selector and prevents cross-host/provider resume or default substitution", () => {
    const d = resolveBridgeWorkerRoute(worker, overrides("shopee-d"))!;
    expect(d).toEqual({ hostId: "shopee-d", provider: "codex", model: "shopee-d/codex/model" });
    expect(resolveBridgeWorkerRoute(worker, overrides("shopee-d"), d)).toEqual(d);
    for (const config of [null, overrides("michael-server"), overrides("shopee-d", "claude"), { adapterConfig: { model: "model" } },
      { adapterConfig: { model: d.model, hostId: "shopee-e" } }]) expect(() => resolveBridgeWorkerRoute(worker, config)).toThrow();
    expect(() => resolveBridgeWorkerRoute(worker, overrides("shopee-e"), d)).toThrow("original");
    expect(() => resolveBridgeWorkerRoute(worker, overrides("shopee-d"), {})).toThrow("original");
  });
  it("keeps independent host capacity; a full D lane leaves all E slots available", () => {
    const d = resolveBridgeWorkerRoute(worker, overrides("shopee-d"))!;
    const e = resolveBridgeWorkerRoute(worker, overrides("shopee-e"))!;
    const capacity = bridgeWorkerCapacity(bridgeWorkerCapacities(worker)!, [d, d, d, d]);
    expect(capacity.hasRoom(d)).toBe(false);
    for (let i = 0; i < 4; i++) { expect(capacity.hasRoom(e)).toBe(true); capacity.take(e); }
    expect(capacity.hasRoom(e)).toBe(false);
    expect(bridgeWorkerCapacity({ "shopee-d": 1, "shopee-e": 1 }, [null]).hasRoom(e)).toBe(false);
  });
});
