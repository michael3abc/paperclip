import type { Agent } from "@paperclipai/shared";
import { Loader2, Pin, PinOff } from "lucide-react";
import { Button } from "@/components/ui/button";
import { isStarred, useResourceMemberships, useResourceMembershipMutation } from "@/hooks/useResourceMemberships";
import { useAgentChatEnabled } from "@/hooks/useAgentChatEnabled";
import { cn } from "@/lib/utils";

/** Personal navigation only: starring also rejoins a previously left agent. */
export function AgentChatPinButton({ agent }: {
  agent: Pick<Agent, "id" | "companyId" | "name" | "status" | "adapterType">;
}) {
  const chat = useAgentChatEnabled();
  const memberships = useResourceMemberships(agent.companyId);
  const mutation = useResourceMembershipMutation(agent.companyId);
  if (!chat.enabled || agent.status === "terminated" || agent.status === "pending_approval" || agent.adapterType === "process") return null;
  const pinned = isStarred(memberships.data, "agent", agent.id);
  const label = `${pinned ? "Unpin" : "Pin"} ${agent.name} chat`;
  const Icon = mutation.isPending ? Loader2 : pinned ? PinOff : Pin;
  return <Button
    type="button" variant="ghost" size="icon-sm"
    aria-label={label} aria-pressed={pinned} aria-busy={mutation.isPending || undefined}
    disabled={!memberships.isSuccess || mutation.isPending}
    title={memberships.isError ? "Cannot load chat pins. Reload to try again." : `${label} in your sidebar${pinned ? ". Primary, CEO and PM agents remain automatically listed." : ""}`}
    onClick={event => {
      event.preventDefault();
      event.stopPropagation();
      mutation.mutate({ resourceType: "agent", resourceId: agent.id, resourceName: agent.name, starred: !pinned });
    }}
  >
    <Icon aria-hidden="true" className={cn("size-4", pinned && "text-primary", mutation.isPending && "motion-safe:animate-spin")} />
  </Button>;
}
