import { and, eq, or } from "drizzle-orm";
import { agents, toolConnections, connectionGrants, toolConnectionInstalls, type Db } from "@paperclipai/db";
import { aiConnectionBindingSchema, aiConnectionMetadataSchema, isAiConnectionCompatible, type AiConnectionBinding, type PmWorkerCatalogEntry } from "@paperclipai/shared";
import { listAdapterModels } from "../adapters/registry.js";
import { unprocessable } from "../errors.js";
import { bridgeWorkerSupportsHost } from "./bridge-worker-routing.js";
import { agentHost, bridgeWorkerProvider, workerModelChoices } from "./pm-worker-options.js";

type Worker = Pick<typeof agents.$inferSelect, "id" | "companyId" | "adapterType" | "runtimeConfig"> & { adapterConfig?: Record<string, unknown> | null };
/** Metadata only. Credential sharing is independently checked on save and every run. */
export async function pmWorkerModels(db: Db, worker: Worker, requested?: AiConnectionBinding, hostId = agentHost(worker)): Promise<PmWorkerCatalogEntry["models"]> {
  const harness = worker.adapterType as PmWorkerCatalogEntry["harness"];
  if (harness === "ccpocket_bridge") {
    // Bridge workers sign in with the host's own account inside that Bridge; Paperclip AI connections never apply.
    if (requested) throw unprocessable("Bridge workers do not use AI connections", { code: "PM_WORKER_CONNECTION_UNAVAILABLE" });
    const provider = bridgeWorkerProvider(worker);
    const prefix = provider && bridgeWorkerSupportsHost(worker, hostId) ? `${hostId}/${provider}/` : null;
    if (!provider || !prefix) return [];
    return workerModelChoices(harness, (await listAdapterModels(harness, { companyId: worker.companyId, hostId, provider })).filter(model => model.id.startsWith(prefix)), provider);
  }
  const raw = requested ?? worker.runtimeConfig?.aiConnection;
  if (!raw) return workerModelChoices(harness, await listAdapterModels(harness));
  const binding = aiConnectionBindingSchema.parse(raw);
  if (binding.mode === "responsible_user") throw unprocessable("Select an explicit worker AI connection before configuring worker options");
  const [row] = await db.select({ metadata: toolConnections.config, name: toolConnections.name })
    .from(toolConnections).innerJoin(connectionGrants, and(eq(connectionGrants.connectionId, toolConnections.id), eq(connectionGrants.companyId, worker.companyId), eq(connectionGrants.id, binding.grantId), eq(connectionGrants.status, "active")))
    .where(and(eq(toolConnections.companyId, worker.companyId), eq(toolConnections.id, binding.connectionId), eq(toolConnections.connectionPurpose, "ai"), eq(toolConnections.enabled, true), eq(toolConnections.status, "active"), eq(toolConnections.healthStatus, "ok"))).limit(1);
  const [install] = await db.select({ id: toolConnectionInstalls.id }).from(toolConnectionInstalls).where(and(
    eq(toolConnectionInstalls.companyId, worker.companyId), eq(toolConnectionInstalls.connectionId, binding.connectionId),
    or(and(eq(toolConnectionInstalls.targetType, "company"), eq(toolConnectionInstalls.targetId, worker.companyId)), and(eq(toolConnectionInstalls.targetType, "agent"), eq(toolConnectionInstalls.targetId, worker.id))))).limit(1);
  if (!row || !install) throw unprocessable("The selected worker AI connection is unavailable or not installed", { code: "PM_WORKER_CONNECTION_UNAVAILABLE" });
  const metadata = aiConnectionMetadataSchema.parse(row.metadata.ai);
  if (metadata.provider !== binding.provider || metadata.method !== binding.method || !isAiConnectionCompatible(metadata, harness)) throw unprocessable("Worker connection does not support this harness");
  const models = metadata.routing ? metadata.routing.models.map(model => ({ id: model.id, label: model.label ?? model.id })) : await listAdapterModels(harness);
  return workerModelChoices(harness, models).map(model => ({ ...model, label: `${model.label} · ${row.name}`, aiConnection: binding }));
}
