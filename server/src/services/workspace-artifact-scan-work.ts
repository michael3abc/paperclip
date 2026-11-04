import { logger } from "../middleware/logger.js";
import { registerDeadlineWork } from "./deadline-work.js";
import type { createDeliveryWorkCoordinator } from "./delivery-work-coordinator.js";
import { DELIVERY_QUEUES, subscribeDeliveryWork } from "./delivery-work-notifications.js";
import type { workspaceArtifactScanService } from "./workspace-artifact-scan.js";

/** Terminal runs finished within this window are swept, and late files are followed up for the same window. */
export const WORKSPACE_ARTIFACT_SCAN_WINDOW_MS = 10 * 60_000;
/** Cadence of follow-up rescans while a swept run is still awaiting its final scan. */
export const WORKSPACE_ARTIFACT_SCAN_FOLLOW_UP_MS = 60_000;
/** Bursts of run transitions coalesce into at most one sweep per interval. */
export const WORKSPACE_ARTIFACT_SCAN_SPACING_MS = 15_000;

/**
 * Discovers media files that finished runs left in their local workspaces, on its own delivery queue.
 *
 * - Trigger: every run status write, including each terminal transition, notifies the execution-status topic
 *   after its outer commit. This worker observes that settled notification as a hint; the terminal rows in
 *   `heartbeat_runs` stay the source of truth. Startup reconstruction is the initial sweep of the window.
 * - Pending work: a run the scanner has seen that still awaits its final scan at the end of its window.
 * - Next deadline: one follow-up per minute, and the earliest pending final-scan deadline; once every seen run
 *   has had its final scan there is no deadline, so the worker is idle until the next run transition.
 * - Failures are logged and isolated from execution-status delivery; a failed sweep is retried on the same
 *   follow-up schedule, bounded by one window after the latest hint or the pending final-scan deadline, never
 *   indefinitely. A final scan still pending after that runs on the next wake.
 */
export function registerWorkspaceArtifactScanWork(
  coordinator: Pick<ReturnType<typeof createDeliveryWorkCoordinator>, "register">,
  owner: object,
  scan: Pick<ReturnType<typeof workspaceArtifactScanService>, "sweepRecentRuns">,
  canRun: () => boolean = () => true,
) {
  let stopped = false;
  let lastHintAt = Date.now();
  // Earliest final-scan deadline reported by the last successful sweep. A failed sweep leaves the scanner's
  // pending runs unchanged, so it keeps this value and sets a bounded retry horizon instead.
  let nextFinalScanAt: number | null = null;
  let retryUntil: number | null = null;
  const worker = registerDeadlineWork(coordinator, DELIVERY_QUEUES.workspaceArtifactScan, {
    retryMs: WORKSPACE_ARTIFACT_SCAN_SPACING_MS,
    minimumSpacingMs: WORKSPACE_ARTIFACT_SCAN_SPACING_MS,
    canRun: () => !stopped && canRun(),
    run: async () => {
      try {
        const result = await scan.sweepRecentRuns({
          windowMs: WORKSPACE_ARTIFACT_SCAN_WINDOW_MS,
          rescanAfterMs: WORKSPACE_ARTIFACT_SCAN_FOLLOW_UP_MS,
        });
        nextFinalScanAt = result.nextFinalScanAt;
        retryUntil = null;
      } catch (err) {
        logger.warn({ err }, "workspace artifact sweep failed");
        retryUntil = Math.max(retryUntil ?? 0, lastHintAt + WORKSPACE_ARTIFACT_SCAN_WINDOW_MS,
          nextFinalScanAt === null ? 0 : nextFinalScanAt + WORKSPACE_ARTIFACT_SCAN_WINDOW_MS);
      }
    },
    next: async () => {
      const now = Date.now();
      if (retryUntil !== null) {
        if (retryUntil > now) return Math.min(now + WORKSPACE_ARTIFACT_SCAN_FOLLOW_UP_MS, retryUntil);
        retryUntil = null;
        return null;
      }
      if (nextFinalScanAt === null) return null;
      return Math.min(now + WORKSPACE_ARTIFACT_SCAN_FOLLOW_UP_MS, nextFinalScanAt);
    },
  });
  const unsubscribe = subscribeDeliveryWork(owner, DELIVERY_QUEUES.executionStatus, () => {
    if (stopped) return;
    lastHintAt = Date.now();
    worker.wake();
  });
  return {
    ready: worker.ready,
    wake: worker.wake,
    async stop() {
      stopped = true;
      unsubscribe();
      await worker.stop();
    },
  };
}
