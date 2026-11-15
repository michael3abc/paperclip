import type { Agent, ResourceMemberships } from "@paperclipai/shared";

/** Explicit personal chat visibility overrides automatic inclusion, never identity. */
export function isAgentChatVisible(
  agent: Pick<Agent, "id" | "role" | "status" | "adapterType">,
  memberships: ResourceMemberships | undefined,
  primaryAgentId?: string | null,
): boolean {
  if (!memberships || agent.status === "terminated" || agent.adapterType === "process"
    || memberships.agentMemberships[agent.id] === "left") return false;
  const pin = memberships.agentChatPins?.[agent.id];
  if (typeof pin === "boolean") return pin;
  return agent.id === primaryAgentId || agent.role === "ceo" || agent.role === "pm"
    || memberships.starredAgentIds?.includes(agent.id) === true;
}
