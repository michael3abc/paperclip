import { createHash } from "node:crypto";
import { and, eq, inArray, isNull, like, or } from "drizzle-orm";
import { agents, companySecretBindings, heartbeatRuns, issues, projects, type Db } from "@paperclipai/db";
import { z } from "zod";
import { authorizationService } from "./authorization.js";
import { mainAgentDispatchScope } from "./main-agent-workers.js";
import { agentHost, isPmWorkerAgent } from "./pm-worker-options.js";

export const WORKER_ACCESS_PREFIX = "worker_access.";
type Binding = typeof companySecretBindings.$inferSelect;
const provenanceSchema = z.object({
  kind: z.literal("worker-secret-delegation.v1"),
  agentId: z.string().uuid(),
  runId: z.string().uuid(),
  sourceBindingId: z.string().uuid(),
  sourceHash: z.string().regex(/^[a-f0-9]{64}$/),
}).strict();
export type WorkerSecretProvenance = z.infer<typeof provenanceSchema>;

export function sourceBindingHash(binding: Binding): string {
  return createHash("sha256").update(JSON.stringify([
    binding.companyId, binding.secretId, binding.targetType, binding.targetId,
    binding.configPath, binding.versionSelector, binding.projectionClass,
    binding.projectionAllowlistKey, binding.required,
  ])).digest("hex");
}

export function workerSecretProvenance(binding: Binding): WorkerSecretProvenance | null {
  if (!binding.configPath.startsWith(WORKER_ACCESS_PREFIX) || !binding.label) return null;
  try { return provenanceSchema.parse(JSON.parse(binding.label)); }
  catch { return null; }
}

export function eligibleSecretWorker(owner: typeof agents.$inferSelect, worker: typeof agents.$inferSelect, projectId: string): boolean {
  const scope = mainAgentDispatchScope(owner);
  return Boolean(scope && scope.projectId === projectId && owner.companyId === worker.companyId
    && !["paused", "terminated", "pending_approval"].includes(owner.status)
    && !["paused", "terminated", "pending_approval"].includes(worker.status)
    && isPmWorkerAgent(worker) && agentHost(owner) === agentHost(worker)
    && (worker.runtimeConfig?.requireTaskWorktree === true || worker.runtimeConfig?.requireProjectWorkspace === true)
    && scope.delegation?.version === 2
    && scope.delegation.workers.some(entry => entry.agentId === worker.id && entry.harness === worker.adapterType));
}

/** Request-only reads; only the exact task currently owned by this run supplies grants. */
export async function loadWorkerSecretBindings(db: Db, companyId: string, agentId: string, runId: string): Promise<Binding[]> {
  const [task] = await db.select().from(issues).where(and(
    eq(issues.companyId, companyId), eq(issues.assigneeAgentId, agentId),
    or(eq(issues.executionRunId, runId), and(isNull(issues.executionRunId), eq(issues.checkoutRunId, runId))),
  ));
  if (!task?.projectId || !task.createdByAgentId || ["done", "cancelled"].includes(task.status)) return [];
  const [project] = await db.select().from(projects).where(and(eq(projects.id, task.projectId), eq(projects.companyId, companyId)));
  if (!project || project.archivedAt || project.leadAgentId !== task.createdByAgentId) return [];
  const people = await db.select().from(agents).where(and(eq(agents.companyId, companyId), inArray(agents.id, [agentId, task.createdByAgentId])));
  const owner = people.find(row => row.id === task.createdByAgentId);
  const worker = people.find(row => row.id === agentId);
  if (!owner || !worker || !eligibleSecretWorker(owner, worker, task.projectId)) return [];
  const bindings = await db.select().from(companySecretBindings).where(and(
    eq(companySecretBindings.companyId, companyId), eq(companySecretBindings.targetType, "issue"),
    eq(companySecretBindings.targetId, task.id), like(companySecretBindings.configPath, `${WORKER_ACCESS_PREFIX}${agentId}.%`),
  ));
  const entries = bindings.flatMap(binding => {
    const provenance = workerSecretProvenance(binding);
    return provenance?.agentId === owner.id ? [{ binding, provenance }] : [];
  });
  if (!entries.length) return [];
  const sources = await db.select().from(companySecretBindings).where(and(
    eq(companySecretBindings.companyId, companyId), inArray(companySecretBindings.id, entries.map(entry => entry.provenance.sourceBindingId)),
  ));
  const runs = await db.select().from(heartbeatRuns).where(and(
    eq(heartbeatRuns.companyId, companyId), eq(heartbeatRuns.agentId, owner.id),
    inArray(heartbeatRuns.id, entries.map(entry => entry.provenance.runId)),
  ));
  const authorization = authorizationService(db);
  const authorizedRuns = new Set((await Promise.all(runs.map(async run => {
    const decision = await authorization.decide({
      actor: { type: "agent", companyId, agentId: owner.id, source: "agent_jwt", runId: run.id, keyScope: { kind: "standard" } },
      action: "secrets:read", resource: { type: "company", companyId },
    });
    return decision.allowed ? run.id : null;
  }))).filter((id): id is string => id !== null));
  return entries.flatMap(({ binding, provenance }) => {
    if (!authorizedRuns.has(provenance.runId)) return [];
    const source = sources.find(row => row.id === provenance.sourceBindingId);
    if (!source || source.secretId !== binding.secretId || sourceBindingHash(source) !== provenance.sourceHash) return [];
    if (source.targetType === "agent" && source.targetId === owner.id) return [binding];
    const run = runs.find(row => row.id === provenance.runId);
    const manifest = (run?.contextSnapshot?.paperclipSecrets as { manifest?: { bindingId?: string }[] } | undefined)?.manifest;
    return Array.isArray(manifest) && manifest.some(entry => entry.bindingId === source.id) ? [binding] : [];
  });
}
