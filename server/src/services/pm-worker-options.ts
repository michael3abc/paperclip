import { isDeepStrictEqual } from "node:util";
import { claudeLocalReasoningEffortsForModel } from "@paperclipai/adapter-claude-local";
import { codexLocalReasoningEffortsForModel, isCodexLocalFastModeSupported, normalizeCodexModel } from "@paperclipai/adapter-codex-local";
import type { PmWorkerCatalogEntry, PmWorkerHarness, PmWorkerPolicy, PmWorkerSelection } from "@paperclipai/shared";
import { unprocessable } from "../errors.js";

type WorkerAgent = { adapterType: string; adapterConfig?: Record<string, unknown> | null; runtimeConfig?: Record<string, unknown> | null };

/** The controller's own Bridge host; the CC Pocket adapter uses it when `hostId` is unset. */
export const DEFAULT_BRIDGE_HOST = "michael-server";
export type BridgeWorkerProvider = "claude" | "codex" | "antigravity";

/**
 * CC Pocket Bridge agents become policy workers only as plain shared workers: explicit provider `claude`, `codex`
 * or `antigravity`, no main-agent role, no project-PM binding, no fixed workspace binding and no Bridge
 * worker-preset fields. The worker runs on its own Bridge host (`hostId`, default michael-server) and is offered
 * only to main agents on that same host.
 */
export function bridgeWorkerProvider(agent: WorkerAgent): BridgeWorkerProvider | null {
  const config = agent.adapterConfig ?? {};
  const binding = agent.runtimeConfig?.workspaceBinding as { mode?: unknown } | undefined;
  if (agent.adapterType !== "ccpocket_bridge" || !["claude", "codex", "antigravity"].includes(config.provider as string)) return null;
  if ((config.role !== undefined && config.role !== "") || binding !== undefined && binding !== null) return null;
  if (!["defaultWorker", "allowedWorkers", "isolation", "worker"].every(key => config[key] === undefined || config[key] === "")) return null;
  return config.provider as BridgeWorkerProvider;
}

export function isBridgeWorker(agent: WorkerAgent): boolean {
  return bridgeWorkerProvider(agent) !== null;
}

/** Historical name: plain Antigravity Bridge worker. */
export function isAntigravityBridgeWorker(agent: WorkerAgent): boolean {
  return bridgeWorkerProvider(agent) === "antigravity";
}

/** Agents that may appear in an Owner-managed worker policy (status and workspace gates are checked separately). */
export function isPmWorkerAgent(agent: WorkerAgent): agent is WorkerAgent & { adapterType: PmWorkerHarness } {
  return agent.adapterType === "claude_local" || agent.adapterType === "codex_local" || agent.adapterType === "agy_local" || isBridgeWorker(agent);
}

/** Bridge host that runs an agent: the CC Pocket `hostId`, otherwise the controller's own host. */
export function agentHost(agent: WorkerAgent): string {
  const hostId = agent.adapterType === "ccpocket_bridge" ? agent.adapterConfig?.hostId : undefined;
  return typeof hostId === "string" && hostId ? hostId : DEFAULT_BRIDGE_HOST;
}

/** Host that holds a project source: a remote-managed source names its host; others live on the controller. */
export function projectSourceHost(source: { sourceType?: string | null; metadata?: Record<string, unknown> | null }): string | null {
  if (source.sourceType !== "remote_managed") return DEFAULT_BRIDGE_HOST;
  const hostId = source.metadata?.hostId;
  return typeof hostId === "string" && hostId ? hostId : null;
}

/** Model ID prefix (`<host>/<engine>/`) a CC Pocket worker can run. */
export function bridgeWorkerModelPrefix(agent: WorkerAgent): string | null {
  const provider = bridgeWorkerProvider(agent);
  return provider ? `${agentHost(agent)}/${provider}/` : null;
}

/** Historical helper kept for callers that only know the adapter config of an Antigravity worker. */
export function antigravityWorkerModelPrefix(config: Record<string, unknown>): string {
  return `${typeof config.hostId === "string" && config.hostId ? config.hostId : DEFAULT_BRIDGE_HOST}/antigravity/`;
}

export function workerPermissionChoices(config: Record<string, unknown>, harness?: string): PmWorkerCatalogEntry["permissions"] {
  if ([config.extraArgs, config.args].some(value => Array.isArray(value) && value.length > 0)) return [];
  if (harness === "agy_local") return ["default", "full-access"];
  // Bridge workers: the Bridge's default permission mode or explicit Full access (Antigravity
  // --dangerously-skip-permissions, Claude bypassPermissions, Codex danger-full-access).
  if (harness === "ccpocket_bridge") return ["claude", "codex", "antigravity"].includes(config.provider as string) ? ["default", "full-access"] : [];
  const engine = config.engine ?? "auto";
  if (engine === "cli") return ["default", "full-access"];
  if (engine === "auto" || engine === "acp") return ["deny-all", "approve-reads", "approve-all"];
  return [];
}

export function workerModelChoices(harness: PmWorkerCatalogEntry["harness"], models: { id: string; label: string }[], engine: BridgeWorkerProvider = "antigravity"): PmWorkerCatalogEntry["models"] {
  if (harness === "agy_local") return models.map(model => ({ ...model, speeds: ["standard"],
    thinking: model.id.match(/-(low|medium|high|xhigh|max)$/i)?.slice(1) ?? ["low", "medium", "high", "xhigh", "max"],
  }));
  if (harness === "ccpocket_bridge") {
    // CC Pocket model IDs are `<host>/<engine>/<model>`; efforts come from the host's own engine probe. No fast tier.
    return models.filter(model => model.id.split("/")[1] === engine).map(model => {
      const efforts = (model as { efforts?: unknown }).efforts;
      return { id: model.id, label: model.label, speeds: ["standard"],
        thinking: Array.isArray(efforts) ? efforts.filter((value): value is string => typeof value === "string" && value.length > 0) : [] };
    });
  }
  return models.filter(model => harness !== "codex_local" || normalizeCodexModel(model.id) === model.id).map(model => ({ ...model,
    thinking: [...(harness === "claude_local" ? claudeLocalReasoningEffortsForModel(model.id) : codexLocalReasoningEffortsForModel(model.id))],
    speeds: harness === "codex_local" && isCodexLocalFastModeSupported(model.id) ? ["standard", "fast"] : ["standard"],
  }));
}

export function workerSelectionOverrides(harness: PmWorkerCatalogEntry["harness"], choice: PmWorkerSelection): Record<string, unknown> {
  const full = choice.permission === "approve-all" || choice.permission === "full-access";
  if (harness === "agy_local") return { model: choice.model, effort: choice.thinking,
    mode: "accept-edits", sandbox: false, dangerouslySkipPermissions: full, subscriptionOnly: true };
  // CC Pocket adapter keys: Full access is explicit; any other choice also clears an inherited bypass flag.
  if (harness === "ccpocket_bridge") return { model: choice.model, effort: choice.thinking,
    permissionMode: full ? "fullAccess" : "default", dangerouslyBypassApprovalsAndSandbox: full };
  return {
    model: choice.model,
    modelReasoningEffort: choice.thinking, reasoningEffort: choice.thinking, thinkingEffort: choice.thinking, effort: choice.thinking,
    ...(harness === "claude_local" ? { dangerouslySkipPermissions: full }
      : { fastMode: choice.speed === "fast", dangerouslyBypassApprovalsAndSandbox: full, dangerouslyBypassSandbox: full }),
    ...(choice.permission.startsWith("approve-") || choice.permission === "deny-all"
      ? { permissionMode: choice.permission, nonInteractivePermissions: "deny" } : {}),
  };
}

export function validateWorkerChoices(policy: PmWorkerPolicy, catalog: PmWorkerCatalogEntry[], unavailableCode = "PM_WORKER_UNAVAILABLE") {
  for (const worker of policy.workers) {
    const available = catalog.find(entry => entry.agentId === worker.agentId && entry.harness === worker.harness);
    if (!available) throw unprocessable(unavailableCode === "PM_WORKER_HOST_MISMATCH"
      ? "The selected shared worker is unavailable or runs on a different Bridge host than this agent" : "The selected shared worker is unavailable",
    { code: unavailableCode, agentId: worker.agentId });
    for (const choice of worker.selections) {
      const model = available.models.find(model => model.id === choice.model && isDeepStrictEqual(model.aiConnection, choice.aiConnection ?? available.defaultAiConnection));
      if (!model || (choice.thinking !== null && !model.thinking.includes(choice.thinking))
        || !model.speeds.includes(choice.speed) || !available.permissions.includes(choice.permission)) {
        throw unprocessable("Worker selection is not supported by the current harness/model catalog", { code: "PM_WORKER_SELECTION_UNAVAILABLE", selectionId: choice.id });
      }
    }
  }
}
