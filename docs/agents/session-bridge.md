# session-bridge

Moved verbatim from `AGENTS.md` on 2026-11-13. These rules and records stay binding; read this file before acting on the topic. Native session bridge: startup recovery to main Chat, Codex steering, session-bridge keys

Original-main blocker delivery uses the recovery action's protected evidence and
the existing delivery coordinator. Preserve exact creator/conversation/generation,
read permissions, holds and durable wake identity. Never recursively wake a blocked
native session, equate a session ID with input acceptance, or resend uncertain
input. Main repairs within existing authority; inability goes to an Owner question
in the original conversation. No automatic historical enrollment or extra retry
budget. See `doc/execution-semantics.md`.
Failed original-main blocker turns and their automatic retry descendants belong
to the original notice's Owner escalation, never generic continuation or transient
retry. Accepted input followed by failure still requires Owner escalation; a new
explicit Owner input retains independent authority.
Workspace-creator deferred admission retains its exact durable wake and wait
reason; do not classify it as unknown delivery or re-send it. Independent new
Owner input is not authority to replay that system notice.

Workspace bootstrap failures may return the original recovery action to the verified project main
agent's original Chat. Use system provenance, pre-provider/settlement evidence and durable receipts;
unknown sends only reconcile the original receipt. Repair uses revision-bound `workspaceRepair`
with the ordinary registered-worktree or session-only selection service; recovery
must not impose the retired configured-source-only contract. Busy main agents
wait for completion events instead of being interrupted by recovery notices.
Owner delivery rechecks retain action revision, original wake identity and human
decisions; missing receipts alone never authorize resending provider input.
An explicit Owner creator recheck may withdraw only an unsent system blocker
question proven to follow that recovery's acknowledged system interruption;
retain human questions, holds and unknown delivery. Withdrawal grants no replay.
Allow at most three original-worker admissions across new actions for the same task, preserving
assignment/model/review/holds. Count committed repair receipts, including pending/uncertain delivery;
same-failure API replay or workspace changes never replenish the allowance. Pre-upgrade actions
retain their one-admission limit; exhaustion returns ownership to Owner without another notice.
Unsettled repair receipts block later attempts; original-receipt settlement notifies the existing
coordinator to reconsider pending candidates without polling or re-sending.
Historical forwarding
is Owner-only and explicit. Terminal-holder reconciliation never cancels live work or clears files
based on idle status. Keep `doc/DEVELOPING.md`, validators and OpenAPI aligned.
The shared task detail page must mount the creator recovery card for system-attributed startup
failures in both new Task Chat and classic Chat. Suppress the nested duplicate card and generic
Retry banner; verify the assembled page, not only the card.

Codex main-agent Chats using ccpocket_bridge supplement the exact active turn
through adapter chatSteering and Bridge paperclip_codex_steer_v1. Persist the
queued-comment reservation before provider I/O, preserve original run/result
correlation, and remove only acknowledged IDs from the latest queue. Uncertain
delivery blocks queue mutation and promotion until its original durable receipt
settles; never interrupt, replay, start an idle turn or resend it automatically.
Other harnesses retain Chat interrupt behavior; ordinary task queues are unchanged.
Attachments and interaction responses retain their normal turn boundaries.

The Shopee-D pilot uses the explicit runtimeConfig.sessionBridge binding; Bridge
owns the pinned native session. New chat comments use a durable receipt inbox and
must never fall back to a heartbeat on disconnect or replay historical comments.
Keep native MCP scope, worker selection/workspace validation and the configured
connector gateway separate. session_bridge keys may invoke assigned connectors
only with allowAssignedTools; they cannot manage connections or fabricate runs.
The connector HTTP boundary preserves ToolGatewayHttpError status, reasonCode and
public details (including approval and dispatch receipts); unknown errors stay
redacted. Never replace an upstream failure with success or automatically replay it.
Retain uncertain provider sends without automatic replay. Update the canonical
contract in doc/plans/2026-11-10-session-bridge-key-scope.md with protocol changes.

