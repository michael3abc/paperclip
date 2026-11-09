import { isDeepStrictEqual } from "node:util";
import { claudeLocalReasoningEffortsForModel } from "@paperclipai/adapter-claude-local";
import { codexLocalReasoningEffortsForModel, isCodexLocalFastModeSupported, normalizeCodexModel } from "@paperclipai/adapter-codex-local";
import type { PmWorkerCatalogEntry, PmWorkerHarness, PmWorkerPolicy, PmWorkerSelection } from "@paperclipai/shared";
import { unprocessable } from "../errors.js";

type WorkerAgent = { adapterType: string; adapterConfig?: Record<string, unknown> | null; runtimeConfig?: Record<string, unknown> | null };

/**
 * CC Pocket Bridge agents become policy workers only as plain Antigravity shared workers: explicit provider
 * `antigravity`, no main-agent role, no project-PM binding and no Bridge worker-preset fields. Claude/Codex
 * through the Bridge stay main agents or PMs; the adapter fails Antigravity closed for those roles too.
 */
export function isAntigravityBridgeWorker(agent: WorkerAgent): boolean {
  const config = agent.adapterConfig ?? {};
  const binding = agent.runtimeConfig?.workspaceBinding as { mode?: unknown } | undefined;
  return agent.adapterType === "ccpocket_bridge" && config.provider === "antigravity"
    && (config.role === undefined || config.role === "") && binding?.mode !== "project_pm"
    && ["defaultWorker", "allowedWorkers", "isolation", "worker"].every(key => config[key] === undefined || config[key] === "");
}

/** Agents that may appear in an Owner-managed worker policy (status and workspace gates are checked separately). */
export function isPmWorkerAgent(agent: WorkerAgent): agent is WorkerAgent & { adapterType: PmWorkerHarness } {
  return agent.adapterType === "claude_local" || agent.adapterType === "codex_local" || isAntigravityBridgeWorker(agent);
}

/** Bridge host whose Antigravity models a CC Pocket worker can run (the adapter's own default host when unset). */
export function antigravityWorkerModelPrefix(config: Record<string, unknown>): string {
  return `${typeof config.hostId === "string" && config.hostId ? config.hostId : "michael-server"}/antigravity/`;
}

export function workerPermissionChoices(config: Record<string, unknown>, harness?: string): PmWorkerCatalogEntry["permissions"] {
  if ([config.extraArgs, config.args].some(value => Array.isArray(value) && value.length > 0)) return [];
  // Antigravity: Bridge default (agy --mode accept-edits) or explicit Full access (--dangerously-skip-permissions).
  if (harness === "ccpocket_bridge") return config.provider === "antigravity" ? ["default", "full-access"] : [];
  const engine = config.engine ?? "auto";
  if (engine === "cli") return ["default", "full-access"];
  if (engine === "auto" || engine === "acp") return ["deny-all", "approve-reads", "approve-all"];
  return [];
}

export function workerModelChoices(harness: PmWorkerCatalogEntry["harness"], models: { id: string; label: string }[]): PmWorkerCatalogEntry["models"] {
  if (harness === "ccpocket_bridge") {
    // CC Pocket model IDs are `<host>/<engine>/<model>`; efforts come from the host's own agy probe. No fast tier.
    return models.filter(model => model.id.split("/")[1] === "antigravity").map(model => {
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

export function validateWorkerChoices(policy: PmWorkerPolicy, catalog: PmWorkerCatalogEntry[]) {
  for (const worker of policy.workers) {
    const available = catalog.find(entry => entry.agentId === worker.agentId && entry.harness === worker.harness);
    if (!available) throw unprocessable("The selected shared worker is unavailable", { code: "PM_WORKER_UNAVAILABLE", agentId: worker.agentId });
    for (const choice of worker.selections) {
      const model = available.models.find(model => model.id === choice.model && isDeepStrictEqual(model.aiConnection, choice.aiConnection ?? available.defaultAiConnection));
      if (!model || (choice.thinking !== null && !model.thinking.includes(choice.thinking))
        || !model.speeds.includes(choice.speed) || !available.permissions.includes(choice.permission)) {
        throw unprocessable("Worker selection is not supported by the current harness/model catalog", { code: "PM_WORKER_SELECTION_UNAVAILABLE", selectionId: choice.id });
      }
    }
  }
}
