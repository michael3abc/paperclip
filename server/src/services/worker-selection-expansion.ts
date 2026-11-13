import { and, eq, sql } from "drizzle-orm";
import { agents, type Db } from "@paperclipai/db";
import type { PmWorkerPolicy } from "@paperclipai/shared";
import { workerSelectionOverrides } from "./pm-worker-options.js";

const HARNESSES = new Set(["claude_local", "codex_local", "ccpocket_bridge", "agy_local"]);

/**
 * Liveness-first (Owner 2026-11-13): a task whose overrides store only a
 * `workerSelectionId` still runs with that selection's model, effort and
 * permissions. The selection is read from the dispatching owner's current
 * worker policy and rendered for the worker's current harness, so a worker
 * switched to another harness keeps the Owner-selected Full access.
 */
export async function expandStoredWorkerSelection(
  db: Db,
  worker: { id: string; companyId: string; adapterType: string },
  raw: unknown,
): Promise<{ adapterConfig: Record<string, unknown>; aiConnection?: unknown } | null> {
  const selectionId = raw && typeof raw === "object" ? (raw as Record<string, unknown>).workerSelectionId : null;
  if (typeof selectionId !== "string" || !selectionId) return null;
  const owners = await db.select({ runtimeConfig: agents.runtimeConfig }).from(agents).where(and(
    eq(agents.companyId, worker.companyId),
    sql`jsonb_path_exists(${agents.runtimeConfig}, '$.pmDelegation.workers[*].selections[*] ? (@.id == $id)', jsonb_build_object('id', ${selectionId}::text))`,
  ));
  for (const owner of owners) {
    const policy = (owner.runtimeConfig as { pmDelegation?: PmWorkerPolicy } | null)?.pmDelegation;
    const entry = policy?.workers?.find(item => item.agentId === worker.id && item.selections.some(choice => choice.id === selectionId));
    const choice = entry?.selections.find(item => item.id === selectionId);
    if (!entry || !choice) continue;
    const harness = (HARNESSES.has(worker.adapterType) ? worker.adapterType : entry.harness) as Parameters<typeof workerSelectionOverrides>[0];
    return { adapterConfig: workerSelectionOverrides(harness, choice), ...(choice.aiConnection ? { aiConnection: choice.aiConnection } : {}) };
  }
  return null;
}
