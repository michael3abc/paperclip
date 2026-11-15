import { useEffect, useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Mic } from "lucide-react";
import { agentsApi } from "@/api/agents";
import { localVoiceApi } from "@/api/localVoice";
import { EmptyState } from "@/components/EmptyState";
import { AgentVoiceSelect, useAgentVoice } from "@/components/voice/AgentVoiceSelect";
import { LocalVoicePanel } from "@/components/voice/LocalVoicePanel";
import { useBreadcrumbs } from "@/context/BreadcrumbContext";
import { useCompany } from "@/context/CompanyContext";
import { usePrimaryAgent } from "@/hooks/usePrimaryAgent";
import { useAgentChatEnabled } from "@/hooks/useAgentChatEnabled";
import { queryKeys } from "@/lib/queryKeys";
import { chooseDefaultVoiceAgentId, readLastVoiceAgentId, saveLastVoiceAgentId } from "@/lib/local-voice/voice-agent-choice";
import { useSearchParams } from "@/lib/router";

/**
 * Same-origin voice calls with an agent (HOM-311). By default the call talks to the
 * Owner's Chat with the agent (HOM-326); `?issueId=` continues a legacy voice task.
 * `?agentId=` preselects the agent.
 */
export function VoiceCall() {
  const { selectedCompanyId } = useCompany();
  const { setBreadcrumbs } = useBreadcrumbs();
  const [searchParams] = useSearchParams();
  useEffect(() => { setBreadcrumbs([{ label: "Voice" }]); }, [setBreadcrumbs]);

  const status = useQuery({
    queryKey: ["local-voice", "status", selectedCompanyId],
    queryFn: () => localVoiceApi.status(selectedCompanyId!),
    enabled: !!selectedCompanyId,
  });
  const agents = useQuery({
    queryKey: queryKeys.agents.list(selectedCompanyId ?? "__none__"),
    queryFn: () => agentsApi.list(selectedCompanyId!),
    enabled: !!selectedCompanyId,
  });
  const primary = usePrimaryAgent(selectedCompanyId);
  const available = useMemo(() => (agents.data ?? []).filter((agent) => agent.status !== "terminated"), [agents.data]);
  const requested = searchParams.get("agentId");
  const [chosen, setChosen] = useState<string | null>(null);
  // Pin the default once: a later primary-agent or roster refresh must not remount (and end) a live call.
  const [pinned, setPinned] = useState<string | null>(null);
  const defaultReady = agents.isSuccess && !primary.loading;
  const fallback = selectedCompanyId
    ? chooseDefaultVoiceAgentId(available, { requested, lastChosen: readLastVoiceAgentId(selectedCompanyId), primaryAgentId: primary.data?.primaryAgentId })
    : null;
  useEffect(() => { if (defaultReady && pinned === null && fallback) setPinned(fallback); }, [defaultReady, pinned, fallback]);
  const agentId = chosen ?? pinned;
  const agent = available.find((item) => item.id === agentId);
  // Remembered per agent (HOM-265); hooks run before the early returns below.
  const [voice, setVoice] = useAgentVoice(agent?.id ?? "");
  const issueId = searchParams.get("issueId") ?? undefined;
  const agentChat = useAgentChatEnabled();
  // Without Agent Chat the page keeps the voice-task flow instead of failing to bind a Chat.
  const mode = issueId || (agentChat.loaded && !agentChat.enabled) ? "voice_task" : "agent_chat";

  if (!selectedCompanyId) return <EmptyState icon={Mic} message="Select an organization to start a voice call." />;
  // Only the first load gates the page; a failed background refetch keeps a live call mounted.
  if (!status.data && status.isError) return <p role="alert" className="text-sm text-destructive">Voice status could not be loaded. Reload the page to try again.</p>;
  if (!status.data || agents.isPending || !defaultReady || !agentChat.loaded) return <p className="text-sm text-muted-foreground">Loading…</p>;
  if (!status.data.enabled) {
    return <EmptyState icon={Mic} message="Voice is off. Turn on chat connectors and local voice in Settings → Instance → Experimental." />;
  }
  if (!status.data.relayConfigured) {
    return <EmptyState icon={Mic} message="This Paperclip server has no voice gateway configured." />;
  }
  if (!agent) return <EmptyState icon={Mic} message="No agent is available for voice calls." />;

  return (
    <div className="mx-auto flex w-full max-w-3xl flex-col gap-4">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="text-lg font-medium">Voice</h1>
          <p className="text-sm text-muted-foreground">
            {mode === "agent_chat"
              ? "Talk with an agent. What you say goes straight to your Chat with that agent."
              : "Talk with an agent. Requests are read back and sent only after you confirm."}
          </p>
        </div>
        <div className="flex flex-wrap items-end gap-3">
          <label className="flex flex-col gap-1 text-xs font-medium text-muted-foreground">
            Agent
            <select
              className="rounded-md border border-input bg-background p-2 text-sm"
              value={agent.id}
              onChange={(event) => {
                setChosen(event.target.value);
                saveLastVoiceAgentId(selectedCompanyId, event.target.value);
              }}
            >
              {available.map((item) => <option key={item.id} value={item.id}>{item.name}</option>)}
            </select>
          </label>
          <AgentVoiceSelect agentName={agent.name} voices={status.data.voices} defaultVoice={status.data.defaultVoice} value={voice} onChange={setVoice} />
        </div>
      </div>
      <LocalVoicePanel key={`${agent.id}:${issueId ?? ""}:${mode}`} companyId={selectedCompanyId} agentId={agent.id} agentName={agent.name} issueId={issueId} mode={mode} voiceName={voice} />
    </div>
  );
}
