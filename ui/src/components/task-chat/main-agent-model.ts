import type { Agent } from "@paperclipai/shared";
import { agentsApi, type AdapterModel } from "@/api/agents";
import type { CurrentBoardAccess } from "@/api/access";

/**
 * Project main agents are CC Pocket Bridge agents with `adapterConfig.role === "main"`.
 * Their chat composer edits the agent's saved model/effort; the Bridge applies it on the
 * next turn of the same native session.
 */
export const BRIDGE_ADAPTER_TYPE = "ccpocket_bridge";

/** Slider changes are saved once the effort has rested this long (milliseconds). */
export const MAIN_AGENT_EFFORT_SAVE_DELAY = 400;

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

type CatalogScope = Pick<MainAgentModelScope, "hostId" | "provider">;

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
export function bridgeCatalogForScope(models: readonly BridgeCatalogModel[], scope: CatalogScope) {
  if (!scope.hostId) return [...models];
  const prefix = `${scope.hostId}/${scope.provider}/`;
  return models.filter((model) => model.id.startsWith(prefix));
}

export function bridgeModelEfforts(model: BridgeCatalogModel | undefined): string[] {
  if (!model || !Array.isArray(model.efforts)) return [];
  return [...new Set(model.efforts.filter((value): value is string => typeof value === "string" && value.trim().length > 0))];
}

/** The model part of a qualified `<host>/<provider>/<model>` ID. */
export function unqualifiedBridgeModelId(modelId: string, scope: CatalogScope): string {
  const prefix = `${scope.hostId}/${scope.provider}/`;
  if (scope.hostId && modelId.startsWith(prefix)) return modelId.slice(prefix.length);
  const parts = modelId.split("/");
  return parts.length >= 3 ? parts.slice(2).join("/") : modelId;
}

/** Bare Bridge aliases that name a Claude family rather than a version. */
const MODEL_ALIASES: Record<string, string> = {
  default: "Default", opus: "Claude Opus", sonnet: "Claude Sonnet", haiku: "Claude Haiku", fable: "Claude Fable",
};
const ACRONYMS: Record<string, string> = { gpt: "GPT", glm: "GLM", oss: "OSS" };
const HARDWARE_SUFFIXES: Record<string, string> = { ti: "Ti", super: "Super", xt: "XT" };

function capitalize(word: string): string {
  return word ? word[0]!.toUpperCase() + word.slice(1) : word;
}

function humanizeWords(id: string): string {
  const words: string[] = [];
  const hardware: string[] = [];
  for (const part of id.split(/[-_\s]+/).filter(Boolean)) {
    // GPU tags such as RTX2080ti describe where a local model runs, not its name.
    const gpu = /^(rtx|gtx|rx)(\d+)(ti|super|xt)?$/i.exec(part);
    if (gpu) {
      hardware.push([gpu[1]!.toUpperCase(), gpu[2]!, gpu[3] ? HARDWARE_SUFFIXES[gpu[3].toLowerCase()]! : ""].filter(Boolean).join(" "));
      continue;
    }
    // A lowercase family glued to its version: opus5.5 -> opus 5.5.
    const glued = /^([a-z]{2,})(\d+(?:\.\d+)*)$/.exec(part);
    if (glued && !ACRONYMS[glued[1]!]) words.push(glued[1]!, glued[2]!);
    else words.push(part);
  }
  // Short numeric runs are dotted versions: fable-5-1 -> Fable 5.1 (dates stay whole).
  const merged: string[] = [];
  for (const word of words) {
    const previous = merged[merged.length - 1];
    if (previous !== undefined && /^\d{1,2}$/.test(previous) && /^\d{1,2}$/.test(word)) merged[merged.length - 1] = `${previous}.${word}`;
    else merged.push(word);
  }
  const out: string[] = [];
  for (let index = 0; index < merged.length; index += 1) {
    const word = merged[index]!;
    const acronym = ACRONYMS[word.toLowerCase()];
    const next = merged[index + 1];
    if (acronym && next && /^\d/.test(next)) {
      out.push(`${acronym}-${next}`);
      index += 1;
    } else if (acronym) {
      out.push(acronym);
    } else {
      out.push(word === word.toLowerCase() ? capitalize(word) : word);
    }
  }
  const name = out.join(" ");
  return hardware.length ? `${name} (${hardware.join(", ")})`.trim() : name;
}

/**
 * Readable name for an unqualified Bridge model ID. Compass routes drop their `compass-`
 * prefix (the picker groups them under Compass) and a bracketed context tag becomes a
 * suffix: `claude-fable-5-1[1m]` -> "Claude Fable 5.1 · 1M".
 */
export function humanizeBridgeModelId(rawId: string): string {
  let id = rawId.trim();
  if (!id) return "";
  let context = "";
  const bracket = /\[([^\]]+)\]$/.exec(id);
  if (bracket) {
    context = bracket[1]!.trim().toUpperCase();
    id = id.slice(0, bracket.index).trim();
  }
  // Route-router families (`family:opus`) show only the family name.
  id = id.replace(/^family:/i, "");
  const compass = /^compass[-_]/i.test(id);
  if (compass) id = id.replace(/^compass[-_]/i, "");
  const name = (!compass ? MODEL_ALIASES[id.toLowerCase()] : undefined) ?? humanizeWords(id);
  if (!name) return rawId.trim();
  return context ? `${name} · ${context}` : name;
}

/** Catalog labels that merely repeat or resemble the ID are not human labels. */
function isHumanModelLabel(label: string, modelId: string, unqualified: string): boolean {
  if (!label) return false;
  const lower = label.toLowerCase();
  if (lower === modelId.toLowerCase() || lower === unqualified.toLowerCase()) return false;
  if (/\s/.test(label)) return true;
  if (/[_[\]/]/.test(label)) return false;
  return label !== lower;
}

export function bridgeModelDisplayName(modelId: string, catalog: readonly BridgeCatalogModel[], scope: CatalogScope): string {
  if (!modelId) return "";
  const unqualified = unqualifiedBridgeModelId(modelId, scope);
  const label = catalog.find((model) => model.id === modelId)?.label?.trim() ?? "";
  return isHumanModelLabel(label, modelId, unqualified) ? label : humanizeBridgeModelId(unqualified);
}

/** The composer pill drops the redundant vendor word: "Claude Opus" -> "Opus". */
export function compactBridgeModelName(displayName: string): string {
  const compact = displayName.replace(/^Claude\s+/, "");
  return compact || displayName;
}

const ROUTE_LABELS: Record<string, string> = { subscription: "Subscription", compass: "Compass", local: "Local" };
const ROUTE_ORDER = ["subscription", "compass", "local"];

/** The model's billing route from the catalog `source`, or Compass by its ID prefix. */
export function bridgeModelRoute(model: BridgeCatalogModel, scope: CatalogScope): string | null {
  const source = model.source?.trim();
  if (source) return ROUTE_LABELS[source.toLowerCase()] ?? source;
  return /^compass[-_]/i.test(unqualifiedBridgeModelId(model.id, scope)) ? ROUTE_LABELS.compass! : null;
}

export interface BridgeCatalogGroup {
  key: string;
  /** Null when the catalog reports no billing routes at all. */
  label: string | null;
  models: BridgeCatalogModel[];
}

/** Group by billing route (Subscription, Compass, Local, then others), keeping Bridge order within each group. */
export function groupBridgeCatalog(models: readonly BridgeCatalogModel[], scope: CatalogScope): BridgeCatalogGroup[] {
  const groups = new Map<string, BridgeCatalogGroup>();
  for (const model of models) {
    const route = bridgeModelRoute(model, scope);
    const key = route?.toLowerCase() ?? "";
    let group = groups.get(key);
    if (!group) {
      group = { key, label: route, models: [] };
      groups.set(key, group);
    }
    group.models.push(model);
  }
  const rank = (key: string) => {
    if (!key) return ROUTE_ORDER.length + 2;
    const known = ROUTE_ORDER.indexOf(key);
    return known >= 0 ? known : ROUTE_ORDER.length + 1;
  };
  const list = [...groups.values()].sort((a, b) => rank(a.key) - rank(b.key));
  const routed = list.some((group) => group.key);
  return list.map((group) => (group.key || !routed ? group : { ...group, label: "Other" }));
}

const EFFORT_LABELS: Record<string, string> = {
  off: "Off", none: "None", minimal: "Minimal", low: "Low", medium: "Medium", high: "High",
  xhigh: "Extra high", max: "Max", ultra: "Ultra",
};

export function mainAgentEffortLabel(effort: string): string {
  if (!effort) return "Default";
  return EFFORT_LABELS[effort] ?? capitalize(effort);
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
    super("This agent's model settings changed elsewhere. The current settings were reloaded; choose again.");
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
