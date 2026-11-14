import type { Agent } from "@paperclipai/shared";
import { agentsApi, type AdapterModel } from "@/api/agents";
import type { CurrentBoardAccess } from "@/api/access";

/**
 * Project main agents are CC Pocket Bridge agents with `adapterConfig.role === "main"`.
 * Their chat composer edits the agent's saved model/effort; the Bridge applies it on the
 * next turn of the same native session.
 */
export const BRIDGE_ADAPTER_TYPE = "ccpocket_bridge";

export interface MainAgentModelSelection {
  /** Qualified Bridge model ID (`<host>/<provider>/<model>`), stored verbatim. */
  model: string;
  /** Empty string means the model's own default effort. */
  effort: string;
}

export interface MainAgentModelScope extends MainAgentModelSelection {
  hostId: string;
  provider: string;
}

/** The Bridge catalog response carries capability metadata beyond the shared AdapterModel fields. */
export type BridgeCatalogModel = AdapterModel & { efforts?: unknown };

export function isBridgeMainAgent(agent: Agent | null | undefined): agent is Agent {
  return Boolean(agent && agent.adapterType === BRIDGE_ADAPTER_TYPE
    && (agent.adapterConfig as { role?: unknown } | null | undefined)?.role === "main");
}

function configString(config: Record<string, unknown> | null | undefined, key: string): string {
  const value = config?.[key];
  return typeof value === "string" ? value.trim() : "";
}

export function readMainAgentModelScope(config: Record<string, unknown> | null | undefined): MainAgentModelScope {
  return {
    hostId: configString(config, "hostId"),
    provider: configString(config, "provider") || "codex",
    model: configString(config, "model"),
    effort: configString(config, "effort"),
  };
}

export function sameSelection(a: MainAgentModelSelection, b: MainAgentModelSelection): boolean {
  return a.model === b.model && a.effort === b.effort;
}

/**
 * Keep the Bridge order and IDs. The scoped catalog already returns only the selected
 * host and executor; the prefix check keeps the provider fixed even if an older Bridge
 * adapter returns every host's models.
 */
export function bridgeCatalogForScope(models: readonly BridgeCatalogModel[], scope: Pick<MainAgentModelScope, "hostId" | "provider">) {
  if (!scope.hostId) return [...models];
  const prefix = `${scope.hostId}/${scope.provider}/`;
  return models.filter((model) => model.id.startsWith(prefix));
}

export function bridgeModelEfforts(model: BridgeCatalogModel | undefined): string[] {
  if (!model || !Array.isArray(model.efforts)) return [];
  return [...new Set(model.efforts.filter((value): value is string => typeof value === "string" && value.trim().length > 0))];
}

export function bridgeModelDisplayName(
  modelId: string,
  catalog: readonly BridgeCatalogModel[],
  scope: Pick<MainAgentModelScope, "hostId" | "provider">,
): string {
  if (!modelId) return "";
  const label = catalog.find((model) => model.id === modelId)?.label?.trim();
  if (label) return label;
  const prefix = `${scope.hostId}/${scope.provider}/`;
  return scope.hostId && modelId.startsWith(prefix) ? modelId.slice(prefix.length) : modelId;
}

const EFFORT_LABELS: Record<string, string> = {
  off: "關閉", none: "關閉", minimal: "最低", low: "低", medium: "中", high: "高",
  xhigh: "超高", max: "最高", ultra: "極限",
};

export function mainAgentEffortLabel(effort: string): string {
  if (!effort) return "模型預設";
  return EFFORT_LABELS[effort] ?? effort;
}

/** When a newly chosen model does not offer the current effort, fall back to the model default. */
export function effortForModel(effort: string, efforts: readonly string[]): string {
  return effort && efforts.includes(effort) ? effort : "";
}

/**
 * Presentation hint only: mirrors the default `agents:configure` grants of the viewer's
 * company role (and local/instance-admin access). The server's `agent_config:update`
 * check stays authoritative; a denied save reverts and reports the error.
 */
export function canEditAgentConfiguration(access: CurrentBoardAccess | null | undefined, companyId: string): boolean {
  if (!access) return false;
  if (access.source === "local_implicit" || access.isInstanceAdmin) return true;
  const membership = access.memberships?.find((item) => item.companyId === companyId && item.status === "active");
  return ["owner", "admin", "operator", "member"].includes(membership?.membershipRole ?? "");
}

export class MainAgentModelConflictError extends Error {
  constructor() {
    super("此 agent 的模型設定已在其他地方變更。已重新載入目前設定，請再選擇一次。");
    this.name = "MainAgentModelConflictError";
  }
}

/**
 * Save through the Agent settings update path: read the current configuration revision,
 * confirm the viewer saw the saved model/effort, then PATCH only `model` and `effort`
 * (server-side merge) bound to that revision. Redacted values are never sent back.
 */
export async function saveMainAgentModel(input: {
  agentId: string;
  companyId: string;
  saved: MainAgentModelScope;
  next: MainAgentModelSelection;
}) {
  const current = await agentsApi.getConfiguration(input.agentId, input.companyId);
  const currentScope = readMainAgentModelScope(current.adapterConfig);
  if (currentScope.hostId !== input.saved.hostId || currentScope.provider !== input.saved.provider
    || !sameSelection(currentScope, input.saved)) {
    throw new MainAgentModelConflictError();
  }
  return agentsApi.update(input.agentId, {
    adapterConfig: { model: input.next.model, effort: input.next.effort },
    expectedConfigurationRevision: current.configurationRevision,
  }, input.companyId);
}
