import { z } from "zod";
import { unprocessable } from "../errors.js";
import { agentHost, bridgeWorkerProvider } from "./pm-worker-options.js";

type Worker = Parameters<typeof agentHost>[0];
const capacitiesSchema = z.record(z.string().regex(/^[a-z0-9][a-z0-9_-]{0,63}$/), z.number().int().min(1).max(100)).refine(value => Object.keys(value).length > 0);

/** Owner opt-in: independent capacity on each host, never a host failover pool. */
export function bridgeWorkerCapacities(worker: Worker): Record<string, number> | null {
  const value = worker.runtimeConfig?.bridgeWorkerHostCapacity;
  if (value === undefined) return null;
  if (!bridgeWorkerProvider(worker)) throw unprocessable("Multi-host routing requires a plain Bridge worker");
  const result = capacitiesSchema.safeParse(value);
  if (!result.success) throw unprocessable("Invalid Bridge worker host capacity");
  return result.data;
}

export function bridgeWorkerSupportsHost(worker: Worker, hostId: string): boolean {
  const capacities = bridgeWorkerCapacities(worker);
  return capacities ? Object.hasOwn(capacities, hostId) : agentHost(worker) === hostId;
}

export type BridgeWorkerRoute = { hostId: string; provider: string; model: string };
const routeSchema = z.object({ hostId: z.string(), provider: z.string(), model: z.string() }).strict();

/** Full selectors are durable task settings. Never substitute the worker's default host/model. */
export function resolveBridgeWorkerRoute(worker: Worker, overrides: unknown, saved?: unknown): BridgeWorkerRoute | null {
  if (!bridgeWorkerCapacities(worker)) return null;
  const config = (overrides as { adapterConfig?: Record<string, unknown> } | null)?.adapterConfig;
  const model = config?.model;
  const provider = bridgeWorkerProvider(worker)!;
  if (typeof model !== "string") throw unprocessable("Select a host-qualified model for this shared worker");
  const [hostId, engine, ...parts] = model.split("/");
  if (!hostId || engine !== provider || !parts.join("/") || !bridgeWorkerSupportsHost(worker, hostId)
    || (config?.hostId !== undefined && config.hostId !== hostId)) {
    throw unprocessable("Worker model does not match an allowed host and provider", { code: "PM_WORKER_HOST_MISMATCH" });
  }
  const route = { hostId, provider, model };
  if (saved !== undefined && saved !== null) {
    // The task's workspace and native session live on the pinned host and provider, so those stay fixed.
    // The model may change on the same host/provider (Owner 2026-11-16: an explicit selector moved to its
    // auto-rotating `family:` route must not strand the task's retries); the caller re-pins the new model.
    const pinned = routeSchema.safeParse(saved);
    if (!pinned.success || pinned.data.hostId !== route.hostId || pinned.data.provider !== route.provider) {
      throw unprocessable("This task is pinned to its original Bridge host and provider", { code: "BRIDGE_WORKER_ROUTE_CHANGED" });
    }
  }
  return route;
}

/** Caller holds the existing per-agent start lock across admission and take(). */
export function bridgeWorkerCapacity(capacities: Record<string, number>, running: Array<BridgeWorkerRoute | null>) {
  const counts = new Map<string, number>();
  // Unknown historical running routes reserve capacity on every host until they settle.
  for (const route of running) for (const host of route ? [route.hostId] : Object.keys(capacities)) counts.set(host, (counts.get(host) ?? 0) + 1);
  return {
    hasRoom: (route: BridgeWorkerRoute) => (counts.get(route.hostId) ?? 0) < (capacities[route.hostId] ?? 0),
    take: (route: BridgeWorkerRoute) => { counts.set(route.hostId, (counts.get(route.hostId) ?? 0) + 1); },
  };
}
