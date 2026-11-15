import { useEffect, useMemo, useState, useSyncExternalStore } from "react";
import { createPortal } from "react-dom";
import { useQuery } from "@tanstack/react-query";
import { AlertTriangle, Check, Loader2, Mic, MicOff, Phone, PhoneOff, X } from "lucide-react";
import { localVoiceApi } from "@/api/localVoice";
import { Button } from "@/components/ui/button";
import { useAgentChatEnabled } from "@/hooks/useAgentChatEnabled";
import { cn } from "@/lib/utils";
import { createLocalVoiceCall, type LocalVoiceCall, type LocalVoiceSentEntry } from "@/lib/local-voice/local-voice-call";

export interface ChatVoiceCallButtonProps {
  companyId: string;
  agentId: string;
  agentName: string;
  /** Test seam. */
  call?: LocalVoiceCall;
}

function formatClock(seconds: number) {
  const safe = Math.max(0, Math.floor(seconds));
  return `${Math.floor(safe / 60)}:${String(safe % 60).padStart(2, "0")}`;
}

function useElapsed(startedAt: number | null, running: boolean) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!running) return;
    const handle = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(handle);
  }, [running]);
  return startedAt ? Math.max(0, (now - startedAt) / 1000) : 0;
}

function SentMark({ entry }: { entry: LocalVoiceSentEntry }) {
  if (entry.status === "sending") return <Loader2 className="mt-0.5 size-3 shrink-0 animate-spin text-muted-foreground" aria-label="Sending" />;
  if (entry.status === "sent") return <Check className="mt-0.5 size-3 shrink-0 text-muted-foreground" aria-label="Sent" />;
  if (entry.status === "dropped") return <X className="mt-0.5 size-3 shrink-0 text-muted-foreground" aria-label="Not sent" />;
  return <AlertTriangle className="mt-0.5 size-3 shrink-0 text-destructive" aria-label="Not sent" />;
}

/**
 * Phone button in a Chat's top bar (HOM-265): starts a voice call bound to the
 * caller's Chat with this agent (the HOM-326 `agent_chat` flow) without leaving
 * the conversation. Each finished utterance is posted to the Chat; the reply's
 * voice summary is read aloud. A small floating card holds the call controls.
 * Hidden when local voice or Agent Chat is off.
 */
export function ChatVoiceCallButton({ companyId, agentId, agentName, call: injected }: ChatVoiceCallButtonProps) {
  const status = useQuery({
    queryKey: ["local-voice", "status", companyId],
    queryFn: () => localVoiceApi.status(companyId),
    staleTime: 60_000,
    retry: false,
  });
  const agentChat = useAgentChatEnabled();
  const call = useMemo(() => injected ?? createLocalVoiceCall(), [injected]);
  useEffect(() => () => call.dispose(), [call]);
  const state = useSyncExternalStore(call.subscribe, call.getSnapshot);
  const [cardOpen, setCardOpen] = useState(false);
  const live = state.phase === "live";
  const active = state.phase === "starting" || live || state.phase === "ending";
  const elapsed = useElapsed(state.startedAt, live);
  const available = status.data?.enabled === true && status.data.relayConfigured === true && agentChat.enabled;

  if (!available && !active && !cardOpen) return null;

  const start = () => {
    setCardOpen(true);
    // Must stay inside the click: the call creates its AudioContext synchronously.
    void call.start({ companyId, agentId, mode: "agent_chat" });
  };
  const onButton = () => {
    if (active) {
      setCardOpen(true);
      if (live || state.phase === "starting") void call.end();
      return;
    }
    start();
  };
  const caption = [...state.transcript].reverse().find((entry) => entry.role === "user") ?? null;
  const recentSent = state.sentLog.slice(-3);

  const card = cardOpen ? (
    <section
      aria-label={`Voice call with ${agentName}`}
      className="fixed left-4 right-4 top-16 z-50 flex sm:left-auto sm:w-88 flex-col gap-3 rounded-xl border border-border bg-popover p-4 text-popover-foreground shadow-lg"
    >
      <div className="flex items-start justify-between gap-2">
        <div className="min-w-0">
          <h2 className="truncate text-sm font-medium">Voice call · {state.agentName ?? agentName}</h2>
          <p role="status" className="text-xs text-muted-foreground">
            {state.phase === "starting" && "Connecting…"}
            {live && (state.modelSpeaking ? "Speaking" : state.mic === "live" ? "Listening" : "Listening paused")}
            {state.phase === "ending" && "Ending…"}
            {state.phase === "ended" && (state.endedReason ?? "Call ended.")}
            {state.phase === "error" && "Call failed."}
            {state.phase === "idle" && "Not connected."}
            {live && <span className={cn("ml-2 tabular-nums", state.timeWarning && "text-destructive")}>{formatClock(elapsed)} / {formatClock(state.maxSeconds)}</span>}
          </p>
        </div>
        {!active && (
          <Button variant="ghost" size="icon-xs" aria-label="Close voice call" onClick={() => setCardOpen(false)}>
            <X aria-hidden />
          </Button>
        )}
      </div>

      {state.error && <p role="alert" className="text-xs text-destructive">{state.error}</p>}
      {state.notice && <p className="text-xs text-muted-foreground">{state.notice}</p>}
      {live && state.mic === "paused" && state.micPausedReason === "silence" && (
        <p className="text-xs text-muted-foreground">Listening paused after 60 seconds without speech.</p>
      )}
      {live && caption && <p className="line-clamp-3 break-words text-sm"><span className="text-xs text-muted-foreground">You: </span>{caption.text}</p>}
      {recentSent.length > 0 && (
        <ol className="space-y-1" aria-label={`Sent to ${state.agentName ?? agentName}`}>
          {recentSent.map((entry) => (
            <li key={entry.operationId} className="flex gap-1.5 text-xs text-muted-foreground">
              <SentMark entry={entry} />
              <span className="line-clamp-2 break-words">{entry.text}</span>
            </li>
          ))}
        </ol>
      )}

      <div className="flex flex-wrap items-center gap-2">
        {active ? (
          <>
            {live && (state.mic === "live"
              ? <Button variant="outline" size="sm" onClick={() => call.pauseMic("manual")}><MicOff aria-hidden /> Pause</Button>
              : <Button variant="outline" size="sm" onClick={() => call.resumeMic()}><Mic aria-hidden /> Resume</Button>)}
            <Button variant="destructive" size="sm" disabled={state.phase === "ending"} onClick={() => void call.end()}>
              <PhoneOff aria-hidden /> End call
            </Button>
          </>
        ) : available ? (
          <Button size="sm" onClick={start}><Phone aria-hidden /> Call again</Button>
        ) : null}
      </div>
      <p className="text-xs leading-snug text-muted-foreground">
        What you say is posted to this Chat when you stop talking. Approvals and deployments still need the on-screen controls.
      </p>
    </section>
  ) : null;

  const label = active ? `End voice call with ${agentName}` : `Voice call with ${agentName}`;
  return (
    <>
      <Button
        variant="ghost"
        size="icon-sm"
        className={cn("size-9 shrink-0 rounded-full", active ? "bg-destructive/10 text-destructive hover:bg-destructive/20" : "text-muted-foreground")}
        aria-label={label}
        title={label}
        aria-pressed={active}
        disabled={state.phase === "ending"}
        onClick={onButton}
      >
        {active ? <PhoneOff className="h-4 w-4" /> : <Phone className="h-4 w-4" />}
      </Button>
      {card && typeof document !== "undefined" ? createPortal(card, document.body) : null}
    </>
  );
}
