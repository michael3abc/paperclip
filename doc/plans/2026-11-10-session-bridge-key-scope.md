# Session-bridge key scope, mirror and control events

Date: 2026-11-10. Owner superseding instruction: 「連同實作與相關驗證做完，然後直接上線，並壓縮整體開發時間」. Scope: bidirectional native chat, approved shared-worker dispatch, and assigned connectors. Pilot: AI_Video_Detection on Shopee-D.
Bridge-side counterpart: `docs/paperclip-session-link.md` in the CC Pocket repository.

## Problem

A Paperclip agent chat reaches a CC Pocket session only through a Paperclip run, the adapter, a per-run SSH tunnel and the
stop-proof gate. That is fragile and differs from chatting natively in CC Pocket. The target is: the Bridge is the only
session owner, the card's Claude/Codex has a `paperclip` MCP through the Bridge, Paperclip chat shares the pinned native conversation, and
hold/pause/assignment are delivered back to the Bridge as control events.

A long-lived agent key cannot do any of this on the existing scopes:

- `assertCrossIssueInfluenceWithinRunCap` requires `agentId + runId` for every agent actor, and the run must be a real
  `heartbeat_runs` row. A key has no run, so comments, PATCH and interactions fail with
  `cross_issue_influence_run_context_required`. Faking a run id or keeping a fake running run was rejected (it blocks the
  quiescence gate and cutovers).
- `task_bridge` only reaches issues assigned to or created by the agent.
- A user comment on a conversation issue (`origin: "comment"`, `clientRequestId`, no `authorAgentId`) is picked up by
  `undeliveredConversationComments` and wakes the agent, so mirrored user turns must not use the normal comment path.

## Design

### Scope `session_bridge`

`{ kind: "session_bridge", projectIds: string[], conversationAgentId?: string, allowCreateTasks?: boolean, allowAssignedTools?: boolean }`, strict, at
least one project. Created only through the existing board-only `POST /api/agents/:id/keys`, which additionally verifies
that every project belongs to the company and that `conversationAgentId` is the key's own agent. The one-time `token` is
returned once (201) and never stored or logged. `DELETE /api/agents/:id/keys/:keyId` revokes.

`decideSessionBridgeAccess` in `authorization.ts` is deny-by-default with an allowlist:

- allowed: company/project/issue reads inside `projectIds` and the agent's own conversation issue; comments and documents on
  those issues; when `allowCreateTasks`, creating issues in `projectIds` (`originKind: "session_bridge"`, `originId = keyId`)
  and only updating the issues it created.
- denied: connection management (added to `isConnectionManagementAction`), secrets, runtime tools, agent/budget/approval/decision-queue
  management, cross-project writes, and checkout/release (`requireAgentRunId` is not relaxed).
- `session-bridge-guard.ts` is an edge allowlist in front of the routers, so a route that forgets an authorization decision
  still cannot be reached by this scope.

### Run-context exemption

`assertCrossIssueInfluenceWithinRunCap` does not throw for a `session_bridge` actor with no run. It uses a separate
per-key rate limit (300 writes per hour, `session-bridge-write-limit.ts`) and records `keyId` and `sessionBridge: true` in
the activity `details`. Every other agent actor is unchanged. The exemption is for this scope only and must not be
extended to `standard` or `task_bridge`.

### Mirror route

`POST /api/issues/:id/external-turns` (only `session_bridge` actors). Body `{ externalId, role, body, sessionId, ts }`.

- The issue must be the key agent's conversation: `conversationAgentId == key agent` and
  `conversationUserId == key's responsibleUserId`; otherwise 403.
- Idempotent through the existing unique indexes, no migration: `clientRequestId = bridge:<sessionId>:<externalId>`;
  assistant turns use `authorAgentId` (`issue_comments_agent_client_request_uq`), user turns use `authorUserId`
  (`issue_comments_client_request_uq`). A unique conflict returns the original comment.
- Does not wake anyone: the row is written directly to `issue_comments` (not through `addComment`, no
  `enqueueFastResponse` / `deliverConversationComments`) with `origin: "external_mirror"`; `undeliveredConversationComments`
  filters on `origin = 'comment'`, so mirrored turns are never redelivered. `origin` is a text column; only the `$type` changed.
- Server-owned metadata (`authorizationReason: "session_bridge_mirror"`); client-supplied presentation/metadata stays
  board-only.

### Control events

`GET /api/agents/me/session-bridge/events?after=<cursor>&wait=<sec>`, `session_bridge` keys only, event-driven long poll.
Cursor is `<µs UTC>|<uuid>` over the existing activity log (no new table). Event types: `agent_paused`, `agent_resumed`,
`hold_created`, `hold_released`, `issue_assigned`. A first call without a cursor returns the head cursor plus a snapshot
of the current pause/holds. The Bridge pulls, so Paperclip never connects into the Shopee hosts.

## Key lifecycle

One key per card and host, named `session-bridge:<host>`. Provisioned, rotated and revoked by
`/home/michael/services/systemd/platform/paperclip-session-bridge/provision.mjs` (board session of the configured operator;
no DB writes). The token only travels over ssh stdin into a 0600 file; receipts hold key ids, paths and hashes only. A
failed install deletes the freshly created key. Rotation swaps the key file first, then revokes the old key.

## Known limits

- A fullAccess model running as the same user can read the key file. Mitigation: narrow scope, one key per card, revocable,
  per-key rate limit, attribution by key id.
- Hold and pause only interrupt the live session through the Bridge; they do not stop a session the Bridge does not know
  about.
- Pre-existing, not part of this work: `session.test.ts` (Bridge repo) has 8 failures from a `node:fs` mock without
  `lstatSync`.

## Release

Additive only (no migration, `origin` is text), so the previous release keeps running on the new schema. Release order:
Paperclip server, then the Shopee-D reverse tunnel and `provision.mjs create`, then the Bridge upgrade on D, then pilot
verification. Tests are the related files only (owned test DB, bounded lanes); never the full suite.

## Native chat and delivery contract (supersedes the Phase 0+1 exclusions)

The Owner-configured agent runtimeConfig.sessionBridge is a strict version 1 binding:
projectId, conversationIssueId, nativeSessionId. The private host link pins the same
nativeSessionId. Connectivity does not select a route: a configured agent never
falls back to adapter delivery. No historical comment or failed run is replayed.
The pilot is Shopee-D AI_Video_Detection; other cards retain their existing routing.

New authenticated text comments on the bound conversation are stored atomically
with origin=session_bridge_input. They do not enqueue a fast response or heartbeat.
The durable comment rows are the inbox; control long polling wakes on this
conversation's committed comment events, and includes pending receipts on reconnect.
First boot and reconnect reconstruct from rows rather than advancing a chat cursor.
The control transport renews a bounded 25-second long poll; it is not a host-sleep
claim and does not add a periodic background SQL scanner.

POST /agents/me/session-bridge/receipt claims a comment as delivering under the
conversation row lock, binding claimId, nativeSessionId and keyId. Current human
ownership, key project scope, lifecycle and holds remain authoritative. The Bridge
persists prepared -> sending -> sent locally and acknowledges delivered server-side.
It selects exactly the pinned native session, interrupts a busy turn once, then
waits for actual idle. No session means pending; multiple owners fail explicitly.
A lost acknowledgement can be resent without resending input. A crash in sending
is uncertain and blocks replay with a visible Bridge notice; elapsed time is not
stop or delivery proof. There is no exactly-once claim across a provider crash.
Responses are mirrored while the original Paperclip human comment is not echoed.
The UI presentation model consumes the shared comment origin type and preserves
external_mirror/session_bridge_input provenance through the chat adapter.
Other sessions sharing the project directory cannot mirror into the pinned chat.
Text is the pilot composer contract; native resets and attachments remain in CC
Pocket and are explicitly rejected here instead of silently dropping them.

## Worker dispatch

The provisioned key enables allowCreateTasks. paperclipListWorkerSelections reads
only this main agent's current diagnostics and configured project source IDs.
paperclipCreateIssue already carries the shared schema's workerSelectionId,
workspaceSelection, initialPlan and idempotencyKey. The existing main-agent
middleware performs assertPmDispatch, rechecks the Owner policy/document, host,
model and workspace, and preserves native review. No worker configuration API is
opened. Updates to created tasks cannot change worker/model/workspace/review policy.
No new test or acceptance task is an old-run Retry.

## Assigned connectors without a run

allowAssignedTools enables only tools-search and tools-call beneath the native
session route. The MCP launcher sets PAPERCLIP_SESSION_BRIDGE=1 and publishes a
scoped tool catalog; checkout, approvals, connection management and run-only intent
tools are not advertised. This is presentation, not an authorization grant.

The configured application gateway authenticates the same key on every operation,
checks current agent/key/Owner conversation identity, and evaluates existing tool
profiles, connector grants, approvals, rate limits and audit. It uses the real
conversation's project context (which may be null), never an invented run or project.
On-demand connector descriptors are searchable through the same policy. Execution
reauthenticates before the external effect. Keys and upstream credentials never
appear in MCP schemas or tool responses. The endpoint requires an idempotency key
namespaced by company/agent/responsible user. Run-required providers keep rejecting
non-run calls; no global relaxation. SeaTalk uses its existing assigned connection
and configured gateway transport, not a new user credential or unrestricted proxy.
Both connector routes preserve the gateway's typed HTTP status, reasonCode, message
and public details, matching the existing gateway HTTP contract. Approval references
and dispatch evidence must reach the caller; an expired upstream login must remain
an actionable failure. Unknown internal errors retain the global redacted 500.
Error handling never retries a connector call or changes its idempotency key.

## Verification

Use owned disposable PostgreSQL databases and bounded related test lanes. Cover
concurrent claims, reconnect/lost ack, uncertain send, pinned-session ownership,
no adapter wake, foreign user/project denial, pause/revocation, exact worker schema,
and a real HTTP fixture connector call with runId=null. Retain failures and fixes.
Production acceptance checks the original native ID, both chat directions, assigned
connector discovery/read, and a new bounded worker task. Never claim external
message sending was tested without a separate explicitly authorized recipient.

Session-bridge-only MCP definitions live in packages/mcp-server/src/session-bridge-tools.ts;
keep them separate from the Runner legacy MCP catalog in tools.ts. Regenerate the
Runner capability source anchors when legacy definitions move, and verify both
catalog surfaces without granting session-only tools to heartbeat clients.
