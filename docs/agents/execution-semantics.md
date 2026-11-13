# execution-semantics

Moved verbatim from `AGENTS.md` on 2026-11-13. These rules and records stay binding; read this file before acting on the topic. Run retry/cancel/stop settlement, session authority, non-delivery and input-receipt rules

Adapter non-delivery survives independent workspace finalizer failures. Persist
its original error/provenance before finalization; admit a new authorized Bridge
message only with the server-held non-delivery fact and no contradictory session,
input, provider or process evidence. Missing PID alone grants nothing. Preserve
the saved wake and original failed run; never replay it or synthesize a stop.

Resident Bridge session authority is server-owned. Use the awaited heartbeat
callback before saving host ownership or sending input. Never grant authority from
`lastRunId`, a terminal status, adapter-returned JSON or a late finalizer. Preserve
`adapterSessionAuthority` during task-session publication; stale publishers are
suppressed. Business mutations use the current receipt as well as cancellation
and existing scope checks. Native-session identity can span task rows; supersede
all matching rows in the same transaction. See `doc/execution-semantics.md`.
Missing legacy task-session indexes may be reconstructed only by the admitted
server claim from the host's exact current-run pointer and matching original
invocation/result receipts. Never reenroll a deleted feature-era authority.
After maintenance replaces a bootstrap Bridge card, attach its already-published
native identity only with the current server authority, original accepted-input
and invocation receipts, and the unchanged predecessor/generation CAS. A late
finalizer, restored card ID alone or missing/deleted binding grants no authority.

- Local legacy completion persists a host/process-generation-bound stop event even
  without an instruction copy. Both PID and group must be absent; newer launch/resume
  invalidates it. Keep file, controller, finalizer and lease fences and event-only wakes.
- Stop settlement uses the original run and server-owned JSON receipt. Persist claims
  before read-only verification; use four completion-relative checks (0/30/120/300s),
  preserving budget across restart. Terminal Recheck never sends Stop or input.
  Provider stop and file/finalizer/lease cleanup are independent; stale launch
  evidence cannot certify cleanup or retirement. Workspace waits park the same run until a
  holder event, then recheck existing admission authority. Preserve historical
  failures and holds. See `doc/execution-semantics.md`.
  Header and composer workspace-wait surfaces must remain visible and cancellable
  when scheduledRetryAt is null; event-driven admission has no retry deadline.
  Include failed/interrupted Bridge holders without cancellation receipts. Store
  verified termination separately; never fabricate a Stop request or change their outcome.
  A cancelled parked workspace wait is pre-dispatch only when its original gate
  trace and retained resources prove no provider or checkout was admitted. Keep
  its recovery history; conflicting identities/events remain blocked. Deferred
  interrupt queues must not add polling beside the persisted stop-check budget.
  Historical unstarted retry children require exact parent-event/wake bindings.
  Prepared disposition repairs suppressed before dispatch require the original
  source/episode, skipped wake, admission, cleanup-intent and undispatched accounting
  receipts together, without provider identity/events. Only released local leases
  qualify; collect retained local files through the existing CAS collector. Recheck
  this proof before collection and directory admission; keep failure history and holds.
  Bridge cleanup may reuse an Owner-recorded remote host reboot only when the
  original invocation host, exact finish boundary and latest execution still match.
  Released local preparation leases and normal file CAS remain required; preserve
  reboot provenance without inventing cancellation ACKs or replaying failed work.
  Notification hints project only company/run identifiers, never serialize
  caller DB handles or private payloads. Restored successor transcript inputs
  need the original native UUID and a real result, with provenance retained.
Run cancellation remains available during scheduled workspace waits, including the
current task header and composer monitor surfaces. The GUI cancels
only the selected run and verifies its stop receipt. A cancelled Bridge run with a
requested stop offers 重新檢查, which rechecks the original receipt without
replaying input or stopping a successor. Cancellation immediately leaves workspace
admission. Stop, controller, finalizer and lease receipts remain cleanup and
retirement obligations; unknown input or session ownership stays explicitly scoped.

The task card, properties and Chat defaults share this contract; historical source
selections remain readable, not available as new choices. Input receipt validation
is independent of Retry presentation: retained failed receipts are not background
progress. Only queued/running work, valid preparation/deadline or active recovery
may display waiting. Show the concrete cause otherwise; delivery_unknown and
decision_pending do not offer Retry. Generic execution_reconciliation_required
is not proof of unknown delivery. Input receipt validation
is independent of cleanup admission: never drop continuation authorization or
skip merged-user receipt checks merely because getExecutionBlocker returns null.
Ordinary agent comments retain their verified agent-author/receipt namespace;
saved-user recovery remains human-only. Case handoffs also require their ledger.
System-owned wakes require their exact protected receipt at claim: bounded
explicit retries renew the original human authorization for that successor,
and main/recovery notices revalidate their source and original conversation.
Neither lane may append other comments or inherit a generic system exemption.
Task Retry and deferred-input admission must validate before queue/coalescing
shortcuts as well as before dispatch. A cleanup-only recovery action cannot prove
non-delivery: retain provider event, preparation settlement, source snapshot and
principal checks. Single and merged comments each require original receipts;
adopted Retry receipts without comments are not a comment batch. A new queued
input must have no prior execution evidence. Keep saved-file continuation
receipts even when cleanup no longer blocks admission.
