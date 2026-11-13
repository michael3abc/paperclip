# bridge-run-lifecycle

Moved verbatim from `FORK.md` on 2026-11-13. These rules and records stay binding; read this file before acting on the topic. Bridge stop settlement/proof, interrupt handoff, resident authority, chat preemption

2026-11-12 bootstrap native restoration: maintenance may replace a Bridge card
before its null-native bootstrap authority has advanced. Permit a new admitted
run to bind the published original native session only through current server
authority, exact original accepted-input/invocation proof and predecessor/generation
CAS. Preserve late-writer rejection, missing-binding fences and original failures.
No input replay, authority backfill, task resurrection or adapter bypass.

- Legacy resident authority index recovery (2026-11-12): an admitted new run may
  reconstruct a missing task-session row from the exact host current-run pointer
  and original server invocation/result identity receipts. Preserve generation
  CAS, foreign/native owner exclusion and feature-era revocation history; no
  terminal-status enrollment, historical replay or direct database repair.

- Resident Bridge authority (feature prerequisite, 2026-11-12): server CAS before
  host binding and input; current run/generation/native identity in existing JSON.
  Preserve cancellation, terminal helper boundaries, operation receipts and
  cross-task native identity. Stale helper writes and late session publication
  cannot replace the successor. Cooperative workspace admission remains staged.

- Remote boot cleanup handoff (2026-11-12): consume original Owner-observed
  Bridge host reboot receipts through durable stop settlement and file collection.
  Preserve exact host/finish/launch binding, failed outcomes and bounded checks;
  later execution invalidates the old receipt. No provider input or task replay.

- Durable run stop settlement (2026-11-11): read-only Bridge/native verification,
  persistent four-check budgets, cleanup-only native finalization and same-row
  event-driven workspace waits. Recheck keeps original sessions, errors and holds;
  UI reflects stopping/cleaning/attention/settled states from one public projection.
  Related PostgreSQL, heartbeat, adapter and UI tests cover evidence races and idle
  behavior. No schema migration or historical task replay.
  Local legacy completion now retains independent process-tree stop evidence for
  copy-free runs, so an actually completed writer does not strand its successor.

- Remote host boot-boundary holder settlement (2026-11-11): holderless
  remote-managed workspace waits can be reconciled by the Owner. Admission's
  own owner query is reused; a read-only Bridge adapter observation of the host
  boot id/uptime/SSH endpoint records `workspace.remote_host_rebooted` for
  terminal same-company owners that finished before the boot. All other
  settlement fences remain; nothing is cancelled, woken or replayed.

- Chat always interrupts (2026-11-09): in Agent Chat a message sent while the agent is
  working now stops that turn through the existing queued-comment interrupt (owner-only,
  `enableAgentChat`), so it is delivered next instead of waiting. Each chat message keeps
  its own saved receipt, so the queue stays interruptible once every later message is
  saved, and the interrupt's successor adopts all of the same user's still-deferred chat
  messages into one run (coalesced, never cancelled; other users' messages keep waiting).
  A CC Pocket bridge turn's acknowledged, unforced stop receipt now counts as stop proof
  for that explicit user turn when the historical and current adapters are both
  `ccpocket_bridge`; forced, failed or mismatched cases stay blocked. Tasks are unchanged.
  No schema change.
- Failed bridge turn handoff (HOM-265, 2026-11-10): a `ccpocket_bridge` run the adapter
  reports as `failed` (for example a provider error after a failed context compaction)
  may leave its resident session working, and it has no stop record, so the next explicit
  user message was held forever with `process_identity_missing`. `bridgeSessionHandoffFor`
  now also admits a legacy `failed` run that has both session IDs and no
  `executionCancellation`, as a same-session handoff: the adapter waits for the session
  to settle before delivering. The failed run is not rewritten as acknowledged; a stop
  request on record (forced or not), missing IDs or adapter mismatches stay blocked.
  Nothing is replayed; no schema change.
- Never-started Bridge runs (AI_Video_Detection SHO-14, 2026-11-10): a legacy
  `ccpocket_bridge` run that failed with `session_start_failed`, `session_busy`,
  `session_not_found` or `adapter_error` before owning any session work (no process,
  no native session id, no `executionCancellation`, no Bridge session id except the
  vanished card named by `session_not_found`) counts as stopped for the next explicit
  user turn. `execution_uncertain` is excluded. The adapter still re-checks that the
  resident session is idle before delivery. No run is rewritten or replayed; no schema
  change.
- Chat preempts the main agent's task (2026-11-09): an owner Agent Chat message
  (`enableAgentChat`) that waits for capacity behind its own main agent's running turn on
  a different, ordinary task now gracefully interrupts that turn with the chat-interrupt
  stop semantics. `GET /issues/:id/queued-comments` reports `preemptibleRunId` only to the
  conversation owner, and the chat send interrupts that run instead of returning on
  "queued". The chat run carries a `paperclipChatPreemption` marker so the scheduler starts
  it first; after an acknowledged, unforced CC Pocket stop the task continues behind it
  through the existing task Retry receipt `chat-preempt:<runId>` (one per preempted run,
  never a replay). The task records an `issue.chat_preempted` activity receipt. Forced,
  failed or mismatched stops keep the existing blocked/hold behavior. Other users' messages,
  other agents' runs and same-issue chat behavior are unchanged. Main agents are also told
  to implement in chat and create tasks only when separate tracking is needed
  (`890f9672d`). No schema change.
- Bridge never-delivered stop proof (2026-11-12): an Agent Chat message that interrupted a
  `ccpocket_bridge` run before the adapter had recorded any session (cancelled in about ten
  seconds, no `executionCancellation`, no bridge or native session ids) stayed on
  `process_identity_missing` and exhausted the four stop-settlement checks, because every existing
  proof needs those ids. Adapters may now expose a read-only `reverifyUndispatchedRunStop`
  hook. The server asks it only for a legacy, cancelled, finished run with no cancellation,
  session identity, process or earlier receipt, and accepts only
  `ccpocket.bridge-undispatched-stop.v1` proof bound to that run: the adapter persists a dispatch
  before it sends input, so a run absent from its state whose card history matches the recorded
  inputs exactly, with an idle card, no current turn and known empty background work, delivered
  nothing. The receipt is written under `executionStopVerification` (no cancellation is invented)
  through a compare-and-set on the inspected row, wakes the same deferred and stop-settlement
  work as other proofs, and is honored by `bridgeSessionStopAcknowledged` and stop settlement.
  Unverified, busy, recorded or changed runs keep the hold; nothing is sent, interrupted,
  replayed or forced. Requires the matching ccpocket adapter. No schema change.
- Bridge stop re-verification (2026-11-09): a cancelled, legacy `ccpocket_bridge` run whose
  unforced Stop stayed `requested` (the adapter could not confirm it at cancel time) blocked
  that task's queued messages with `process_identity_missing` forever. Adapters may now expose
  a read-only `reverifyCancelledRunStop` hook. Before a deferred-receipt sweep releases or
  promotes a held message, and after a remote-stop acknowledgement, the server asks it for
  `ccpocket.bridge-stop-reverification.v1` proof bound to this run and its recorded bridge and
  native sessions, with known and empty background work. Only that proof is persisted, through a
  compare-and-set on the exact requested cancellation (`proof: bridge_session_reverified`); the
  run status event is published afterwards. Unverified, timed-out, failed or mismatched checks
  keep the hold, forced or failed stops are never acknowledged, attempts are limited to one per
  run per minute, and nothing is replayed (`30a30590e`). No schema change.
- Bridge interrupt handoff (2026-11-09): an explicit Agent Chat message that interrupts a
  `ccpocket_bridge` turn whose unforced Stop stayed `requested` (the Bridge had not returned
  the turn's result within the adapter's 30-second window) no longer waits for stop proof.
  When both the historical and current adapters are `ccpocket_bridge` and the run records
  its bridge and native session IDs, explicit continuation admits it as a same-session
  handoff (`continuation.bridgeSessionHandoff`, only for the latest previous run). The
  adapter re-interrupts that session, waits for the old turn to settle within its own run
  timeout and delivers the message in the same session. When the successor finishes, a
  valid `resultJson.bridgeHandoff.proof` (`ccpocket.bridge-stop-reverification.v1`)
  acknowledges the predecessor through the same compare-and-set as re-verification
  (`proof: bridge_handoff_settled`). Without that proof the predecessor stays `requested`.
  Forced stops, missing session IDs, adapter mismatches and automatic recovery remain
  blocked, and nothing is replayed (`4dbb3aadf`). No schema change.
- Deferred sweep re-check (2026-11-09): stuck interrupt messages were only re-processed after an
  unrelated write, because the deferred receipt worker drops an entry after one resume pass and
  only reconstructs on startup or a committed notification (its 30-second interval throttles;
  it never polls). Interrupt receipts whose legacy run was cancelled now wait the same 30s
  `updatedAt` grace as the owner-only interrupt resume instead of being checked inside it; a
  receipt held by a cancelled `ccpocket_bridge` run whose unforced stop is still `requested`
  is re-checked on a 30s-doubling backoff capped at 10 minutes (that gate opens only on
  external Bridge evidence); and acknowledging a bridge stop notifies deferred receipts in the
  same transaction. All other closed gates stay notification-driven and idle-quiet. Nothing is
  replayed and no stop proof is synthesized (`4198469a5`). No schema change.
  Addendum (`6b300f0c2`): Drizzle renders column references in a select-field `sql` template
  unqualified, so the `interruptedLegacy` subquery bound its `id`/`company_id`/`agent_id` to
  `heartbeat_runs` itself and the flag was always false; the outer `agent_wakeup_requests` row is
  now named explicitly. The pending re-arm read runs only for receipts whose owner-only interrupt
  cancelled a legacy run, so ordinary saved backlog rows skip it; and the invalidated-backlog
  Retry test's `scheduled_retry` wait uses a 15s deadline (its first attempt joins worker passes
  settling the saved backlog, which the 1s default could not cover).
### 2026-11-11 — Cancel blocked runs

- Scheduled workspace waits expose Cancel run in the task header, composer monitor
  strip, scheduled retry card and run/activity views.
- Finish cancellation rechecks the exact original Bridge stop receipt. Confirmed,
  unforced stop evidence releases shared ownership only after all resource gates settle.
- Canonical behavior: doc/execution-semantics.md. Release uses michael/main and
  related checks only; no task replay or forced claim deletion.

