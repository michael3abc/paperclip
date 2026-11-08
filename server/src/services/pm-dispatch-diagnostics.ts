import { and, eq, inArray } from "drizzle-orm";
import { agents, type Db } from "@paperclipai/db";
import { aiConnectionBindingSchema, pmWorkerManagedBlock, renderPmWorkerPolicy } from "@paperclipai/shared";
import { agentInstructionsService } from "./agent-instructions.js";
import { pmWorkerPolicyRevision } from "./pm-worker-policy.js";
import { workerPolicyLayout } from "./main-agent-workers.js";
import { pmWorkerModels } from "./pm-worker-catalog.js";
import { validateWorkerChoices, workerPermissionChoices } from "./pm-worker-options.js";
import { HttpError } from "../errors.js";
import type { PmCoordinationScope } from "./pm-coordination-policy.js";

/** On-demand metadata projection; no credentials, global config, or permission changes. */
export async function pmDispatchDiagnostics(db: Db, scope: PmCoordinationScope) {
  const policy = scope.delegation;
  const result = { revision: pmWorkerPolicyRevision(policy), version: policy?.version ?? null,
    defaultSelectionId: policy?.version === 2 ? policy.defaultSelectionId : null,
    documentSynchronized: false, blockers: [] as string[],
    selections: [] as Array<{ id: string; agentId: string; model: string; thinking: string | null; ready: boolean; blocker: string | null }> };
  if (policy?.version !== 2) { result.blockers.push("PM_WORKER_MIGRATION_REQUIRED"); return result; }
  const [owner] = await db.select().from(agents).where(and(eq(agents.id, scope.agentId), eq(agents.companyId, scope.companyId)));
  if (!owner || pmWorkerPolicyRevision(owner.runtimeConfig?.pmDelegation) !== result.revision) {
    result.blockers.push("PM_WORKER_POLICY_CHANGED"); return result;
  }
  const layout = workerPolicyLayout(owner);
  const document = await agentInstructionsService(db).readFile(owner, layout.workerDocumentPath);
  result.documentSynchronized = pmWorkerManagedBlock(document.content ?? "") === renderPmWorkerPolicy(policy, layout.version);
  if (!result.documentSynchronized) result.blockers.push("PM_WORKER_DOCUMENT_OUT_OF_SYNC");
  const workers = await db.select().from(agents).where(and(eq(agents.companyId, scope.companyId), inArray(agents.id, policy.workers.map(w => w.agentId))));
  for (const group of policy.workers) for (const choice of group.selections) {
    const worker = workers.find(w => w.id === group.agentId);
    let blocker: string | null = null;
    if (!worker || worker.adapterType !== group.harness || !(worker.runtimeConfig?.requireTaskWorktree === true || worker.runtimeConfig?.requireProjectWorkspace === true)
      || ["paused", "terminated", "pending_approval"].includes(worker.status) || worker.lifecycleState !== "ready") {
      blocker = "PM_WORKER_UNAVAILABLE";
    } else {
      try {
        const binding = aiConnectionBindingSchema.safeParse(worker.runtimeConfig?.aiConnection).data;
        validateWorkerChoices({ version: 2, defaultSelectionId: choice.id, workers: [{ ...group, selections: [choice] }] }, [{
          agentId: worker.id, name: worker.name, harness: group.harness,
          defaultAiConnection: binding?.mode === "responsible_user" ? undefined : binding,
          permissions: workerPermissionChoices(worker.adapterConfig ?? {}), models: await pmWorkerModels(db, worker, choice.aiConnection),
        }]);
      } catch (error) {
        if (!(error instanceof HttpError) || error.status < 400 || error.status >= 500) throw error;
        blocker = "PM_WORKER_SELECTION_UNAVAILABLE";
      }
    }
    result.selections.push({ id: choice.id, agentId: group.agentId, model: choice.model, thinking: choice.thinking,
      ready: !blocker && result.documentSynchronized, blocker });
  }
  return { ...result, documentPath: layout.workerDocumentPath, instruction: `Read current ${layout.workerDocumentPath} and select a stable option ID from this response. Ready describes saved dispatch metadata, not provider execution. Use this project's configured_source development checkout in shared mode by default. One writer holds it exclusively; additional writers wait. Select managed_isolated only when parallel writes or an independent version are needed. Read this project's sessions API for execution diagnostics; do not request full worker configuration.` };
}
