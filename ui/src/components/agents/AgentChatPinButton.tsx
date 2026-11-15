import type { Agent } from "@paperclipai/shared";
import { Loader2, Pin, PinOff } from "lucide-react";
import { Button } from "@/components/ui/button";
import { useResourceMemberships, useResourceMembershipMutation } from "@/hooks/useResourceMemberships";
import { useAgentChatEnabled } from "@/hooks/useAgentChatEnabled";
import { isAgentChatVisible } from "@/lib/agent-chat-visibility";
import { usePrimaryAgentPresentation } from "@/components/primary-agent/PrimaryAgentPresentation";
import { cn } from "@/lib/utils";

/** Chat visibility is independent of stars and primary-agent identity. */
export function AgentChatPinButton({ agent }: {
  agent: Pick<Agent, "id" | "companyId" | "name" | "status" | "adapterType" | "role">;
}) {
  const primary = usePrimaryAgentPresentation(agent.companyId);
  const chat = useAgentChatEnabled();
  const memberships = useResourceMemberships(agent.companyId);
  const mutation = useResourceMembershipMutation(agent.companyId);
  if (!chat.enabled || agent.status === "terminated" || agent.status === "pending_approval" || agent.adapterType === "process") return null;
  const pinned = isAgentChatVisible(agent, memberships.data, primary?.primaryAgentId);
  const label = `${pinned ? "Unpin" : "Pin"} ${agent.name} chat`;
  const Icon = mutation.isPending ? Loader2 : pinned ? PinOff : Pin;
  return <Button
    type="button" variant="ghost" size="icon-sm"
    aria-label={label} aria-pressed={pinned} aria-busy={mutation.isPending || undefined}
    disabled={!memberships.isSuccess || primary?.loading || mutation.isPending}
    title={memberships.isError ? "Cannot load chat pins. Reload to try again." : `${label} in your sidebar. Your primary agent stays unchanged.`}
    onClick={event => {
      event.preventDefault();
      event.stopPropagation();
      mutation.mutate({ resourceType: "agent", resourceId: agent.id, resourceName: agent.name, chatPinned: !pinned });
    }}
  >
    <Icon aria-hidden="true" className={cn("size-4", pinned && "text-primary", mutation.isPending && "motion-safe:animate-spin")} />
  </Button>;
}
