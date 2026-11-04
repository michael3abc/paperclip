import { logger } from "../middleware/logger.js";
import { registerDeadlineWork } from "./deadline-work.js";
import type { createDeliveryWorkCoordinator } from "./delivery-work-coordinator.js";
import { DELIVERY_QUEUES, subscribeDeliveryWork } from "./delivery-work-notifications.js";
import type { workspaceArtifactScanService } from "./workspace-artifact-scan.js";

/** Terminal runs finished within this window are swept, and late files are followed up for the same window. */
export const WORKSPACE_ARTIFACT_SCAN_WINDOW_MS = 10 * 60_000;
/** Cadence of follow-up rescans while the newest terminal run is still inside the window. */
export const WORKSPACE_ARTIFACT_SCAN_FOLLOW_UP_MS = 60_000;
/** Bursts of run transitions coalesce into at most one sweep per interval. */
export const WORKSPACE_ARTIFACT_SCAN_SPACING_MS = 15_000;

/**
 * Discovers media files that finished runs left in their local workspaces, on its own delivery queue.
 *
 * - Trigger: every run status write, including each terminal transition, notifies the execution-status topic
 *   after its outer commit. This worker observes that settled notification as a hint; the terminal rows in
 *   `heartbeat_runs` stay the source of truth. Startup reconstruction is the initial sweep of the window.
 * - Pending work: a terminal run that finished within the window.
 * - Next deadline: one follow-up rescan per minute until the window after the newest terminal run closes;
 *   then no deadline, so the worker is idle until the next run transition.
 * - Failures are logged and isolated from execution-status delivery; a failed sweep is retried on the same
 *   bounded follow-up schedule (until the window after the latest hint), never indefinitely.
 */
export function registerWorkspaceArtifactScanWork(
  coordinator: Pick<ReturnType<typeof createDeliveryWorkCoordinator>, "register">,
  owner: object,
  scan: Pick<ReturnType<typeof workspaceArtifactScanService>, "sweepRecentRuns">,
  canRun: () => boolean = () => true,
) {
  let stopped = false;
  let lastHintAt = Date.now();
  let followUpUntil: number | null = null;
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
        followUpUntil = result.latestFinishedAt === null ? null : result.latestFinishedAt + WORKSPACE_ARTIFACT_SCAN_WINDOW_MS;
      } catch (err) {
        logger.warn({ err }, "workspace artifact sweep failed");
        followUpUntil = Math.max(followUpUntil ?? 0, lastHintAt + WORKSPACE_ARTIFACT_SCAN_WINDOW_MS);
      }
    },
    next: async () => {
      const now = Date.now();
      if (followUpUntil === null || followUpUntil <= now) {
        followUpUntil = null;
        return null;
      }
      return Math.min(now + WORKSPACE_ARTIFACT_SCAN_FOLLOW_UP_MS, followUpUntil);
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
