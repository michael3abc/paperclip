import { useEffect, useState, type FormEvent } from "react";
import { AlertTriangle, Check, Loader2, Mic, MicOff, Phone, PhoneOff, Send, X } from "lucide-react";
import { LOCAL_VOICE_CONFIRMATION_PHRASE } from "@paperclipai/shared";
import { matchesLocalVoiceCall, useLocalVoiceCall, useLocalVoiceSurface } from "./LocalVoiceCallProvider";
import { Button } from "@/components/ui/button";
import { MarkdownBody } from "@/components/MarkdownBody";
import { Link } from "@/lib/router";
import { cn } from "@/lib/utils";
import { localVoiceActivity, localVoiceDeliveryError, type LocalVoiceMode, type LocalVoiceSentEntry } from "@/lib/local-voice/local-voice-call";

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

export interface LocalVoicePanelProps {
  companyId: string;
  agentId: string;
  agentName: string;
  /** voice_task: continue a specific voice task; otherwise the latest open one (or a new one). */
  issueId?: string;
  /** Default `agent_chat` (the caller's Chat with the agent); `voice_task` when `issueId` is given. */
  mode?: LocalVoiceMode;
  /** This agent's remembered voice (HOM-265); null or omitted uses the server default. Read at each call start. */
  voiceName?: string | null;
}

function SentStatus({ entry }: { entry: LocalVoiceSentEntry }) {
  if (entry.status === "sending") return <span className="flex items-center gap-1 text-xs text-muted-foreground"><Loader2 className="size-3 animate-spin" aria-hidden /> Sending…</span>;
  if (entry.status === "sent") return <span className="flex items-center gap-1 text-xs text-muted-foreground"><Check className="size-3" aria-hidden /> Sent</span>;
  if (entry.status === "unknown") return <span className="text-xs text-destructive">送出結果不明</span>;
  if (entry.status === "dropped") return <span className="flex items-center gap-1 text-xs text-muted-foreground"><X className="size-3" aria-hidden /> {entry.error ?? "Not sent"}</span>;
  return <span className="flex items-center gap-1 text-xs text-destructive"><AlertTriangle className="size-3" aria-hidden /> Not sent</span>;
}

/**
 * Browser voice call with an agent through the same-origin realtime relay
 * (HOM-311; OpenAI Realtime by default, Gemini Live fallback, HOM-318).
 * `agent_chat` (HOM-326): each finished utterance goes straight to the caller's Chat with the agent.
 * `voice_task`: drafts are confirmed by the spoken phrase or the button here.
 * Approvals, deployment and settings changes are never available by voice.
 */
export function LocalVoicePanel({ companyId, agentId, agentName, issueId, mode: requestedMode, voiceName = null }: LocalVoicePanelProps) {
  const mode: LocalVoiceMode = requestedMode ?? (issueId ? "voice_task" : "agent_chat");
  const chatMode = mode === "agent_chat";
  const host = useLocalVoiceCall();
  const { call, state } = host;
  const startUnavailableReason = host.startUnavailableReason(companyId);
  const ownsCall = matchesLocalVoiceCall(host.binding, { companyId, agentId, mode, issueId }, state);
  useLocalVoiceSurface({ companyId, agentId, mode, issueId });
  const [text, setText] = useState("");
  const live = ownsCall && state.phase === "live";
  const elapsed = useElapsed(state.startedAt, live);
  const remaining = state.maxSeconds - elapsed;
  const busy = state.phase === "starting" || state.phase === "ending";
  /** The voice the open call started with; a different choice applies to the next call. */
  const callVoice = host.binding?.voiceName ?? null;

  const start = (newConversation = false) => {
    const voice = voiceName ? { voiceName } : {};
    if (chatMode) return void host.start({ companyId, agentId, agentName, mode, ...voice });
    void host.start({ companyId, agentId, agentName, mode, ...(issueId && !newConversation ? { issueId } : {}), ...(newConversation ? { newConversation: true } : {}), ...voice });
  };
  const replyAgent = state.agentName ?? agentName;
  const submitText = (event: FormEvent) => {
    event.preventDefault();
    if (call.sendText(text)) setText("");
  };

  if (!ownsCall) return <section aria-label={`Voice call with ${agentName}`} className="flex flex-col gap-3">
    {startUnavailableReason && <p role="status" className="text-sm text-muted-foreground">{startUnavailableReason}</p>}
    {host.active && <p role="status" className="text-sm text-muted-foreground">Voice call with {host.binding?.agentName} is still active. End that call before starting another.</p>}
    <div className="flex flex-wrap gap-2">
      <Button size="sm" disabled={host.active || Boolean(startUnavailableReason)} onClick={() => start(false)}><Phone aria-hidden /> Start voice call</Button>
      {!chatMode && <Button variant="ghost" size="sm" disabled={host.active || Boolean(startUnavailableReason)} onClick={() => start(true)}>New voice task</Button>}
    </div>
  </section>;

  return (
    <section className="flex min-w-0 flex-col gap-4" aria-label={`Voice call with ${agentName}`}>
      <div className="flex flex-wrap items-center gap-2">
        {live || busy ? (
          <Button variant="outline" size="sm" onClick={() => void call.end()} disabled={state.phase === "ending"}>
            <PhoneOff aria-hidden /> End call
          </Button>
        ) : (
          <>
            <Button size="sm" disabled={Boolean(startUnavailableReason)} onClick={() => start(false)}><Phone aria-hidden /> Start voice call</Button>
            {!chatMode && <Button variant="ghost" size="sm" disabled={Boolean(startUnavailableReason)} onClick={() => start(true)}>New voice task</Button>}
          </>
        )}
        {live && (state.mic === "live"
          ? <Button variant="outline" size="sm" onClick={() => call.pauseMic("manual")}><MicOff aria-hidden /> {chatMode ? "Pause listening" : "Pause mic"}</Button>
          : <Button variant="outline" size="sm" onClick={() => call.resumeMic()}><Mic aria-hidden /> {chatMode ? "Resume listening" : "Resume mic"}</Button>)}
        <span role="status" className="text-sm text-muted-foreground">
          {state.phase === "starting" && "Connecting…"}
          {live && localVoiceActivity(state)}
          {state.phase === "ending" && "Ending…"}
          {state.phase === "ended" && (state.endedReason ?? "Call ended.")}
        </span>
        {(live || busy) && voiceName !== callVoice && <span className="text-xs text-muted-foreground">Voice change applies to the next call.</span>}
        {live && (
          <span className={cn("ml-auto text-sm tabular-nums", state.timeWarning ? "text-destructive" : "text-muted-foreground")}>
            {formatClock(elapsed)} / {formatClock(state.maxSeconds)}
          </span>
        )}
      </div>

      {chatMode && (
        <div className="space-y-1 text-xs text-muted-foreground">
          <p>
            Connected to your Chat with {replyAgent} — <Link className="text-primary underline" to={`/chats/${encodeURIComponent(agentId)}`}>Open Chat</Link>
          </p>
          <p>What you say is sent to the Chat as soon as you stop talking. Approvals, deployments and settings still need the normal Paperclip controls.</p>
        </div>
      )}
      {!chatMode && state.issue && (
        <p className="text-xs text-muted-foreground">
          Voice task <Link className="text-primary underline" to={`/issues/${state.issue.identifier ?? state.issue.id}`}>{state.issue.identifier ?? "open task"}</Link>
          {" · "}assigned to {state.agentName ?? agentName}
        </p>
      )}
      {localVoiceDeliveryError(state) && <p role="alert" className="text-sm text-destructive">{localVoiceDeliveryError(state)}</p>}
      {state.error && <p role="alert" className="text-sm text-destructive">{state.error}</p>}
      {state.notice && <p className="text-sm text-muted-foreground">{state.notice}</p>}
      {live && state.timeWarning && (
        <p role="alert" className="flex items-center gap-2 text-sm text-destructive">
          <AlertTriangle className="size-4" aria-hidden /> The call ends automatically in {formatClock(remaining)}.
        </p>
      )}
      {live && state.mic === "paused" && state.micPausedReason === "silence" && (
        <div className="flex flex-wrap items-center gap-2 rounded-lg border border-border p-3 text-sm">
          <MicOff className="size-4" aria-hidden /> The microphone paused after 60 seconds without speech.
          <Button size="sm" variant="outline" onClick={() => call.resumeMic()}>Resume</Button>
        </div>
      )}

      {!chatMode && state.draft && (
        <div className="space-y-2 rounded-lg border border-border p-4" aria-label="Draft for confirmation">
          <p className="text-xs font-medium text-muted-foreground">
            Draft for {state.agentName ?? agentName} · revision {state.draft.revision}
          </p>
          <p className="whitespace-pre-wrap break-words text-sm">{state.draft.text}</p>
          {state.draft.status === "submitted" ? (
            <p className="flex items-center gap-1 text-sm text-muted-foreground"><Check className="size-4" aria-hidden /> Sent{state.draft.via === "spoken" ? " (spoken confirmation)" : ""}.</p>
          ) : (
            <>
              <p className="text-xs text-muted-foreground">Say “{LOCAL_VOICE_CONFIRMATION_PHRASE}” after the draft is read back, or confirm here. Approvals, deployments and settings still need the normal Paperclip controls.</p>
              {state.draft.error && <p role="alert" className="text-sm text-destructive">{state.draft.error}</p>}
              <div className="flex flex-wrap gap-2">
                <Button size="sm" onClick={() => call.confirmDraft()} disabled={!live || state.draft.status === "submitting"}>
                  <Send aria-hidden /> {state.draft.status === "submitting" ? "Sending…" : "Confirm and send"}
                </Button>
                <Button size="sm" variant="ghost" onClick={() => call.cancelDraft()} disabled={!live || state.draft.status === "submitting"}>
                  <X aria-hidden /> Discard
                </Button>
              </div>
            </>
          )}
        </div>
      )}

      {chatMode && state.sentLog.length > 0 && (
        <div className="space-y-2">
          <h2 className="text-sm font-medium">Sent to {replyAgent}</h2>
          <ol className="space-y-2" aria-label={`Sent to ${replyAgent}`}>
            {state.sentLog.map((entry) => (
              <li key={entry.operationId} className="space-y-1 rounded-lg border border-border p-3">
                <p className="whitespace-pre-wrap break-words text-sm">{entry.text}</p>
                <SentStatus entry={entry} />
                {(entry.status === "failed" || entry.status === "unknown") && entry.error && <p role="alert" className="text-xs text-destructive">{entry.error}</p>}
              </li>
            ))}
          </ol>
        </div>
      )}

      {state.replies.length > 0 && (
        <div className="space-y-3">
          <h2 className="text-sm font-medium">Replies from {state.agentName ?? agentName}</h2>
          {state.replies.map((reply) => (
            <article key={reply.commentId} className="space-y-2 rounded-lg border border-border p-4">
              {reply.voiceSummary && <p className="text-sm font-medium">{reply.voiceSummary}</p>}
              <MarkdownBody>{reply.body}</MarkdownBody>
              {chatMode && reply.playbackState === "interrupted" && <p className="text-xs text-muted-foreground">播音已中斷，回答保留於 Chat。</p>}
              {chatMode && live && Boolean(state.policyVersion) && reply.voiceSummary && <Button size="sm" variant="ghost" onClick={() => call.replayReply(reply.commentId)}>重播</Button>}
            </article>
          ))}
        </div>
      )}

      {live && (
        <form className="flex gap-2" onSubmit={submitText}>
          <input
            className="min-w-0 flex-1 rounded-md border border-input bg-background p-2 text-sm"
            value={text}
            onChange={(event) => setText(event.target.value)}
            placeholder="Type instead of speaking"
            aria-label="Type a message"
            maxLength={4000}
          />
          <Button size="sm" variant="outline" type="submit" disabled={!text.trim()}>Send</Button>
        </form>
      )}

      {state.transcript.length > 0 && (
        <ol className="max-h-64 space-y-1 overflow-y-auto text-sm" aria-label="Captions">
          {state.transcript.map((entry) => (
            <li key={entry.id} className="break-words">
              <span className="text-xs font-medium text-muted-foreground">{entry.role === "user" ? "You" : "Assistant"}: </span>
              {entry.text}
            </li>
          ))}
        </ol>
      )}
    </section>
  );
}
