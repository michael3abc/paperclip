import { aiConnectionBindingSchema, isAiConnectionCompatible } from "@paperclipai/shared";
import { aiConnectionService } from "./ai-connections.js";
import { pmWorkerModels } from "./pm-worker-catalog.js";
import { HttpError } from "../errors.js";
import { isDeepStrictEqual } from "node:util";
import { createHash } from "node:crypto";
import { and, eq, inArray } from "drizzle-orm";
import { agents, activityLog, type Db } from "@paperclipai/db";
import { pmWorkerPolicySchema, pmWorkerManagedBlock, renderPmWorkerPolicy, updatePmWorkerDocument,
  type PmWorkerCatalogEntry, type PmWorkerPolicyView, type SavePmWorkerPolicy } from "@paperclipai/shared";
import { conflict, forbidden, unprocessable } from "../errors.js";
import type { AuthorizationActor } from "./authorization.js";
import { agentFileStore, readAgentFile, fileHash } from "./agent-file-store.js";
import { materializeInstructionBytes } from "./agent-instruction-files.js";
import { pmCoordinationScope, pmDelegationSchema } from "./pm-coordination-policy.js";
import { mainAgentProjectId, workerPolicyLayout } from "./main-agent-workers.js";
import { updateAgentConfigurationInTransaction } from "./agent-configuration-transaction.js";
import { agentHost, bridgeWorkerProvider, isPmWorkerAgent, validateWorkerChoices, workerPermissionChoices } from "./pm-worker-options.js";

export function pmWorkerPolicyRevision(value: unknown): string | null {
  const canonical = (input: unknown): unknown => Array.isArray(input) ? input.map(canonical)
    : input && typeof input === "object" ? Object.fromEntries(Object.entries(input).sort(([a], [b]) => a.localeCompare(b)).map(([key, item]) => [key, canonical(item)])) : input;
  return value == null ? null : createHash("sha256").update(JSON.stringify(canonical(value))).digest("hex");
}

export async function pmWorkerCatalog(db: Db, companyId: string, userId?: string | null): Promise<PmWorkerCatalogEntry[]> {
  const workers = await db.select().from(agents).where(and(eq(agents.companyId, companyId), inArray(agents.adapterType, ["claude_local", "codex_local", "ccpocket_bridge"])));
  const eligible = workers.filter(worker => isPmWorkerAgent(worker) && (worker.runtimeConfig?.requireTaskWorktree === true || worker.runtimeConfig?.requireProjectWorkspace === true)
    && !["paused", "terminated", "pending_approval"].includes(worker.status));
  const connectionService = aiConnectionService(db);
  const connections = userId ? await connectionService.list(companyId, userId) : [];
  return Promise.all(eligible.map(async worker => {
    const harness = worker.adapterType as PmWorkerCatalogEntry["harness"];
    const permissions = workerPermissionChoices(worker.adapterConfig ?? {}, harness);
    if (harness === "ccpocket_bridge") return { agentId: worker.id, name: worker.name, harness, provider: bridgeWorkerProvider(worker)!,
      hostId: agentHost(worker), permissions, models: await pmWorkerModels(db, worker) };
    const parsedBinding = aiConnectionBindingSchema.safeParse(worker.runtimeConfig?.aiConnection).data;
    const defaultAiConnection = parsedBinding?.mode === "responsible_user" ? undefined : parsedBinding;
    const models = await pmWorkerModels(db, worker);
    for (const connection of connections) {
      if (connection.status !== "connected" || !isAiConnectionCompatible(connection, harness)) continue;
      const binding = aiConnectionBindingSchema.parse({ provider: connection.provider, method: connection.method,
        mode: connection.ownership === "personal" ? "delegated" : "shared", connectionId: connection.id, grantId: connection.grantId });
      if (isDeepStrictEqual(binding, defaultAiConnection)) continue;
      try {
        await connectionService.select({ companyId, userId: userId!, agentId: worker.id, adapterType: harness, binding });
      } catch (error) {
        if (error instanceof HttpError && [403, 422].includes(error.status)) continue;
        throw error;
      }
      models.push(...await pmWorkerModels(db, worker, binding));
    }
    return { agentId: worker.id, name: worker.name, harness, hostId: agentHost(worker), permissions, models, ...(defaultAiConnection ? { defaultAiConnection } : {}) };
  }));
}

/** Catalog entries whose worker runs on the same Bridge host as the main agent or PM that dispatches them. */
export function sameHostCatalog(catalog: PmWorkerCatalogEntry[], owner: Parameters<typeof agentHost>[0]): PmWorkerCatalogEntry[] {
  const host = agentHost(owner);
  return catalog.filter(entry => (entry.hostId ?? "michael-server") === host);
}

export function pmWorkerPolicyService(db: Db) {
  const files = agentFileStore(db);
  const requirePm = (agent: typeof agents.$inferSelect) => {
    if (!mainAgentProjectId(agent) && !pmCoordinationScope({ ...agent, runtimeConfig: { ...agent.runtimeConfig, pmDelegation: undefined } })) {
      throw unprocessable("Worker policy belongs to a coordination-only project PM or a project main agent");
    }
  };
  return {
    read: async (companyId: string, agentId: string, actor: AuthorizationActor): Promise<PmWorkerPolicyView> => {
      const fullCatalog = await pmWorkerCatalog(db, companyId, actor.type === "board" ? actor.userId : undefined);
      return files.locked(companyId, agentId, actor, false, async (_tx, agent, root) => {
        requirePm(agent);
        // Workers run on their own Bridge host; offer only those on the main agent's host.
        const catalog = sameHostCatalog(fullCatalog, agent);
        const layout = workerPolicyLayout(agent);
        const bytes = await readAgentFile(root, layout.workerDocumentPath);
        const document = bytes?.toString("utf8") ?? "";
        const raw = agent.runtimeConfig?.pmDelegation;
        const parsed = pmWorkerPolicySchema.safeParse(raw);
        const warnings: string[] = [];
        if (!parsed.success) {
          warnings.push("Existing worker settings require explicit migration. Review worker settings and select every field; no legacy list is imported automatically.");
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
            if (pmWorkerManagedBlock(document) !== renderPmWorkerPolicy(parsed.data, layout.version)) warnings.push(`${layout.workerDocumentPath} is out of sync. New dispatch is blocked until the policy is saved successfully.`);
            validateWorkerChoices(parsed.data, catalog);
          } catch (error) { warnings.push(error instanceof Error ? error.message : String(error)); }
        }
        return { documentPath: layout.workerDocumentPath, policy: parsed.success ? parsed.data : null, revision: pmWorkerPolicyRevision(raw),
          documentHash: bytes ? fileHash(bytes) : null, document, catalog, warnings };
      });
    },
    save: async (companyId: string, agentId: string, input: SavePmWorkerPolicy, actor: AuthorizationActor) => {
      if (actor.type !== "board") throw forbidden("Only an Owner can change PM worker settings");
      const policy = pmWorkerPolicySchema.parse(input.policy);
      const fullCatalog = await pmWorkerCatalog(db, companyId, actor.type === "board" ? actor.userId : undefined);
      validateWorkerChoices(policy, fullCatalog);
      for (const worker of policy.workers) for (const choice of worker.selections) {
        if (choice.aiConnection) await aiConnectionService(db).select({ companyId, userId: actor.userId ?? null,
          agentId: worker.agentId, adapterType: worker.harness, model: choice.model, binding: choice.aiConnection });
      }
      return files.locked(companyId, agentId, actor, true, async (tx, agent, root) => {
        requirePm(agent);
        validateWorkerChoices(policy, sameHostCatalog(fullCatalog, agent), "PM_WORKER_HOST_MISMATCH");
        const layout = workerPolicyLayout(agent);
        const previous = await readAgentFile(root, layout.workerDocumentPath);
        if (pmWorkerPolicyRevision(agent.runtimeConfig?.pmDelegation) !== input.baseRevision
          || (previous ? fileHash(previous) : null) !== input.baseHash) throw conflict("Worker settings or the instruction document changed. Reload before saving.", { code: "PM_WORKER_POLICY_CONFLICT" });
        // Recheck identity under the same transaction as the owner update.
        const selected = await tx.select().from(agents).where(and(eq(agents.companyId, companyId), inArray(agents.id, policy.workers.map(worker => worker.agentId))));
        if (policy.workers.some(worker => !selected.some(row => row.id === worker.agentId && row.adapterType === worker.harness && isPmWorkerAgent(row)
          && agentHost(row) === agentHost(agent) && (row.runtimeConfig?.requireTaskWorktree === true || row.runtimeConfig?.requireProjectWorkspace === true) && worker.selections.every(choice => workerPermissionChoices(row.adapterConfig ?? {}, row.adapterType).includes(choice.permission)) && !["paused", "terminated", "pending_approval"].includes(row.status)))) throw unprocessable("A selected worker changed while saving");
        const document = updatePmWorkerDocument(previous?.toString("utf8") ?? "", policy, layout.version);
        const bytes = Buffer.from(document);
        if (bytes.length > 1024 * 1024) throw unprocessable(`${layout.workerDocumentPath} exceeds 1 MiB`);
        await updateAgentConfigurationInTransaction(tx as unknown as Db, agentId, { runtimeConfig: { ...agent.runtimeConfig, pmDelegation: policy } },
          { allowPmWorkerPolicyUpdate: true, recordRevision: { source: "api", createdByUserId: actor.type === "board" ? actor.userId : null } });
        await materializeInstructionBytes(root, layout.workerDocumentPath, bytes);
        await tx.insert(activityLog).values({ companyId, actorType: actor.type === "board" ? "user" : "agent",
          actorId: actor.type === "board" ? actor.userId ?? "board" : actor.agentId!, action: "agent.worker_policy_updated",
          entityType: "agent", entityId: agentId, details: { revision: pmWorkerPolicyRevision(policy), documentHash: fileHash(bytes), policy,
            previousPolicy: agent.runtimeConfig?.pmDelegation ?? null } });
        return { documentPath: layout.workerDocumentPath, revision: pmWorkerPolicyRevision(policy), documentHash: fileHash(bytes), policy };
      });
    },
  };
}
