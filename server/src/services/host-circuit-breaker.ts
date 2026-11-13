/**
 * In-memory per-host circuit breaker (liveness-first rule 4 / plan 3c).
 *
 * Fed by `host_unavailable` / `bridge_unavailable` failures. While a host's
 * breaker is open, wakes targeting it are deferred to `openUntil`; deferrals
 * are not counted as run failures. The breaker never blocks permanently:
 * backoff is 30s doubling to a 30 minute cap, and one success closes it.
 * A single notice is allowed once the breaker has stayed open for over an hour.
 */

export const HOST_CIRCUIT_BASE_MS = 30_000;
export const HOST_CIRCUIT_CAP_MS = 30 * 60_000;
export const HOST_CIRCUIT_NOTICE_AFTER_MS = 60 * 60_000;

export const HOST_CIRCUIT_FAILURE_CODES: ReadonlySet<string> = new Set([
  "host_unavailable",
  "bridge_unavailable",
]);

type HostCircuitState = {
  consecutiveFailures: number;
  openedAt: number;
  openUntil: number;
  noticeSent: boolean;
};

export type HostCircuitSnapshot = {
  hostId: string;
  consecutiveFailures: number;
  openedAt: Date;
  openUntil: Date;
};

export function createHostCircuitBreaker(options: { now?: () => number } = {}) {
  const now = options.now ?? (() => Date.now());
  const states = new Map<string, HostCircuitState>();

  function key(hostId: string | null | undefined) {
    const value = typeof hostId === "string" ? hostId.trim() : "";
    return value.length > 0 ? value : null;
  }

  function recordFailure(hostId: string | null | undefined, errorCode?: string | null) {
    const id = key(hostId);
    if (!id) return null;
    if (errorCode != null && !HOST_CIRCUIT_FAILURE_CODES.has(errorCode)) return null;
    const at = now();
    const previous = states.get(id);
    const consecutiveFailures = (previous?.consecutiveFailures ?? 0) + 1;
    const delay = Math.min(
      HOST_CIRCUIT_BASE_MS * 2 ** Math.min(consecutiveFailures - 1, 16),
      HOST_CIRCUIT_CAP_MS,
    );
    const state: HostCircuitState = {
      consecutiveFailures,
      openedAt: previous?.openedAt ?? at,
      openUntil: at + delay,
      noticeSent: previous?.noticeSent ?? false,
    };
    states.set(id, state);
    return new Date(state.openUntil);
  }

  function recordSuccess(hostId: string | null | undefined) {
    const id = key(hostId);
    if (id) states.delete(id);
  }

  /** The time wakes for this host should be deferred to, or null when closed. */
  function openUntil(hostId: string | null | undefined): Date | null {
    const id = key(hostId);
    if (!id) return null;
    const state = states.get(id);
    if (!state) return null;
    return state.openUntil > now() ? new Date(state.openUntil) : null;
  }

  /** True exactly once per open period, after it has lasted more than an hour. */
  function takeNotice(hostId: string | null | undefined) {
    const id = key(hostId);
    if (!id) return false;
    const state = states.get(id);
    if (!state || state.noticeSent) return false;
    if (now() - state.openedAt <= HOST_CIRCUIT_NOTICE_AFTER_MS) return false;
    state.noticeSent = true;
    return true;
  }

  function snapshot(): HostCircuitSnapshot[] {
    return [...states.entries()].map(([hostId, state]) => ({
      hostId,
      consecutiveFailures: state.consecutiveFailures,
      openedAt: new Date(state.openedAt),
      openUntil: new Date(state.openUntil),
    }));
  }

  function reset() {
    states.clear();
  }

  return { recordFailure, recordSuccess, openUntil, takeNotice, snapshot, reset };
}

export type HostCircuitBreaker = ReturnType<typeof createHostCircuitBreaker>;

/**
 * Breaker key for the host an agent executes on: its configured `hostId`
 * (CC Pocket remote hosts) or the local Bridge for CC Pocket agents without
 * one. Other adapters have no shared host and return null.
 */
export function hostCircuitKeyForAgent(
  agent: { adapterType?: string | null; adapterConfig?: unknown } | null | undefined,
): string | null {
  if (!agent?.adapterType) return null;
  const config = agent.adapterConfig && typeof agent.adapterConfig === "object" && !Array.isArray(agent.adapterConfig)
    ? agent.adapterConfig as Record<string, unknown>
    : {};
  const hostId = typeof config.hostId === "string" ? config.hostId.trim() : "";
  if (hostId) return `${agent.adapterType}:${hostId}`;
  return agent.adapterType === "ccpocket_bridge" ? "ccpocket_bridge:local" : null;
}

/** Process-wide breaker shared by dispatch and run completion. */
export const hostCircuitBreaker: HostCircuitBreaker = createHostCircuitBreaker();
