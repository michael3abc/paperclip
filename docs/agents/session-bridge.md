# session-bridge

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

Codex main-agent Chats using ccpocket_bridge supplement the exact active turn
through adapter chatSteering and Bridge paperclip_codex_steer_v1. Persist the
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
