import { createContext, useCallback, useContext, useEffect, useMemo, useState, useSyncExternalStore, type ReactNode } from "react";
import { Mic, MicOff, PhoneOff, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Link } from "@/lib/router";
import { createLocalVoiceCall, type LocalVoiceCall, type LocalVoiceCallSnapshot, type LocalVoiceMode } from "@/lib/local-voice/local-voice-call";

type CallTarget = { companyId: string; agentId: string; mode: LocalVoiceMode; issueId?: string };
export type LocalVoiceCallBinding = CallTarget & { agentName: string; voiceName?: string | null; newConversation?: boolean };
interface LocalVoiceCallHost {
  call: LocalVoiceCall;
  state: LocalVoiceCallSnapshot;
  binding: LocalVoiceCallBinding | null;
  active: boolean;
  startUnavailableReason(companyId: string): string | null;
  start(binding: LocalVoiceCallBinding): boolean;
  dismiss(): void;
  registerSurface(target: CallTarget): () => void;
}
const LocalVoiceCallContext = createContext<LocalVoiceCallHost | null>(null);
const isActive = (state: LocalVoiceCallSnapshot) => ["starting", "live", "ending"].includes(state.phase);

export function matchesLocalVoiceCall(binding: LocalVoiceCallBinding | null, target: CallTarget, state: LocalVoiceCallSnapshot) {
  return Boolean(binding && binding.companyId === target.companyId && binding.agentId === target.agentId && binding.mode === target.mode
    && (target.mode === "agent_chat" || !target.issueId || target.issueId === binding.issueId || target.issueId === state.issue?.id));
}

export function useLocalVoiceCall() {
  const host = useContext(LocalVoiceCallContext);
  if (!host) throw new Error("Local voice controls require LocalVoiceCallProvider.");
  return host;
}

/** Only mounted controls for the original call suppress the global call bar. */
export function useLocalVoiceSurface(target: CallTarget, enabled = true) {
  const { registerSurface } = useLocalVoiceCall();
  useEffect(() => enabled ? registerSurface(target) : undefined,
    [registerSurface, enabled, target.companyId, target.agentId, target.mode, target.issueId]);
}

/** Media lifetime follows authenticated company/account scope, never a route. */
export function LocalVoiceCallProvider({ children, companyId, userId, createCall = createLocalVoiceCall }: {
  children: ReactNode; companyId: string | null; userId: string | null;
  /** Test seam: the factory owns one call per scope. */
  createCall?: () => LocalVoiceCall;
}) {
  return <ScopedLocalVoiceCallProvider key={JSON.stringify([companyId, userId])} companyId={companyId} userId={userId} createCall={createCall}>
    {children}
  </ScopedLocalVoiceCallProvider>;
}

function ScopedLocalVoiceCallProvider({ children, companyId, userId, createCall }: {
  children: ReactNode; companyId: string | null; userId: string | null; createCall: () => LocalVoiceCall;
}) {
  const [call] = useState(createCall);
  const state = useSyncExternalStore(call.subscribe, call.getSnapshot);
  const [binding, setBinding] = useState<LocalVoiceCallBinding | null>(null);
  const [surfaces, setSurfaces] = useState<Map<symbol, CallTarget>>(() => new Map());
  useEffect(() => () => call.dispose(), [call]);
  const startUnavailableReason = useCallback((targetCompanyId: string) => {
    if (!companyId || !userId) return "Select an organization and sign in before starting voice.";
    if (targetCompanyId !== companyId) return "This conversation belongs to another organization. Open it in that organization before starting voice.";
    return null;
  }, [companyId, userId]);
  const start = useCallback((target: LocalVoiceCallBinding) => {
    const unavailableReason = startUnavailableReason(target.companyId);
    if (unavailableReason) throw new Error(unavailableReason);
    if (isActive(call.getSnapshot())) return false;
    setBinding(target);
    const { agentName: _agentName, ...input } = target;
    // Do not move into an effect or promise callback: AudioContext needs this gesture.
    void call.start(input);
    return true;
  }, [call, startUnavailableReason]);
  const dismiss = useCallback(() => { if (!isActive(call.getSnapshot())) setBinding(null); }, [call]);
  const registerSurface = useCallback((target: CallTarget) => {
    const id = Symbol();
    setSurfaces(current => new Map(current).set(id, target));
    return () => setSurfaces(current => { const next = new Map(current); next.delete(id); return next; });
  }, []);
  const value = useMemo(() => ({ call, state, binding, active: isActive(state), startUnavailableReason, start, dismiss, registerSurface }),
    [call, state, binding, startUnavailableReason, start, dismiss, registerSurface]);
  const hasControls = [...surfaces.values()].some(target => matchesLocalVoiceCall(binding, target, state));
  return <LocalVoiceCallContext.Provider value={value}>
    {children}
    {binding && !hasControls && <LocalVoiceCallBar />}
  </LocalVoiceCallContext.Provider>;
}

function LocalVoiceCallBar() {
  const { call, state, binding, active, dismiss } = useLocalVoiceCall();
  if (!binding) return null;
  const name = state.agentName ?? binding.agentName;
  const issueId = state.issue?.id ?? binding.issueId;
  const href = binding.mode === "agent_chat" ? `/chats/${encodeURIComponent(binding.agentId)}`
    : `/voice?agentId=${encodeURIComponent(binding.agentId)}${issueId ? `&issueId=${encodeURIComponent(issueId)}` : ""}`;
  const live = state.phase === "live";
  const status = state.phase === "starting" ? "Connecting…" : state.phase === "ending" ? "Ending…"
    : live ? state.mic === "paused" ? "Listening paused" : state.modelSpeaking ? "Speaking" : "Listening"
    : state.phase === "error" ? "Call failed" : "Call ended";
  return <aside aria-label={`Current voice call with ${name}`} className="fixed inset-x-4 bottom-20 z-50 flex flex-wrap items-center gap-2 rounded-lg border border-border bg-background p-3 shadow-lg sm:left-auto sm:bottom-4 sm:max-w-96">
    <div className="min-w-0 flex-1 text-sm">
      <Link className="font-medium underline" to={href}>{name}</Link>
      <p role="status" className="text-xs text-muted-foreground">{status}</p>
      {state.error && <p role="alert" className="text-xs text-destructive">{state.error}</p>}
    </div>
    {live && <Button variant="ghost" size="icon-sm" aria-label={state.mic === "live" ? "Pause listening" : "Resume listening"}
      onClick={() => state.mic === "live" ? call.pauseMic("manual") : call.resumeMic()}>
      {state.mic === "live" ? <MicOff aria-hidden /> : <Mic aria-hidden />}
    </Button>}
    {active ? <Button variant="ghost" size="icon-sm" className="text-destructive" aria-label={`End voice call with ${name}`}
      disabled={state.phase === "ending"} onClick={() => void call.end()}><PhoneOff aria-hidden /></Button>
      : <Button variant="ghost" size="icon-sm" aria-label="Close voice call" onClick={dismiss}><X aria-hidden /></Button>}
  </aside>;
}
