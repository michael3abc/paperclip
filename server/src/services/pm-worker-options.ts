import { claudeLocalReasoningEffortsForModel } from "@paperclipai/adapter-claude-local";
import { codexLocalReasoningEffortsForModel, isCodexLocalFastModeSupported, normalizeCodexModel } from "@paperclipai/adapter-codex-local";
import type { PmWorkerCatalogEntry, PmWorkerPolicy, PmWorkerSelection } from "@paperclipai/shared";
import { unprocessable } from "../errors.js";

export function workerPermissionChoices(config: Record<string, unknown>): PmWorkerCatalogEntry["permissions"] {
  if ([config.extraArgs, config.args].some(value => Array.isArray(value) && value.length > 0)) return [];
  const engine = config.engine ?? "auto";
  if (engine === "cli") return ["default", "full-access"];
  if (engine === "auto" || engine === "acp") return ["deny-all", "approve-reads", "approve-all"];
  return [];
}

export function workerModelChoices(harness: PmWorkerCatalogEntry["harness"], models: { id: string; label: string }[]): PmWorkerCatalogEntry["models"] {
  return models.filter(model => harness !== "codex_local" || normalizeCodexModel(model.id) === model.id).map(model => ({ ...model,
    thinking: [...(harness === "claude_local" ? claudeLocalReasoningEffortsForModel(model.id) : codexLocalReasoningEffortsForModel(model.id))],
    speeds: harness === "codex_local" && isCodexLocalFastModeSupported(model.id) ? ["standard", "fast"] : ["standard"],
  }));
}

export function workerSelectionOverrides(harness: PmWorkerCatalogEntry["harness"], choice: PmWorkerSelection): Record<string, unknown> {
  const full = choice.permission === "approve-all" || choice.permission === "full-access";
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
      const model = available.models.find(model => model.id === choice.model);
      if (!model || (choice.thinking !== null && !model.thinking.includes(choice.thinking))
        || !model.speeds.includes(choice.speed) || !available.permissions.includes(choice.permission)) {
        throw unprocessable("Worker selection is not supported by the current harness/model catalog", { code: "PM_WORKER_SELECTION_UNAVAILABLE", selectionId: choice.id });
      }
    }
  }
}
