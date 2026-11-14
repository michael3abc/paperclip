import { useEffect, useMemo, useState, useSyncExternalStore, type FormEvent } from "react";
import { AlertTriangle, Check, Mic, MicOff, Phone, PhoneOff, Send, X } from "lucide-react";
import { LOCAL_VOICE_CONFIRMATION_PHRASE } from "@paperclipai/shared";
import { Button } from "@/components/ui/button";
import { MarkdownBody } from "@/components/MarkdownBody";
import { Link } from "@/lib/router";
import { cn } from "@/lib/utils";
import { createLocalVoiceCall, type LocalVoiceCall } from "@/lib/local-voice/local-voice-call";

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
  /** Continue a specific voice task; otherwise the latest open one (or a new one). */
  issueId?: string;
  /** Test seam. */
  call?: LocalVoiceCall;
}

/**
 * Browser voice call with an agent through the same-origin Gemini Live relay
 * (HOM-311). Drafts are confirmed by the spoken phrase or the button here;
 * approvals, deployment and settings changes are never available by voice.
 */
export function LocalVoicePanel({ companyId, agentId, agentName, issueId, call: injected }: LocalVoicePanelProps) {
  const call = useMemo(() => injected ?? createLocalVoiceCall(), [injected]);
  useEffect(() => () => call.dispose(), [call]);
  const state = useSyncExternalStore(call.subscribe, call.getSnapshot);
  const [text, setText] = useState("");
  const live = state.phase === "live";
  const elapsed = useElapsed(state.startedAt, live);
  const remaining = state.maxSeconds - elapsed;
  const busy = state.phase === "starting" || state.phase === "ending";

  const start = (newConversation = false) => {
    void call.start({ companyId, agentId, ...(issueId && !newConversation ? { issueId } : {}), ...(newConversation ? { newConversation: true } : {}) });
  };
  const submitText = (event: FormEvent) => {
    event.preventDefault();
    if (call.sendText(text)) setText("");
  };

  return (
    <section className="flex min-w-0 flex-col gap-4" aria-label={`Voice call with ${agentName}`}>
      <div className="flex flex-wrap items-center gap-2">
        {live || busy ? (
          <Button variant="outline" size="sm" onClick={() => void call.end()} disabled={state.phase === "ending"}>
            <PhoneOff aria-hidden /> End call
          </Button>
        ) : (
          <>
            <Button size="sm" onClick={() => start(false)}><Phone aria-hidden /> Start voice call</Button>
            <Button variant="ghost" size="sm" onClick={() => start(true)}>New voice task</Button>
          </>
        )}
        {live && (state.mic === "live"
          ? <Button variant="outline" size="sm" onClick={() => call.pauseMic("manual")}><MicOff aria-hidden /> Pause mic</Button>
          : <Button variant="outline" size="sm" onClick={() => call.resumeMic()}><Mic aria-hidden /> Resume mic</Button>)}
        <span role="status" className="text-sm text-muted-foreground">
          {state.phase === "starting" && "Connecting…"}
          {live && (state.modelSpeaking ? "Speaking" : state.mic === "live" ? "Listening" : "Mic paused")}
          {state.phase === "ending" && "Ending…"}
          {state.phase === "ended" && (state.endedReason ?? "Call ended.")}
        </span>
        {live && (
          <span className={cn("ml-auto text-sm tabular-nums", state.timeWarning ? "text-destructive" : "text-muted-foreground")}>
            {formatClock(elapsed)} / {formatClock(state.maxSeconds)}
          </span>
        )}
      </div>

      {state.issue && (
        <p className="text-xs text-muted-foreground">
          Voice task <Link className="text-primary underline" to={`/issues/${state.issue.identifier ?? state.issue.id}`}>{state.issue.identifier ?? "open task"}</Link>
          {" · "}assigned to {state.agentName ?? agentName}
        </p>
      )}
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

      {state.draft && (
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

      {state.replies.length > 0 && (
        <div className="space-y-3">
          <h2 className="text-sm font-medium">Replies from {state.agentName ?? agentName}</h2>
          {state.replies.map((reply) => (
            <article key={reply.commentId} className="space-y-2 rounded-lg border border-border p-4">
              {reply.voiceSummary && <p className="text-sm font-medium">{reply.voiceSummary}</p>}
              <MarkdownBody>{reply.body}</MarkdownBody>
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
