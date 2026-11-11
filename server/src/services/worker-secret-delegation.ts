import { and, eq, inArray } from "drizzle-orm";
import { agents, companySecretBindings, heartbeatRuns, issues, projects, type Db } from "@paperclipai/db";
import { z } from "zod";
import { conflict, forbidden, notFound } from "../errors.js";
import { logActivity } from "./activity-log.js";
import { secretService } from "./secrets.js";
import { eligibleSecretWorker, sourceBindingHash, workerSecretProvenance, WORKER_ACCESS_PREFIX } from "./worker-secret-access.js";

export const delegateWorkerSecretSchema = z.object({
  issueId: z.string().uuid(), workerAgentId: z.string().uuid(),
  key: z.string().min(1).max(120), reason: z.string().trim().min(1).max(500),
}).strict();
type Context = Parameters<ReturnType<typeof secretService>["listAgentSecretAccess"]>[1];

export function workerSecretDelegationService(db: Db) {
  async function lockActor(tx: Db, context: Context, companyId: string) {
    if (context.actorSource !== "agent_jwt" || (context.keyScope && context.keyScope.kind !== "standard")) {
      throw forbidden("Worker secret delegation requires a standard run-bound agent token");
    }
    const [run] = await tx.select().from(heartbeatRuns).where(and(
      eq(heartbeatRuns.id, context.heartbeatRunId), eq(heartbeatRuns.companyId, companyId),
      eq(heartbeatRuns.agentId, context.agentId), eq(heartbeatRuns.status, "running"),
    )).for("update");
    if (!run) throw forbidden("Worker secret delegation requires a running agent");
  }
  return {
    list: async (companyId: string, context: Context, issueId: string) => db.transaction(async transaction => {
      const tx = transaction as unknown as Db;
      await lockActor(tx, context, companyId);
      const [task] = await tx.select().from(issues).where(and(eq(issues.id, issueId), eq(issues.companyId, companyId), eq(issues.createdByAgentId, context.agentId)));
      if (!task) throw forbidden("Only your own task delegations are readable");
      const rows = await tx.select().from(companySecretBindings).where(and(eq(companySecretBindings.companyId, companyId), eq(companySecretBindings.targetType, "issue"), eq(companySecretBindings.targetId, issueId)));
      return { delegations: rows.filter(row => workerSecretProvenance(row)?.agentId === context.agentId).map(row => {
        const [, workerAgentId, ...key] = row.configPath.split(".");
        return { bindingId: row.id, issueId, workerAgentId, key: key.join("."), version: Number(row.versionSelector), delivery: "api" as const };
      }) };
    }),
    delegate: async (companyId: string, context: Context, input: z.infer<typeof delegateWorkerSecretSchema>) => db.transaction(async transaction => {
      const tx = transaction as unknown as Db;
      await lockActor(tx, context, companyId);
      const people = await tx.select().from(agents).where(and(
        eq(agents.companyId, companyId), inArray(agents.id, [context.agentId, input.workerAgentId]),
      )).orderBy(agents.id).for("share");
      const owner = people.find(row => row.id === context.agentId);
      const worker = people.find(row => row.id === input.workerAgentId);
      const [task] = await tx.select().from(issues).where(and(eq(issues.id, input.issueId), eq(issues.companyId, companyId))).for("update");
      if (!owner || !worker || !task?.projectId || task.createdByAgentId !== owner.id
        || task.assigneeAgentId !== worker.id || ["done", "cancelled"].includes(task.status)
        || !eligibleSecretWorker(owner, worker, task.projectId)) throw forbidden("Secret delegation requires your own task and an approved worker");
      const [project] = await tx.select().from(projects).where(and(eq(projects.id, task.projectId), eq(projects.companyId, companyId))).for("share");
      if (!project || project.archivedAt || project.leadAgentId !== owner.id) throw forbidden("Only the current project main agent may delegate secrets");
      const available = await secretService(tx).listAgentSecretAccess(companyId, context);
      const source = available.find(entry => entry.key === input.key);
      if (!source || source.configPath.startsWith(WORKER_ACCESS_PREFIX)) throw forbidden("Secret access is not granted to this main agent");
      const [binding] = await tx.select().from(companySecretBindings).where(and(
        eq(companySecretBindings.companyId, companyId), eq(companySecretBindings.id, source.bindingId),
      )).for("share");
      if (!binding || binding.secretId !== source.secretId || binding.configPath !== source.configPath
        || binding.versionSelector !== String(source.versionSelector)) throw conflict("Source secret binding changed; reload your accessible secrets");
      const configPath = `${WORKER_ACCESS_PREFIX}${worker.id}.${source.key}`;
      const [existing] = await tx.select().from(companySecretBindings).where(and(
        eq(companySecretBindings.companyId, companyId), eq(companySecretBindings.targetType, "issue"),
        eq(companySecretBindings.targetId, task.id), eq(companySecretBindings.configPath, configPath),
      ));
      if (existing) {
        const provenance = workerSecretProvenance(existing);
        if (existing.secretId !== source.secretId || existing.versionSelector !== String(source.resolvedVersion)
          || provenance?.agentId !== owner.id || provenance.sourceBindingId !== binding.id
          || provenance.sourceHash !== sourceBindingHash(binding)) throw conflict("An existing delegation differs; revoke it before replacing it");
        return { bindingId: existing.id, issueId: task.id, workerAgentId: worker.id, key: source.key, version: source.resolvedVersion, delivery: "api" as const };
      }
      // References and a pinned version only; never resolve or copy credential bytes.
      const [saved] = await tx.insert(companySecretBindings).values({
        companyId, secretId: source.secretId, targetType: "issue", targetId: task.id, configPath,
        versionSelector: String(source.resolvedVersion), required: true,
        projectionClass: binding.projectionClass, projectionAllowlistKey: binding.projectionAllowlistKey,
        label: JSON.stringify({ kind: "worker-secret-delegation.v1", agentId: owner.id, runId: context.heartbeatRunId,
          sourceBindingId: binding.id, sourceHash: sourceBindingHash(binding) }),
      }).returning();
      await logActivity(tx, { companyId, actorType: "agent", actorId: owner.id, agentId: owner.id,
        runId: context.heartbeatRunId, issueId: task.id, action: "secret.worker_delegated", entityType: "secret_binding", entityId: saved.id,
        details: { issueId: task.id, workerAgentId: worker.id, secretRef: source.secretId, version: source.resolvedVersion, reason: input.reason } });
      return { bindingId: saved.id, issueId: task.id, workerAgentId: worker.id, key: source.key, version: source.resolvedVersion, delivery: "api" as const };
    }),
    revoke: async (companyId: string, context: Context, bindingId: string) => db.transaction(async transaction => {
      const tx = transaction as unknown as Db;
      await lockActor(tx, context, companyId);
      const [binding] = await tx.select().from(companySecretBindings).where(and(eq(companySecretBindings.companyId, companyId), eq(companySecretBindings.id, bindingId))).for("update");
      if (!binding) throw notFound("Secret delegation not found");
      if (workerSecretProvenance(binding)?.agentId !== context.agentId) throw forbidden("Only the delegating agent may revoke this binding");
      await tx.delete(companySecretBindings).where(eq(companySecretBindings.id, binding.id));
      await logActivity(tx, { companyId, actorType: "agent", actorId: context.agentId, agentId: context.agentId,
        runId: context.heartbeatRunId, issueId: binding.targetId, action: "secret.worker_revoked", entityType: "secret_binding", entityId: binding.id, details: { issueId: binding.targetId } });
      return { ok: true };
    }),
  };
}
