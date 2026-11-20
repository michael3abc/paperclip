// @vitest-environment jsdom

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  MAX_CONCURRENT_RUN_LOG_READS,
  __runLogReadLimiterTestUtils,
  readRunLogRequest,
  runLogRetryDelayMs,
} from "./run-log-read-limiter";
import { TRANSCRIPT_REQUEST_TIMEOUT_MS } from "./read-transcript-request";

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
}

describe("run-log read limiter", () => {
  beforeEach(() => __runLogReadLimiterTestUtils.reset());
  afterEach(() => {
    __runLogReadLimiterTestUtils.reset();
    vi.useRealTimers();
  });

  it("caps concurrent run-log reads and starts queued reads in order as slots free", async () => {
    const pending = Array.from({ length: MAX_CONCURRENT_RUN_LOG_READS + 2 }, () => deferred<string>());
    const started: number[] = [];
    const controller = new AbortController();
    const reads = pending.map((entry, index) =>
      readRunLogRequest(() => { started.push(index); return entry.promise; }, controller.signal));

    expect(started).toEqual([0, 1, 2, 3]);
    expect(__runLogReadLimiterTestUtils.snapshot()).toEqual({ active: 4, waiting: 2 });

    pending[1]!.resolve("one");
    await expect(reads[1]).resolves.toBe("one");
    await Promise.resolve();
    expect(started).toEqual([0, 1, 2, 3, 4]);

    pending[0]!.reject(new Error("boom"));
    await expect(reads[0]).rejects.toThrow("boom");
    await Promise.resolve();
    expect(started).toEqual([0, 1, 2, 3, 4, 5]);

    for (const index of [2, 3, 4, 5]) pending[index]!.resolve(String(index));
    await Promise.all(reads.slice(2));
    await Promise.resolve();
    expect(__runLogReadLimiterTestUtils.snapshot()).toEqual({ active: 0, waiting: 0 });
  });

  it("drops a queued read that is cancelled before it starts, without a network request", async () => {
    const blockers = Array.from({ length: MAX_CONCURRENT_RUN_LOG_READS }, () => deferred<string>());
    const shared = new AbortController();
    const running = blockers.map((entry) => readRunLogRequest(() => entry.promise, shared.signal));
    const queuedController = new AbortController();
    const queuedRequest = vi.fn(async () => "never");
    const queued = readRunLogRequest(queuedRequest, queuedController.signal);

    queuedController.abort();
    await expect(queued).rejects.toMatchObject({ name: "AbortError" });
    expect(__runLogReadLimiterTestUtils.snapshot()).toEqual({ active: 4, waiting: 0 });

    blockers.forEach((entry, index) => entry.resolve(String(index)));
    await Promise.all(running);
    await Promise.resolve();
    expect(queuedRequest).not.toHaveBeenCalled();
    expect(__runLogReadLimiterTestUtils.snapshot()).toEqual({ active: 0, waiting: 0 });
  });

  it("starts the request timeout only once a queued read holds a slot", async () => {
    vi.useFakeTimers();
    const blockers = Array.from({ length: MAX_CONCURRENT_RUN_LOG_READS }, () => deferred<string>());
    const signal = new AbortController().signal;
    blockers.forEach((entry) => { void readRunLogRequest(() => entry.promise, signal).catch(() => undefined); });
    const queued = deferred<string>();
    const read = readRunLogRequest(() => queued.promise, signal);
    let settled = false;
    void read.then(() => { settled = true; }, () => { settled = true; });

    // Everything ahead of it times out and frees the slots…
    await vi.advanceTimersByTimeAsync(TRANSCRIPT_REQUEST_TIMEOUT_MS);
    expect(settled).toBe(false);
    // …and the queued read still has its own full window.
    await vi.advanceTimersByTimeAsync(TRANSCRIPT_REQUEST_TIMEOUT_MS - 1);
    expect(settled).toBe(false);
    queued.resolve("late but in time");
    await expect(read).resolves.toBe("late but in time");
  });

  it("backs off failed reads exponentially up to 30 seconds", () => {
    expect([1, 2, 3, 4, 5, 6, 50].map(runLogRetryDelayMs)).toEqual([2_000, 4_000, 8_000, 16_000, 30_000, 30_000, 30_000]);
  });
});
