import { parseObject } from "../../adapters/utils.js";

/** Server-owned scope; the adapter performs maintenance only after its successful, idle native turn. */
export function mainContextCompactPolicy(agent: {
  id: string; adapterType: string; adapterConfig?: unknown;
}, issue: { id: string; conversationAgentId?: string | null } | null) {
  const config = parseObject(agent.adapterConfig);
  if (agent.adapterType !== "ccpocket_bridge" || config.role !== "main"
    || issue?.conversationAgentId !== agent.id) return null;
  const threshold = config.mainContextCompactThresholdTokens ?? 150_000;
  if (!Number.isSafeInteger(threshold) || (threshold as number) < 0) {
    throw new Error("mainContextCompactThresholdTokens must be a nonnegative safe integer");
  }
  return { version: 1, issueId: issue.id, agentId: agent.id, thresholdTokens: threshold as number };
}

