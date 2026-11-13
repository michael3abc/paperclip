import { and, eq, inArray, sql } from "drizzle-orm";
import { heartbeatRuns, issues, projectWorkspaces, type agents, type Db } from "@paperclipai/db";
import { readMainManagedWorktree } from "@paperclipai/shared";
import { bridgeWorkerCapacities, bridgeWorkerCapacity, resolveBridgeWorkerRoute, type BridgeWorkerRoute } from "../bridge-worker-routing.js";
import { projectSourceHost } from "../pm-worker-options.js";
import { unprocessable } from "../../errors.js";

type Agent = typeof agents.$inferSelect;
type Run = Pick<typeof heartbeatRuns.$inferSelect, "id" | "contextSnapshot">;

/** Batched durable settings, scoped to one agent/company; no Bridge calls in queue admission. */
export async function loadBridgeWorkerCapacity(db: Db, agent: Agent, queued: Run[]) {
  const limits = bridgeWorkerCapacities(agent);
  if (!limits) return null;
  const running = await db.select({ id: heartbeatRuns.id, contextSnapshot: heartbeatRuns.contextSnapshot }).from(heartbeatRuns)
    .where(and(eq(heartbeatRuns.companyId, agent.companyId), eq(heartbeatRuns.agentId, agent.id), eq(heartbeatRuns.status, "running")));
  const ids = [...new Set([...queued, ...running].flatMap(run => typeof run.contextSnapshot?.issueId === "string" ? [run.contextSnapshot.issueId] : []))];
  const tasks = ids.length ? await db.select({ id: issues.id, overrides: issues.assigneeAdapterOverrides }).from(issues)
    .where(and(eq(issues.companyId, agent.companyId), eq(issues.assigneeAgentId, agent.id), inArray(issues.id, ids))) : [];
  const settings = new Map(tasks.map(task => [task.id, task.overrides]));
  const routeOf = (run: Run): BridgeWorkerRoute | null => {
    try {
      return resolveBridgeWorkerRoute(agent, settings.get(String(run.contextSnapshot?.issueId)), run.contextSnapshot?.bridgeWorkerRoute);
    } catch { return null; } // Invalid settings are claimed and reported by execution, never silently substituted.
  };
  const capacity = bridgeWorkerCapacity(limits, running.map(routeOf));
  return { ...capacity, routeOf };
}

/** Revalidate the selected source and pin effective host before workspace or adapter preparation. */
export async function prepareBridgeWorkerRoute(db: Db, input: { agent: Agent; run: typeof heartbeatRuns.$inferSelect;
  overrides: unknown; context: Record<string, unknown>; projectId: string | null | undefined; projectWorkspaceId?: string | null;
  workspace?: { metadata: Record<string, unknown> | null; projectWorkspaceId: string | null } | null }) {
  const { agent, run } = input;
  const route = resolveBridgeWorkerRoute(agent, input.overrides, run.contextSnapshot?.bridgeWorkerRoute);
  if (!route) return agent;
  const sourceId = input.workspace?.projectWorkspaceId ?? input.projectWorkspaceId;
  const sources = input.projectId ? await db.select().from(projectWorkspaces).where(and(
    eq(projectWorkspaces.companyId, agent.companyId), eq(projectWorkspaces.projectId, input.projectId),
    sourceId ? eq(projectWorkspaces.id, sourceId) : undefined)) : [];
  const source = sourceId ? sources[0] : sources.find(source => source.isPrimary) ?? (sources.length === 1 ? sources[0] : undefined);
  const managed = readMainManagedWorktree(input.workspace?.metadata);
  if (!source || projectSourceHost(source) !== route.hostId || (managed && managed.hostId !== route.hostId)) {
    throw unprocessable("Shared worker host does not match the task's selected project source", { code: "PM_WORKER_HOST_MISMATCH" });
  }
  input.context.bridgeWorkerRoute = route;
  await db.update(heartbeatRuns).set({ contextSnapshot: sql`coalesce(${heartbeatRuns.contextSnapshot}, '{}'::jsonb) || ${JSON.stringify({ bridgeWorkerRoute: route })}::jsonb` })
    .where(and(eq(heartbeatRuns.id, run.id), eq(heartbeatRuns.companyId, agent.companyId)));
  return { ...agent, adapterConfig: { ...agent.adapterConfig, hostId: route.hostId, provider: route.provider, model: route.model } };
}
