import { pmInstructionLayout, pmWorkerPolicySchema, type PmWorkerDocumentLayout } from "@paperclipai/shared";
import { unprocessable } from "../errors.js";
import type { PmCoordinationScope } from "./pm-coordination-policy.js";

/**
 * Main agents (ccpocket_bridge `role: main`) plan and implement themselves; an
 * Owner-managed worker policy lets them also dispatch shared workers. The policy
 * table lives in PROJECT.md and lists option IDs. Unlike a project PM, this is
 * not a capability boundary for the main agent itself.
 */
type AgentLike = { id: string; companyId: string; adapterType?: string | null; adapterConfig?: Record<string, unknown> | null; runtimeConfig?: Record<string, unknown> | null };

const UUID = /^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/i;

/** A project main agent, regardless of whether its project binding is valid. */
export function isMainAgent(agent: Pick<AgentLike, "adapterType" | "adapterConfig">): boolean {
  return agent.adapterType === "ccpocket_bridge" && (agent.adapterConfig ?? {}).role === "main";
}

export function mainAgentProjectId(agent: AgentLike): string | null {
  const config = agent.adapterConfig ?? {};
  if (agent.adapterType !== "ccpocket_bridge" || config.role !== "main") return null;
  return typeof config.projectId === "string" && UUID.test(config.projectId) ? config.projectId : null;
}

/** Where an agent's managed worker table lives and how it is rendered. */
export function workerPolicyLayout(agent: AgentLike): { version: PmWorkerDocumentLayout; workerDocumentPath: "WORKERS.md" | "PROJECT.md" } {
  if (mainAgentProjectId(agent)) return { version: "main-v1", workerDocumentPath: "PROJECT.md" };
  const layout = pmInstructionLayout(agent.runtimeConfig);
  return { version: layout.version, workerDocumentPath: layout.workerDocumentPath };
}

/** Dispatch scope for a main agent with a saved v2 worker policy; null when it has none. */
export function mainAgentDispatchScope(agent: AgentLike): PmCoordinationScope | null {
  const projectId = mainAgentProjectId(agent);
  const raw = agent.runtimeConfig?.pmDelegation;
  if (!projectId || raw === undefined || raw === null) return null;
  const parsed = pmWorkerPolicySchema.safeParse(raw);
  if (!parsed.success) throw unprocessable("The main agent's worker policy is invalid", { code: "PM_DELEGATION_INVALID" });
  const cwd = agent.adapterConfig?.cwd;
  return { agentId: agent.id, companyId: agent.companyId, projectId, workerRoot: typeof cwd === "string" ? cwd : "", delegation: parsed.data };
}
