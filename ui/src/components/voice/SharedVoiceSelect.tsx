import { useCallback, useState, useSyncExternalStore } from "react";
import { cn } from "@/lib/utils";
import { readSharedVoice, saveSharedVoice, subscribeSharedVoice } from "@/lib/local-voice/voice-agent-choice";

/** All mounted call surfaces and browser tabs observe the same saved voice. */
export function useSharedVoice() {
  const voice = useSyncExternalStore(subscribeSharedVoice, readSharedVoice, () => null);
  const [error, setError] = useState<string | null>(null);
  const setVoice = useCallback((next: string | null) => {
    try {
      saveSharedVoice(next);
      setError(null);
    } catch {
      setError("Could not save the voice. Allow browser storage and try again.");
    }
  }, []);
  return [voice, setVoice, error] as const;
}

function label(voice: string) {
  return voice.charAt(0).toUpperCase() + voice.slice(1);
}

export interface SharedVoiceSelectProps {
  /** Selectable voices from the voice status; nothing renders when empty. */
  voices: readonly string[] | undefined;
  defaultVoice?: string | null;
  value: string | null;
  onChange(voice: string | null): void;
  /** Show the "next call" hint: the choice changed while a call is open. */
  pendingNextCall?: boolean;
  error?: string | null;
  compact?: boolean;
  className?: string;
}

/** Shared voice picker, shown only on the Voice page. */
export function SharedVoiceSelect({ voices, defaultVoice, value, onChange, pendingNextCall, error, compact, className }: SharedVoiceSelectProps) {
  if (!voices || voices.length === 0) return null;
  const current = value && voices.includes(value) ? value : "";
  return (
    <div className={cn("flex flex-col gap-1", className)}>
      <label className="flex flex-col gap-1 text-xs font-medium text-muted-foreground">
        Voice
        <select
          className={cn("rounded-md border border-input bg-background text-foreground", compact ? "p-1 text-xs" : "p-2 text-sm")}
          aria-label="Voice for all agents"
          value={current}
          onChange={(event) => onChange(event.target.value || null)}
        >
          <option value="">{defaultVoice ? `Default (${label(defaultVoice)})` : "Default"}</option>
          {voices.map((voice) => <option key={voice} value={voice}>{label(voice)}</option>)}
        </select>
      </label>
      <p className="text-xs text-muted-foreground">Shared by all agents in this browser.</p>
      {error && <p role="alert" className="text-xs text-destructive">{error}</p>}
      {pendingNextCall && <p role="status" className="text-xs text-muted-foreground">Applies to the next call.</p>}
    </div>
  );
}
