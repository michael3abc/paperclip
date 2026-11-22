import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { agentsApi } from "../api/agents";
import { queryKeys } from "../lib/queryKeys";
import { mainAgentHosts, suggestedMainAgentCwd, templateMainAgent, validMainAgentCwd } from "../lib/project-main-agent";
import { Checkbox } from "./ui/checkbox";
import { Input } from "./ui/input";
import { NativeSelect } from "./ui/select";

/**
 * The "also create a main agent" choice of the New project form. It is offered only when the company already runs a
 * main agent on some Bridge host, since a new one copies that host's provider and model.
 */
export function useMainAgentOption(companyId: string, name: string, disabled: boolean) {
  const agents = useQuery({ queryKey: queryKeys.agents.list(companyId), queryFn: () => agentsApi.list(companyId), staleTime: 60_000 });
  const hosts = mainAgentHosts(agents.data);
  const [enabled, setEnabled] = useState(true);
  const [picked, setPicked] = useState<string | null>(null);
  const [typed, setTyped] = useState<string | null>(null);
  const hostId = picked && hosts.includes(picked) ? picked : hosts[0] ?? "";
  const cwd = typed ?? suggestedMainAgentCwd(agents.data, hostId, name);
  const offered = hosts.length > 0;
  const active = offered && enabled;
  return {
    agents: agents.data, offered, enabled: active, hostId, cwd, hosts, disabled,
    /** True when the form may be submitted as far as this option is concerned. */
    ready: !active || (Boolean(name.trim()) && validMainAgentCwd(cwd)),
    setEnabled, setHostId: (value: string) => { setPicked(value); setTyped(null); }, setCwd: setTyped,
  };
}
export type MainAgentOption = ReturnType<typeof useMainAgentOption>;

export function MainAgentOptionFields({ option, name }: { option: MainAgentOption; name: string }) {
  if (!option.offered) return null;
  const template = templateMainAgent(option.agents, option.hostId);
  const model = (template?.adapterConfig as { model?: unknown } | undefined)?.model;
  const invalid = option.enabled && option.cwd.trim() !== "" && !validMainAgentCwd(option.cwd);
  return <div className="mb-4 space-y-2">
    <label className="flex items-start gap-2 text-sm font-medium">
      <Checkbox aria-label="Create a main agent" className="mt-0.5" checked={option.enabled} disabled={option.disabled}
        onCheckedChange={checked => option.setEnabled(checked === true)} />
      <span>Create a main agent named “{name.trim() || "…"}” and make it the project lead</span>
    </label>
    {option.enabled && <div className="space-y-2 pl-6">
      {option.hosts.length > 1 && <div className="space-y-1">
        <label htmlFor="main-agent-host" className="text-xs font-medium text-muted-foreground">Host</label>
        <NativeSelect id="main-agent-host" value={option.hostId} disabled={option.disabled} onChange={event => option.setHostId(event.target.value)}>
          {option.hosts.map(host => <option key={host} value={host}>{host}</option>)}
        </NativeSelect>
      </div>}
      <div className="space-y-1">
        <label htmlFor="main-agent-cwd" className="text-xs font-medium text-muted-foreground">Working folder on {option.hostId}</label>
        <Input id="main-agent-cwd" value={option.cwd} disabled={option.disabled} placeholder="/absolute/path/on/the/host" aria-invalid={invalid || undefined}
          onChange={event => option.setCwd(event.target.value)} />
      </div>
      <p className="text-xs text-muted-foreground">
        Runs on {option.hostId}{typeof model === "string" && model ? ` with ${model.split("/").slice(2).join("/")}` : ""} at high effort with full access, and starts with a standard AGENTS.md and PROJECT.md. The folder is created when it first runs. Worker choices are set later in the agent's settings.
      </p>
    </div>}
  </div>;
}
