import { createHash } from "node:crypto";
import { and, eq, inArray } from "drizzle-orm";
import { agents, activityLog, type Db } from "@paperclipai/db";
import { pmWorkerPolicySchema, pmWorkerManagedBlock, renderPmWorkerPolicy, updatePmWorkerDocument,
  type PmWorkerCatalogEntry, type PmWorkerPolicyView, type SavePmWorkerPolicy } from "@paperclipai/shared";
import { listAdapterModels } from "../adapters/registry.js";
import { conflict, forbidden, unprocessable } from "../errors.js";
import type { AuthorizationActor } from "./authorization.js";
import { agentFileStore, readAgentFile, fileHash } from "./agent-file-store.js";
import { materializeInstructionBytes } from "./agent-instruction-files.js";
import { pmCoordinationScope, pmDelegationSchema } from "./pm-coordination-policy.js";
import { updateAgentConfigurationInTransaction } from "./agent-configuration-transaction.js";
import { validateWorkerChoices, workerModelChoices, workerPermissionChoices } from "./pm-worker-options.js";

export function pmWorkerPolicyRevision(value: unknown): string | null {
  const canonical = (input: unknown): unknown => Array.isArray(input) ? input.map(canonical)
    : input && typeof input === "object" ? Object.fromEntries(Object.entries(input).sort(([a], [b]) => a.localeCompare(b)).map(([key, item]) => [key, canonical(item)])) : input;
  return value == null ? null : createHash("sha256").update(JSON.stringify(canonical(value))).digest("hex");
}

export async function pmWorkerCatalog(db: Db, companyId: string): Promise<PmWorkerCatalogEntry[]> {
  const workers = await db.select().from(agents).where(and(eq(agents.companyId, companyId), inArray(agents.adapterType, ["claude_local", "codex_local"])));
  const eligible = workers.filter(worker => worker.runtimeConfig?.requireTaskWorktree === true
    && !["paused", "terminated", "pending_approval"].includes(worker.status));
  const models = new Map(await Promise.all([...new Set(eligible.map(worker => worker.adapterType))].map(async harness =>
    [harness, await listAdapterModels(harness)] as const)));
  return eligible.map(worker => {
    const harness = worker.adapterType as PmWorkerCatalogEntry["harness"];
    const permissions = workerPermissionChoices(worker.adapterConfig ?? {});
    return { agentId: worker.id, name: worker.name, harness, permissions, models: workerModelChoices(harness, models.get(harness) ?? []) };
  });
}

export function pmWorkerPolicyService(db: Db) {
  const files = agentFileStore(db);
  const requirePm = (agent: typeof agents.$inferSelect) => {
    if (!pmCoordinationScope({ ...agent, runtimeConfig: { ...agent.runtimeConfig, pmDelegation: undefined } })) throw unprocessable("Worker policy belongs to a coordination-only project PM");
  };
  return {
    read: async (companyId: string, agentId: string, actor: AuthorizationActor): Promise<PmWorkerPolicyView> => {
      const catalog = await pmWorkerCatalog(db, companyId);
      return files.locked(companyId, agentId, actor, false, async (_tx, agent, root) => {
        requirePm(agent);
        const bytes = await readAgentFile(root, "WORKERS.md");
        const document = bytes?.toString("utf8") ?? "";
        const raw = agent.runtimeConfig?.pmDelegation;
        const parsed = pmWorkerPolicySchema.safeParse(raw);
        const warnings: string[] = [];
        if (!parsed.success) {
          warnings.push("Existing worker settings require explicit migration. Review WORKERS.md and select every field; no legacy list is imported automatically.");
          const legacy = pmDelegationSchema.safeParse(raw);
          if (legacy.success && legacy.data.version === 1) {
            warnings.push("Legacy settings have no stable option IDs, explicit permission or unique default. Confirm these fields before dispatch.");
            for (const worker of legacy.data.workers) for (const choice of worker.selections) {
              warnings.push(`Historical worker ${worker.agentId}: model=${choice.model}; thinking=${choice.effort ?? choice.modelReasoningEffort ?? "unspecified"}; speed=${choice.fastMode === undefined ? "unspecified" : choice.fastMode ? "fast" : "standard"}. Confirm harness against the current worker catalog.`);
            }
          }
        }
        else {
          try {
            if (pmWorkerManagedBlock(document) !== renderPmWorkerPolicy(parsed.data)) warnings.push("WORKERS.md is out of sync. New dispatch is blocked until the policy is saved successfully.");
            validateWorkerChoices(parsed.data, catalog);
          } catch (error) { warnings.push(error instanceof Error ? error.message : String(error)); }
        }
        return { policy: parsed.success ? parsed.data : null, revision: pmWorkerPolicyRevision(raw),
          documentHash: bytes ? fileHash(bytes) : null, document, catalog, warnings };
      });
    },
    save: async (companyId: string, agentId: string, input: SavePmWorkerPolicy, actor: AuthorizationActor) => {
      if (actor.type !== "board") throw forbidden("Only an Owner can change PM worker settings");
      const policy = pmWorkerPolicySchema.parse(input.policy);
      validateWorkerChoices(policy, await pmWorkerCatalog(db, companyId));
      return files.locked(companyId, agentId, actor, true, async (tx, agent, root) => {
        requirePm(agent);
        const previous = await readAgentFile(root, "WORKERS.md");
        if (pmWorkerPolicyRevision(agent.runtimeConfig?.pmDelegation) !== input.baseRevision
          || (previous ? fileHash(previous) : null) !== input.baseHash) throw conflict("Worker settings or WORKERS.md changed. Reload before saving.", { code: "PM_WORKER_POLICY_CONFLICT" });
        // Recheck identity under the same transaction as the owner update.
        const selected = await tx.select().from(agents).where(and(eq(agents.companyId, companyId), inArray(agents.id, policy.workers.map(worker => worker.agentId))));
        if (policy.workers.some(worker => !selected.some(row => row.id === worker.agentId && row.adapterType === worker.harness
          && row.runtimeConfig?.requireTaskWorktree === true && worker.selections.every(choice => workerPermissionChoices(row.adapterConfig ?? {}).includes(choice.permission)) && !["paused", "terminated", "pending_approval"].includes(row.status)))) throw unprocessable("A selected worker changed while saving");
        const document = updatePmWorkerDocument(previous?.toString("utf8") ?? "", policy);
        const bytes = Buffer.from(document);
        if (bytes.length > 1024 * 1024) throw unprocessable("WORKERS.md exceeds 1 MiB");
        await updateAgentConfigurationInTransaction(tx as unknown as Db, agentId, { runtimeConfig: { ...agent.runtimeConfig, pmDelegation: policy } },
          { allowPmWorkerPolicyUpdate: true, recordRevision: { source: "api", createdByUserId: actor.type === "board" ? actor.userId : null } });
        await materializeInstructionBytes(root, "WORKERS.md", bytes);
        await tx.insert(activityLog).values({ companyId, actorType: actor.type === "board" ? "user" : "agent",
          actorId: actor.type === "board" ? actor.userId ?? "board" : actor.agentId!, action: "agent.worker_policy_updated",
          entityType: "agent", entityId: agentId, details: { revision: pmWorkerPolicyRevision(policy), documentHash: fileHash(bytes), policy,
            previousPolicy: agent.runtimeConfig?.pmDelegation ?? null } });
        return { revision: pmWorkerPolicyRevision(policy), documentHash: fileHash(bytes), policy };
      });
    },
  };
}
