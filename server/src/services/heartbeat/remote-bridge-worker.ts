import path from "node:path";
import { agentHost, DEFAULT_BRIDGE_HOST, isBridgeWorker } from "../pm-worker-options.js";

type AgentLike = { adapterType: string; adapterConfig?: Record<string, unknown> | null; runtimeConfig?: Record<string, unknown> | null };
type SourceRow = {
  id: string; projectId: string; isPrimary?: boolean | null; sourceType?: string | null; cwd?: string | null;
  repoUrl?: string | null; repoRef?: string | null; metadata?: Record<string, unknown> | null;
};

/**
 * A plain CC Pocket shared worker on another Bridge host (not the controller). Its task runs in that host's
 * copy of a remote-managed project source; the controller never opens, provisions or probes that path.
 */
export function remoteBridgeWorkerHost(agent: AgentLike): string | null {
  if (!isBridgeWorker(agent)) return null;
  const host = agentHost(agent);
  return host === DEFAULT_BRIDGE_HOST ? null : host;
}

export type RemoteWorkerSourceResult =
  | { ok: true; row: SourceRow; cwd: string }
  | { ok: false; reason: "configured_workspace_unavailable" | "remote_worker_host_mismatch" | "remote_worker_path_invalid"; message: string };

/**
 * Select the task's source for a remote Bridge worker: the explicitly preferred source, else the project's primary
 * source, else its only source. It must be a remote-managed source registered on the worker's own host, with a
 * canonical absolute POSIX path that the Bridge verifies on that host.
 */
export function selectRemoteWorkerSource(rows: SourceRow[], preferredId: string | null, hostId: string): RemoteWorkerSourceResult {
  const row = preferredId ? rows.find(item => item.id === preferredId)
    : rows.find(item => item.isPrimary) ?? (rows.length === 1 ? rows[0] : undefined);
  if (!row) return { ok: false, reason: "configured_workspace_unavailable", message: "The task's project source is unavailable for this remote worker." };
  if (row.sourceType !== "remote_managed" || row.metadata?.hostId !== hostId) {
    return { ok: false, reason: "remote_worker_host_mismatch", message: `The task's project source is not registered on this worker's host (${hostId}).` };
  }
  const cwd = row.cwd ?? "";
  if (!cwd.startsWith("/") || path.posix.normalize(cwd) !== cwd || (cwd.length > 1 && cwd.endsWith("/"))) {
    return { ok: false, reason: "remote_worker_path_invalid", message: "The remote project source path is not a canonical absolute path." };
  }
  return { ok: true, row, cwd };
}
