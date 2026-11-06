import {
  PROJECT_WORKER_POLICY_GUARDED_KEYS,
  projectWorkerPolicySchema,
  type ProjectWorkerPolicy,
  type ProjectWorkerPolicyEntry,
} from "@paperclipai/shared";

const GUARDED_KEYS: readonly string[] = PROJECT_WORKER_POLICY_GUARDED_KEYS;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Reads a stored policy. An unparseable value is treated as "no policy" so a
 * bad row can never block runs; the write path validates with the same schema.
 */
export function parseProjectWorkerPolicy(raw: unknown): ProjectWorkerPolicy | null {
  if (raw === null || raw === undefined) return null;
  const parsed = projectWorkerPolicySchema.safeParse(raw);
  return parsed.success ? parsed.data : null;
}

export interface ProjectWorkerOverrideViolation {
  key: string;
  message: string;
}

export interface ProjectWorkerOverrideResolution {
  /** Adapter config to apply: `worker` expanded, guarded keys removed when rejected. */
  adapterConfig: Record<string, unknown> | null;
  violations: ProjectWorkerOverrideViolation[];
  /** True when the policy forced any change to the submitted config. */
  changed: boolean;
}

function matchesEntry(
  entry: ProjectWorkerPolicyEntry,
  requested: Record<string, unknown>,
): boolean {
  return Object.entries(requested).every(
    ([key, value]) => (entry.adapterConfig as Record<string, unknown>)[key] === value,
  );
}

function withoutGuardedKeys(adapterConfig: Record<string, unknown>) {
  return Object.fromEntries(
    Object.entries(adapterConfig).filter(([key]) => !GUARDED_KEYS.includes(key)),
  );
}

/**
 * Applies a project's worker list to a task's `adapterConfig` override.
 *
 * - `worker: "<id>"` selects a listed worker and expands to its config. Explicit
 *   guarded keys next to it must agree with the worker.
 * - Without `worker`, the guarded keys that are set must all match one listed
 *   worker. With an empty list no guarded key is allowed.
 * - Keys outside the guarded set (e.g. `cwd`, `env`) are never touched here.
 *
 * Pure: callers decide whether violations reject the write or strip the keys.
 */
export function resolveWorkerOverrides(
  policy: ProjectWorkerPolicy | null,
  adapterConfig: Record<string, unknown> | null | undefined,
): ProjectWorkerOverrideResolution {
  const config = isRecord(adapterConfig) ? adapterConfig : null;
  if (!policy || policy.mode !== "enforce" || !config) {
    return { adapterConfig: config, violations: [], changed: false };
  }

  const requestedGuarded = Object.fromEntries(
    Object.entries(config).filter(([key]) => GUARDED_KEYS.includes(key)),
  );
  if (Object.keys(requestedGuarded).length === 0) {
    return { adapterConfig: config, violations: [], changed: false };
  }

  const { worker: workerSelector, ...explicit } = requestedGuarded;
  const allowedIds = policy.workers.map((worker) => worker.id);
  const allowedText = allowedIds.length > 0 ? allowedIds.join(", ") : "none configured";

  if (workerSelector !== undefined) {
    const entry =
      typeof workerSelector === "string"
        ? policy.workers.find((candidate) => candidate.id === workerSelector)
        : undefined;
    if (!entry) {
      return reject(config, [
        {
          key: "worker",
          message: `Worker ${JSON.stringify(workerSelector)} is not in this project's worker list (allowed: ${allowedText})`,
        },
      ]);
    }
    if (!matchesEntry(entry, explicit)) {
      return reject(config, [
        {
          key: "worker",
          message: `Explicit model settings conflict with worker "${entry.id}"; set only worker or make them match`,
        },
      ]);
    }
    return {
      adapterConfig: { ...withoutGuardedKeys(config), ...entry.adapterConfig },
      violations: [],
      changed: true,
    };
  }

  if (policy.workers.some((entry) => matchesEntry(entry, explicit))) {
    return { adapterConfig: config, violations: [], changed: false };
  }
  return reject(
    config,
    Object.keys(explicit).map((key) => ({
      key,
      message: `"${key}" override does not match any worker in this project's worker list (allowed: ${allowedText}); use adapterConfig.worker`,
    })),
  );
}

function reject(
  config: Record<string, unknown>,
  violations: ProjectWorkerOverrideViolation[],
): ProjectWorkerOverrideResolution {
  return { adapterConfig: withoutGuardedKeys(config), violations, changed: true };
}
