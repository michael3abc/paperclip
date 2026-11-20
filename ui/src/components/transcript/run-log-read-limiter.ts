import { readTranscriptRequest } from "./read-transcript-request";

/**
 * Page-wide cap on concurrent `GET /heartbeat-runs/:id/log` reads.
 *
 * Every transcript surface (chat threads, live run widgets, worker cards, the
 * run log viewer, summary drafts) reads run logs independently. Without a cap a
 * page that hydrates many runs at once fires one request per run, and when the
 * server is slow most of them time out or are abandoned by a re-render before
 * the server answers. Reads beyond the cap wait in FIFO order; a waiting read
 * that is cancelled never reaches the network, and the per-request timeout only
 * starts once the read holds a slot.
 */
export const MAX_CONCURRENT_RUN_LOG_READS = 4;

const RUN_LOG_RETRY_BASE_DELAY_MS = 2_000;
const RUN_LOG_RETRY_MAX_DELAY_MS = 30_000;

/**
 * Delay before retrying a failed run-log read: 2s after the first failure,
 * doubling to at most 30s, so timeouts on a slow server back off instead of
 * re-requesting every 2 seconds.
 */
export function runLogRetryDelayMs(consecutiveFailures: number): number {
  const exponent = Math.max(0, Math.min(consecutiveFailures - 1, 10));
  return Math.min(RUN_LOG_RETRY_BASE_DELAY_MS * 2 ** exponent, RUN_LOG_RETRY_MAX_DELAY_MS);
}

interface Waiter {
  start: () => void;
  signal: AbortSignal;
  onAbort: () => void;
}

let active = 0;
const waiters: Waiter[] = [];

function release() {
  active = Math.max(0, active - 1);
  for (let next = waiters.shift(); next; next = waiters.shift()) {
    next.signal.removeEventListener("abort", next.onAbort);
    if (next.signal.aborted) { next.onAbort(); continue; }
    next.start();
    return;
  }
}

function startWithSlot<T>(request: (signal: AbortSignal) => Promise<T>, signal: AbortSignal): Promise<T> {
  active += 1;
  let read: Promise<T>;
  try {
    read = readTranscriptRequest(request, signal);
  } catch (error) {
    release();
    return Promise.reject(error);
  }
  // Release beside the caller's continuation rather than ahead of it, so a free
  // slot adds no extra microtask hop to the read itself.
  read.then(release, release);
  return read;
}

/** `readTranscriptRequest` for run-log reads, bounded by the page-wide cap. */
export function readRunLogRequest<T>(request: (signal: AbortSignal) => Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) return Promise.reject(new DOMException("History read cancelled", "AbortError"));
  if (active < MAX_CONCURRENT_RUN_LOG_READS) return startWithSlot(request, signal);
  return new Promise<T>((resolve, reject) => {
    const waiter: Waiter = {
      signal,
      start: () => { startWithSlot(request, signal).then(resolve, reject); },
      onAbort: () => {
        const index = waiters.indexOf(waiter);
        if (index >= 0) waiters.splice(index, 1);
        reject(new DOMException("History read cancelled", "AbortError"));
      },
    };
    signal.addEventListener("abort", waiter.onAbort, { once: true });
    waiters.push(waiter);
  });
}

export const __runLogReadLimiterTestUtils = {
  snapshot: () => ({ active, waiting: waiters.length }),
  reset: () => {
    active = 0;
    for (const waiter of waiters.splice(0)) waiter.signal.removeEventListener("abort", waiter.onAbort);
  },
};
