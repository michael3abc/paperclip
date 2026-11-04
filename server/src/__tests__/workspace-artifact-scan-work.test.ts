import { afterEach, describe, expect, it, vi } from "vitest";
import { installDatabaseWorkSignals } from "../../../packages/db/src/work-signals.js";
import { logger } from "../middleware/logger.js";
import { createDeliveryWorkCoordinator } from "../services/delivery-work-coordinator.js";
import { DELIVERY_QUEUES, notifyDeliveryWork } from "../services/delivery-work-notifications.js";
import { registerExecutionControlWork } from "../services/execution-control-work.js";
import {
  registerWorkspaceArtifactScanWork,
  WORKSPACE_ARTIFACT_SCAN_FOLLOW_UP_MS,
  WORKSPACE_ARTIFACT_SCAN_SPACING_MS,
  WORKSPACE_ARTIFACT_SCAN_WINDOW_MS,
} from "../services/workspace-artifact-scan-work.js";
import type { WorkspaceSweepResult } from "../services/workspace-artifact-scan.js";

const coordinators: ReturnType<typeof createDeliveryWorkCoordinator>[] = [];
afterEach(async () => {
  for (const c of coordinators.splice(0)) await c.stop();
  vi.useRealTimers();
  vi.restoreAllMocks();
});

function coordinator(owner: object, onError: (error: unknown) => void = vi.fn()) {
  const c = createDeliveryWorkCoordinator({ owner, canRun: () => true, canReconcile: () => true, onError });
  coordinators.push(c);
  return c;
}
function fakeOwner() {
  const execute = vi.fn(async () => [{ xid: "42" }]);
  const owner = installDatabaseWorkSignals({ execute, async transaction(fn: (tx: any) => Promise<any>): Promise<any> {
    return fn({ execute, transaction: owner.transaction });
  } });
  return owner;
}
/** Every terminal run write notifies the execution-status topic inside its transaction. */
function runTransition(owner: ReturnType<typeof fakeOwner>) {
  return owner.transaction(tx => notifyDeliveryWork(tx, DELIVERY_QUEUES.executionStatus));
}
/** Emulates the durable window predicate: the newest terminal run counts only while inside the window. */
function sweeper() {
  const state = { finishedAt: null as number | null };
  const sweepRecentRuns = vi.fn(async (_options: { windowMs: number; rescanAfterMs?: number }): Promise<WorkspaceSweepResult> => {
    const inWindow = state.finishedAt !== null && Date.now() - state.finishedAt <= WORKSPACE_ARTIFACT_SCAN_WINDOW_MS;
    return { runs: inWindow ? 1 : 0, scanned: inWindow ? 1 : 0, created: 0, latestFinishedAt: inWindow ? state.finishedAt : null };
  });
  return { state, scan: { sweepRecentRuns } };
}

describe("workspace artifact scan work", () => {
  it("sweeps the startup window, stays idle, and is woken by a terminal run transition", async () => {
    vi.useFakeTimers();
    const owner = fakeOwner(); const c = coordinator(owner); const { state, scan } = sweeper();
    await registerWorkspaceArtifactScanWork(c, owner, scan).ready;
    expect(scan.sweepRecentRuns).toHaveBeenCalledTimes(1);
    expect(scan.sweepRecentRuns).toHaveBeenLastCalledWith({
      windowMs: WORKSPACE_ARTIFACT_SCAN_WINDOW_MS, rescanAfterMs: WORKSPACE_ARTIFACT_SCAN_FOLLOW_UP_MS,
    });
    expect(c.nextWakeAt()).toBeNull();
    await vi.advanceTimersByTimeAsync(60 * 60_000);
    expect(scan.sweepRecentRuns).toHaveBeenCalledTimes(1);

    state.finishedAt = Date.now();
    await runTransition(owner);
    await vi.advanceTimersByTimeAsync(1);
    expect(scan.sweepRecentRuns).toHaveBeenCalledTimes(2);
  });

  it("follows up once per minute until the window after the newest terminal run closes, then goes fully idle", async () => {
    vi.useFakeTimers();
    const owner = fakeOwner(); const c = coordinator(owner); const { state, scan } = sweeper();
    await registerWorkspaceArtifactScanWork(c, owner, scan).ready;
    const finishedAt = Date.now() + 60 * 60_000;
    await vi.advanceTimersByTimeAsync(60 * 60_000);
    state.finishedAt = finishedAt;
    await runTransition(owner);
    const at: number[] = [];
    scan.sweepRecentRuns.mockImplementation(async () => {
      at.push(Date.now());
      const inWindow = Date.now() - finishedAt <= WORKSPACE_ARTIFACT_SCAN_WINDOW_MS;
      return { runs: inWindow ? 1 : 0, scanned: 0, created: 0, latestFinishedAt: inWindow ? finishedAt : null };
    });
    await vi.advanceTimersByTimeAsync(WORKSPACE_ARTIFACT_SCAN_WINDOW_MS + WORKSPACE_ARTIFACT_SCAN_FOLLOW_UP_MS);
    // Roughly one sweep per minute for the ten-minute window, never past it plus one spacing interval.
    expect(at.length).toBeGreaterThanOrEqual(10);
    expect(at.length).toBeLessThanOrEqual(12);
    for (let i = 1; i < at.length; i++) expect(at[i]! - at[i - 1]!).toBeGreaterThanOrEqual(WORKSPACE_ARTIFACT_SCAN_SPACING_MS);
    expect(Math.max(...at)).toBeLessThanOrEqual(finishedAt + WORKSPACE_ARTIFACT_SCAN_WINDOW_MS + WORKSPACE_ARTIFACT_SCAN_SPACING_MS);
    expect(c.nextWakeAt()).toBeNull();
    const settled = at.length;
    await vi.advanceTimersByTimeAsync(2 * 60 * 60_000);
    expect(at).toHaveLength(settled);
  });

  it.each(["warm standby", "idle drain", "scheduler stopped"])("does not sweep during %s and resumes the retained wake afterwards", async () => {
    vi.useFakeTimers();
    let blocked = true;
    const owner = fakeOwner(); const c = coordinator(owner); const { state, scan } = sweeper();
    await registerWorkspaceArtifactScanWork(c, owner, scan, () => !blocked).ready;
    state.finishedAt = Date.now();
    await runTransition(owner);
    await vi.advanceTimersByTimeAsync(5 * 60_000);
    expect(scan.sweepRecentRuns).not.toHaveBeenCalled();

    blocked = false;
    await vi.advanceTimersByTimeAsync(WORKSPACE_ARTIFACT_SCAN_SPACING_MS);
    expect(scan.sweepRecentRuns).toHaveBeenCalledTimes(1);
    blocked = true;
    const sweeps = scan.sweepRecentRuns.mock.calls.length;
    await runTransition(owner);
    await vi.advanceTimersByTimeAsync(3 * 60_000);
    expect(scan.sweepRecentRuns).toHaveBeenCalledTimes(sweeps);
  });

  it("never overlaps sweeps when transitions arrive during a slow sweep", async () => {
    vi.useFakeTimers();
    const owner = fakeOwner(); const c = coordinator(owner); const { state, scan } = sweeper();
    let active = 0, maxActive = 0;
    const release: Array<() => void> = [];
    scan.sweepRecentRuns.mockImplementation(async () => {
      active++; maxActive = Math.max(maxActive, active);
      await new Promise<void>(resolve => release.push(resolve));
      active--;
      return { runs: 0, scanned: 0, created: 0, latestFinishedAt: state.finishedAt };
    });
    const work = registerWorkspaceArtifactScanWork(c, owner, scan);
    await vi.advanceTimersByTimeAsync(1);
    state.finishedAt = Date.now();
    for (let i = 0; i < 5; i++) { await runTransition(owner); await vi.advanceTimersByTimeAsync(5_000); }
    expect(scan.sweepRecentRuns).toHaveBeenCalledTimes(1);
    release.shift()!();
    await work.ready;
    await vi.advanceTimersByTimeAsync(WORKSPACE_ARTIFACT_SCAN_SPACING_MS + 1);
    expect(scan.sweepRecentRuns).toHaveBeenCalledTimes(2);
    for (const resolve of release.splice(0)) resolve();
    await vi.advanceTimersByTimeAsync(1);
    expect(maxActive).toBe(1);
  });

  it("logs and isolates a failing sweep: status delivery still runs and the retry stays bounded", async () => {
    vi.useFakeTimers();
    const warn = vi.spyOn(logger, "warn").mockImplementation(() => undefined as never);
    const onError = vi.fn();
    const owner = fakeOwner(); const c = coordinator(owner, onError);
    const deliver = vi.fn(async () => {});
    const sweep = vi.fn(async (): Promise<WorkspaceSweepResult> => { throw new Error("workspace disk unavailable"); });
    await Promise.all([
      registerExecutionControlWork(c, [{ queue: DELIVERY_QUEUES.executionStatus, run: deliver, next: async () => null }]).ready,
      registerWorkspaceArtifactScanWork(c, owner, { sweepRecentRuns: sweep }).ready,
    ]);
    expect(deliver).toHaveBeenCalledTimes(1);
    expect(sweep).toHaveBeenCalledTimes(1);

    await vi.advanceTimersByTimeAsync(20_000);
    await runTransition(owner);
    await vi.advanceTimersByTimeAsync(WORKSPACE_ARTIFACT_SCAN_SPACING_MS);
    expect(deliver).toHaveBeenCalledTimes(2);
    expect(sweep.mock.calls.length).toBeGreaterThanOrEqual(2);
    expect(warn).toHaveBeenCalledWith(expect.objectContaining({ err: expect.any(Error) }), "workspace artifact sweep failed");
    expect(onError).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(WORKSPACE_ARTIFACT_SCAN_WINDOW_MS + WORKSPACE_ARTIFACT_SCAN_FOLLOW_UP_MS);
    expect(c.nextWakeAt()).toBeNull();
    const failedSweeps = sweep.mock.calls.length;
    await vi.advanceTimersByTimeAsync(60 * 60_000);
    expect(sweep).toHaveBeenCalledTimes(failedSweeps);
    expect(deliver).toHaveBeenCalledTimes(2);
  });

  it("stops its execution-status observer on stop", async () => {
    vi.useFakeTimers();
    const owner = fakeOwner(); const c = coordinator(owner); const { scan } = sweeper();
    const work = registerWorkspaceArtifactScanWork(c, owner, scan);
    await work.ready;
    await work.stop();
    await runTransition(owner);
    await vi.advanceTimersByTimeAsync(5 * 60_000);
    expect(scan.sweepRecentRuns).toHaveBeenCalledTimes(1);
  });
});
