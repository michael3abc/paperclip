import { useCallback, useEffect, useState } from "react";
import { cn } from "@/lib/utils";
import { normalizeVoiceName, readAgentVoice, saveAgentVoice } from "@/lib/local-voice/voice-agent-choice";

/**
 * The voice (timbre) remembered for one agent in this browser (HOM-265).
 * `null` means no choice: the call uses the server's configured voice.
 */
export function useAgentVoice(agentId: string) {
  const [voice, setVoiceState] = useState<string | null>(() => readAgentVoice(agentId));
  useEffect(() => { setVoiceState(readAgentVoice(agentId)); }, [agentId]);
  const setVoice = useCallback((next: string | null) => {
    const normalized = normalizeVoiceName(next);
    saveAgentVoice(agentId, normalized);
    // Kept in memory too, so the choice holds for this page even without storage.
    setVoiceState(normalized);
  }, [agentId]);
  return [voice, setVoice] as const;
}

function label(voice: string) {
  return voice.charAt(0).toUpperCase() + voice.slice(1);
}

export interface AgentVoiceSelectProps {
  agentName: string;
  /** Selectable voices from the voice status; nothing renders when empty. */
  voices: readonly string[] | undefined;
  defaultVoice?: string | null;
  value: string | null;
  onChange(voice: string | null): void;
  /** Show the "next call" hint: the choice changed while a call is open. */
  pendingNextCall?: boolean;
  compact?: boolean;
  className?: string;
}

/** Per-agent voice picker. A change is saved at once and takes effect on the agent's next call. */
export function AgentVoiceSelect({ agentName, voices, defaultVoice, value, onChange, pendingNextCall, compact, className }: AgentVoiceSelectProps) {
  if (!voices || voices.length === 0) return null;
  const current = value && voices.includes(value) ? value : "";
  return (
    <div className={cn("flex flex-col gap-1", className)}>
      <label className="flex flex-col gap-1 text-xs font-medium text-muted-foreground">
        Voice
        <select
          className={cn("rounded-md border border-input bg-background text-foreground", compact ? "p-1 text-xs" : "p-2 text-sm")}
          aria-label={`Voice for ${agentName}`}
          value={current}
          onChange={(event) => onChange(event.target.value || null)}
        >
          <option value="">{defaultVoice ? `Default (${label(defaultVoice)})` : "Default"}</option>
          {voices.map((voice) => <option key={voice} value={voice}>{label(voice)}</option>)}
        </select>
      </label>
      {pendingNextCall && <p role="status" className="text-xs text-muted-foreground">Applies to the next call.</p>}
    </div>
  );
}
