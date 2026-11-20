# session-bridge

## Main Chat context maintenance (HOM-458)

For ccpocket_bridge with adapterConfig.role=main, task-context preparation rebuilds
paperclipMainContextCompact from the assigned agent and its own Chat; caller/wake
context cannot widen the scope. adapterConfig.mainContextCompactThresholdTokens
defaults to 150000; a nonnegative safe integer is required and 0 disables it.
Tasks, workers, foreign Chats and other adapters do not receive this policy.
Server preparation owns scope/configuration; the adapter owns idle maintenance;
Bridge owns native readiness and compaction RPCs. No migration or timer is added.

The paired CC Pocket implementation persists intent before maintenance, rechecks
native identity/epoch/activity and idle state, and never retries unknown compaction
or resends user input. Stop/hold and unanswered native prompts defer maintenance.
The same native session remains. TODO, approvals and interaction cards remain
canonical Paperclip data; compaction never grants approval. The adapter reloads
TODO/rules on the next authorized turn even with autonomy off. Maintenance
failure preserves the completed user result; missing maintenance usage stays
explicitly incomplete.

Requires Bridge idle_session_compact_v1 and the matching adapter. Main owns
rollout; HOM-458 does not deploy or restart anything. Disable new attempts with
threshold 0, or revert the paired commits through normal release procedures,
preserving native sessions and operation receipts. See CC Pocket's existing
docs/paperclip-main-agent.md for wire, accounting and re-arm semantics.

Moved from `AGENTS.md` on 2026-11-13 and rewritten the same day for liveness-first.
Binding source: `/home/michael/services/docs/agents/liveness-first.md`; it wins over
any conflicting rule here. Native session bridge: startup recovery to main Chat,
Codex steering, session-bridge keys.

Superseded here and never used to block work: resending uncertain input is no longer
forbidden; original-main blocker failures and their retries are no longer reserved for
Owner escalation; workspace-creator deferred admission and workspace waits no longer
exist; the three original-worker admission budget and "unsettled repair receipts
block later attempts" are removed. Unknown outcomes follow
`docs/agents/execution-semantics.md`: abandon, release and resend in the original
native session (else a new one) with the 「上一次可能已部分執行，先檢查現況再做」 prefix.

## Startup failures and original-main notices

Original-main blocker delivery uses the recovery action's evidence and the existing
delivery coordinator; keep creator/conversation identity and read permissions.
Never recursively wake the same blocked native session. A failed notice turn is
classified like any run failure (transient retries with backoff, deterministic
notifies once per issue and code). Main repairs within its existing authority and
may ask the Owner a question in the original conversation as an ordinary agent
choice; the system never parks work waiting for that answer.

Workspace bootstrap failures fall back to the resolved cwd (workspace = directory)
instead of returning a recovery action. Busy main agents wait for completion events
instead of being interrupted by recovery notices. Historical forwarding is
Owner-only and explicit. Terminal-holder reconciliation never cancels live work or
clears files based on idle status. Keep `doc/DEVELOPING.md`, validators and OpenAPI
aligned. The shared task detail page mounts the creator recovery card for
system-attributed startup failures in both new Task Chat and classic Chat; suppress
the nested duplicate card and generic Retry banner.

## Codex steering

Human Chat wakes must name the conversation owner as requester before queue
admission. An owner-authored saved comment, including `/new`, does not authorize
another human to enqueue a turn. Reject before persisting a run or wake receipt;
system and agent delivery keep their existing authority checks.

Codex main-agent Chats using ccpocket_bridge supplement the exact active turn
through adapter chatSteering and Bridge paperclip_codex_steer_v1. Persist the
effective dispatch's role/provider/model before adapter I/O, without prompts or
credentials; an adapter-type-only admission snapshot cannot select steering.
Enter saves the comment and immediately sends it through the native steer path,
awaiting its acknowledgement without a separate queue action. A browser whose
live-run cache is behind uses the server's current target, while an observed
successor to an already-known target is never substituted. Persist the
queued-comment reservation before provider I/O, preserve original run/result
correlation, and remove only acknowledged IDs from the latest queue. An unacknowledged
steer never blocks queue promotion: the comment stays queued and is delivered again
with the liveness-first prefix. Other harnesses retain Chat interrupt behavior;
ordinary task queues are unchanged. Attachments and interaction responses retain
their normal turn boundaries.

## Session-bridge keys

The Shopee-D pilot uses the explicit runtimeConfig.sessionBridge binding; Bridge
owns the pinned native session. New chat comments use a durable receipt inbox and
never fall back to a heartbeat on disconnect or re-deliver historical comments as new
input. Keep native MCP scope and the configured connector gateway separate.
session_bridge keys may invoke assigned connectors only with allowAssignedTools; they
cannot manage connections or fabricate runs. The connector HTTP boundary preserves
ToolGatewayHttpError status, reasonCode and public details (including approval and
dispatch receipts); unknown errors stay redacted. Never replace an upstream failure
with success. Uncertain provider sends follow the liveness-first resend rule. Update
the canonical contract in doc/plans/2026-11-10-session-bridge-key-scope.md with
protocol changes.


## Main → worker instructions

The project lead main's `POST /issues/:id/comments` and PATCH `comment` default to
same-active-turn steer while that task's worker is running. `deliveryMode: queue`
keeps normal wake delivery; idle workers and already queued messages retain their
original delivery boundary. `POST /issues/:id/continue` with the same handoff comment
reads its direct receipt instead of creating a second wake. System notices, external-chat tasks and
non-main comments retain their existing attributed wake boundary. Owner holds, paused workers and closed
or review-stage tasks never gain direct-input authority.

A `clientRequestId` (`commentClientRequestId` on PATCH) preserves the agent-authored
comment identity on retries. The skipped `worker-instruction:<commentId>` wake row
is a direct-input receipt, never executable queue work; its primary-key UUID is the comment UUID. Reserve it under the issue
lock before provider I/O. Preserve the active dispatch's adapter and exact native
session/turn, and wait for acknowledgement. Rejected, unsupported and unknown sends
return 409 with the comment, target run and receipt IDs; they never silently queue,
resend or create a session, including a subsequent Continue or mode change.
`GET /issues/:id/worker-instructions/:receiptId` reads the original receipt and
reconciles a late acknowledgement only for its pinned turn; it never sends input.
Existing run recovery follows liveness-first independently; these input errors do not pause
or cancel the active worker. Codex Bridge workers require the paired adapter's
`chatSteering` registration; other providers must expose steering explicitly.
