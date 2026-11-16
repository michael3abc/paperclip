import { useEffect, useState } from "react";
import { createPortal } from "react-dom";
import { useQuery } from "@tanstack/react-query";
import { AlertTriangle, Check, ChevronDown, Loader2, Mic, MicOff, Phone, PhoneOff, X } from "lucide-react";
import { localVoiceApi } from "@/api/localVoice";
import { Button } from "@/components/ui/button";
import { useAgentChatEnabled } from "@/hooks/useAgentChatEnabled";
import { cn } from "@/lib/utils";
import { localVoiceActivity, localVoiceDeliveryError, type LocalVoiceSentEntry } from "@/lib/local-voice/local-voice-call";
import { matchesLocalVoiceCall, useLocalVoiceCall, useLocalVoiceSurface } from "./LocalVoiceCallProvider";
import { useSharedVoice } from "./SharedVoiceSelect";

export interface ChatVoiceCallButtonProps {
  companyId: string;
  agentId: string;
  agentName: string;
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
  return <AlertTriangle className="mt-0.5 size-3 shrink-0 text-destructive" aria-label={entry.status === "unknown" ? "送出結果不明" : "Not sent"} />;
}

/**
 * Phone button in a Chat's top bar (HOM-265): starts a voice call bound to the
 * caller's Chat with this agent (the HOM-326 `agent_chat` flow) without leaving
 * the conversation. Each finished utterance is posted to the Chat; the reply's
 * voice summary is read aloud. While a call is open, its status, timer and
 * listening toggle sit inline in the top bar so nothing covers the page; the
 * captions and errors open in a details panel on demand (or by themselves on an error).
 * Uses the browser-wide voice selected on the Voice page (HOM-265).
 * Hidden when local voice or Agent Chat is off.
 */
export function ChatVoiceCallButton({ companyId, agentId, agentName }: ChatVoiceCallButtonProps) {
  const status = useQuery({
    queryKey: ["local-voice", "status", companyId],
    queryFn: () => localVoiceApi.status(companyId),
    staleTime: 60_000,
    retry: false,
  });
  const agentChat = useAgentChatEnabled();
  const host = useLocalVoiceCall();
  const { call, state } = host;
  const callShown = matchesLocalVoiceCall(host.binding, { companyId, agentId, mode: "agent_chat" }, state);
  const [detailsOpen, setDetailsOpen] = useState(false);
  const [voice] = useSharedVoice();
  const live = callShown && state.phase === "live";
  const active = callShown && host.active;
  const elapsed = useElapsed(state.startedAt, live);
  const available = status.data?.enabled === true && status.data.relayConfigured === true && agentChat.enabled;
  useLocalVoiceSurface({ companyId, agentId, mode: "agent_chat" }, available || callShown);
  useEffect(() => setDetailsOpen(false), [companyId, agentId]);
  const sendError = localVoiceDeliveryError(state);
  useEffect(() => { if (callShown && (state.phase === "error" || sendError)) setDetailsOpen(true); }, [callShown, state.phase, sendError]);

  if (!available && !active && !callShown) return null;

  const start = () => {
    setDetailsOpen(false);
    // Must stay inside the click: the call creates its AudioContext synchronously.
    host.start({ companyId, agentId, agentName, mode: "agent_chat", ...(voice ? { voiceName: voice } : {}) });
  };
  const onButton = () => {
    if (active) {
      if (live || state.phase === "starting") void call.end();
      return;
    }
    start();
  };
  const dismiss = () => { host.dismiss(); setDetailsOpen(false); };
  const replyAgent = callShown ? state.agentName ?? host.binding?.agentName ?? agentName : agentName;
  const caption = [...state.transcript].reverse().find((entry) => entry.role === "user") ?? null;
  const recentSent = state.sentLog.slice(-3);
  const statusText = state.phase === "starting" ? "Connecting…"
    : live ? localVoiceActivity(state)
    : state.phase === "ending" ? "Ending…"
    : state.phase === "ended" ? "Call ended"
    : state.phase === "error" ? "Call failed"
    : "Not connected";
  const dot = live ? (state.mic === "live" ? "bg-green-500" : "bg-amber-500") : state.phase === "error" ? "bg-destructive" : "bg-muted-foreground";

  const details = callShown && detailsOpen ? (
    <section
      aria-label={`Voice call details with ${replyAgent}`}
      className="fixed left-4 right-4 top-16 z-50 flex flex-col gap-3 rounded-xl border border-border bg-popover p-4 text-popover-foreground shadow-lg sm:left-auto sm:w-88"
    >
      <div className="flex items-start justify-between gap-2">
        <h2 className="truncate text-sm font-medium">Voice call · {replyAgent}</h2>
        <Button variant="ghost" size="icon-xs" aria-label="Hide call details" onClick={() => setDetailsOpen(false)}>
          <X aria-hidden />
        </Button>
      </div>
      {state.phase === "ended" && <p className="text-xs text-muted-foreground">{state.endedReason ?? "Call ended."}</p>}
      {state.error && <p role="alert" className="text-xs text-destructive">{state.error}</p>}
      {sendError && <p role="alert" className="text-xs text-destructive">{sendError}</p>}
      {state.notice && <p className="text-xs text-muted-foreground">{state.notice}</p>}
      {live && state.timeWarning && <p className="text-xs text-destructive">The call ends automatically in {formatClock(state.maxSeconds - elapsed)}.</p>}
      {live && state.mic === "paused" && state.micPausedReason === "silence" && (
        <p className="text-xs text-muted-foreground">Listening paused after 60 seconds without speech.</p>
      )}
      {caption && <p className="line-clamp-3 break-words text-sm"><span className="text-xs text-muted-foreground">You: </span>{caption.text}</p>}
      {recentSent.length > 0 && (
        <ol className="space-y-1" aria-label={`Sent to ${replyAgent}`}>
          {recentSent.map((entry) => (
            <li key={entry.operationId} className="flex gap-1.5 text-xs text-muted-foreground">
              <SentMark entry={entry} />
              <span className="line-clamp-2 break-words">{entry.text}</span>
            </li>
          ))}
        </ol>
      )}
      {live && Boolean(state.policyVersion) && state.replies.filter((reply) => reply.voiceSummary).slice(-3).map((reply) => <div key={reply.commentId} className="flex items-center gap-2">
        <p className="min-w-0 flex-1 line-clamp-2 text-xs">{reply.voiceSummary}</p>
        <Button size="sm" variant="ghost" onClick={() => call.replayReply(reply.commentId)}>重播</Button>
      </div>)}
      <p className="text-xs leading-snug text-muted-foreground">
        What you say is posted to this Chat when you stop talking. Approvals and deployments still need the on-screen controls.
      </p>
    </section>
  ) : null;

  const blocked = host.active && !callShown;
  const startUnavailableReason = host.startUnavailableReason(companyId);
  const label = active ? `End voice call with ${replyAgent}` : `Voice call with ${agentName}`;
  return (
    <div className="flex shrink-0 items-center gap-1">
      {callShown && (
        <div role="group" aria-label={`Voice call with ${replyAgent}`} className="flex items-center gap-1">
          <button
            type="button"
            className="flex h-8 items-center gap-1.5 rounded-full px-2 text-xs text-muted-foreground hover:bg-accent focus-visible:ring-2 focus-visible:ring-ring"
            aria-expanded={detailsOpen}
            aria-label={`${statusText}. Show call details`}
            title="Call details"
            onClick={() => setDetailsOpen((open) => !open)}
          >
            {state.phase === "starting" || state.phase === "ending"
              ? <Loader2 className="size-3 animate-spin" aria-hidden />
              : <span className={cn("size-2 rounded-full", dot)} aria-hidden />}
            <span role="status">{statusText}</span>
            {live && <span className={cn("tabular-nums", state.timeWarning && "text-destructive")}>{formatClock(elapsed)}</span>}
            {state.error && <AlertTriangle className="size-3 text-destructive" aria-hidden />}
            <ChevronDown className={cn("size-3 transition-transform", detailsOpen && "rotate-180")} aria-hidden />
          </button>
          {live && (state.mic === "live"
            ? <Button variant="ghost" size="icon-sm" className="size-8" aria-label="Pause listening" title="Pause listening" onClick={() => call.pauseMic("manual")}><MicOff className="h-4 w-4" /></Button>
            : <Button variant="ghost" size="icon-sm" className="size-8 text-amber-500" aria-label="Resume listening" title="Resume listening" onClick={() => call.resumeMic()}><Mic className="h-4 w-4" /></Button>)}
          {!active && (
            <Button variant="ghost" size="icon-sm" className="size-8" aria-label="Close voice call" title="Close" onClick={dismiss}>
              <X className="h-4 w-4" />
            </Button>
          )}
        </div>
      )}
      <Button
        variant="ghost"
        size="icon-sm"
        className={cn("size-9 shrink-0 rounded-full", active ? "bg-destructive/10 text-destructive hover:bg-destructive/20" : "text-muted-foreground")}
        aria-label={label}
        title={startUnavailableReason ?? (blocked ? `Already in a voice call with ${host.binding?.agentName}. End that call before starting another.` : label)}
        aria-pressed={active}
        disabled={blocked || state.phase === "ending" || (!active && Boolean(startUnavailableReason))}
        onClick={onButton}
      >
        {active ? <PhoneOff className="h-4 w-4" /> : <Phone className="h-4 w-4" />}
      </Button>
      {details && typeof document !== "undefined" ? createPortal(details, document.body) : null}
    </div>
  );
}
