# execution-semantics

Moved from `AGENTS.md` on 2026-11-13 and rewritten the same day for liveness-first.
Binding source: `/home/michael/services/docs/agents/liveness-first.md` (Owner
2026-11-13); it wins over any conflicting rule here or in `doc/execution-semantics.md`.
Read this file before acting on run retry/cancel, stop, session authority or input.

The superseded fail-closed rules (stop proof and the 0/30/120/300s settlement
ladder as a gate, never-replay of unknown input/session/operation outcomes,
non-delivery proofs as admission conditions, session-authority/generation CAS,
`binding_reconciliation_required`, permanent `agent_run_superseded`, uncertain or
`needs_attention` handoffs, recovery budgets that return work to the Owner) must
not block, pause or refuse work. Historical runs, receipts and audit records are
kept unchanged; nothing here rewrites history.

## Unknown outcome: abandon and resend

- Unknown outcomes include an uncertain session start, a lost ack, an unconfirmed
  stop, a lost process, a Bridge restart and a server restart.
- Abandon the prior run (`abandoned_prior`), release every lock, claim, holder and
  slot, and resend. Resend in the original native session when it still exists,
  otherwise in a new session.
- Prefix the resent prompt with 「上一次可能已部分執行，先檢查現況再做」 so the agent
  inspects current state before repeating any mutation.
- On startup, runs left `running` by the previous process become `failed` /
  `process_lost` (transient). Shutdown interruptions use `server_shutdown_interrupted`.

## Terminal releases everything

A run in `succeeded`, `failed`, `cancelled` or `timed_out` releases every gate at
once: workspace, holders, slots, retirement and the next run. Native-stop
verification, stop evidence and cleanup receipts are collected best-effort in the
background and never block admission, dispatch, retirement or another run.
Owner Recheck may still inspect a cancelled run; it is diagnostic only.
Saved-message recovery follows the same rule: a terminal native source does not
need a committed finalization record. Preserve missing or failed finalization
evidence while the next authorized input passes normal admission.
A fresh task Retry retains its exact terminal source as `interruptedRunId` in
its continuation envelope, including a refused pre-dispatch admission. This
renders the inspect-existing-work / never-replay-tool-history notice in both fresh
and resumed prompts; the marker grants no preparation continuation authority.
After that Retry is queued, lift only its ancestry's system failure block, using
the existing status-version, human attribution and dependency checks. A human,
declared, dependency or newer block stays in place.
Preparation-only Retry can retain its saved directory after automatic retries
are exhausted. The host exhaustion event must match the run's failure class and
durable retry accounting; promotion must occur after the recorded due time.
Provider events, changed retry metadata and execution evidence still invalidate
that preparation-only certificate. Requested adapter strategy is distinct from
the realized directory; verify placement and preserved files.

## Failure classes

`server/src/services/recovery/failure-classification.ts` (`classifyRunFailure`)
is the single classifier for every retry and re-wake path (bounded retry, release
recovery, stranded-issue reconciliation).

- Transient: Bridge/host unavailable, `inactivity_timeout`, `session_busy`,
  `process_lost`, server shutdown, `abandoned_prior`, provider transients, lease
  lost, and every former ccpocket "uncertain" or gate code. Retry automatically with
  30s×2ⁿ backoff capped at 30 minutes, unlimited attempts; one deduplicated notice
  at the 5th consecutive failure.
- Deterministic: bad configuration a retry cannot fix. No automatic retry; one
  notice per (issue, code). Notices never block dispatch.
  This includes sandbox disk exhaustion (native_sandbox_disk_full and
  sandbox_disk_full) and permanently denied agent-interaction delivery
  (agent_interaction_delivery_denied), and Bridge model/provider configuration
  mismatch (`model_provider_mismatch`); all recovery paths use this same table.
  Explicit retry budgets and persisted transient metadata cannot override a
  deterministic code. Attributed system cancellation keeps its transient policy.
  Bridge model/provider mismatch is also a configuration choice in
  `continuation-cause.ts`; fresh-continuation JS and SQL reads must not treat it
  as system-owned work to resend.
- Unknown codes: retry 3 times as transient, then treat as deterministic.

An authorized Retry of a verified pre-dispatch cancellation uses that saved
non-delivery receipt; it does not wait for provider delivery evidence. If the
cancelled admission never owned the preserved workspace, retain a fresh attempt
and leave the original saved snapshot intact.

Shutdown and process-loss recovery keep the chain's persisted failure counter and
backoff; they do not implicitly open a separate upstream server-restart window.
Preparations interrupted by shutdown, process loss or controller loss before
provider work retain their own durable counter without a retry limit. An ordinary
bootstrap failure keeps its failure counter and provider retry deadline; proof
that provider work did not start does not turn a failure into an interruption.

Immediate release recovery obeys the same backoff. A per-host in-memory circuit
breaker (`server/src/services/host-circuit-breaker.ts`) defers wakes for an
unavailable host until its `openUntil` (30s doubling to 30 min); deferrals are not
failures, and one notice is allowed after an hour open.

## Inactivity

30 minutes without any new run event: the adapter interrupts and fails the run with
`inactivity_timeout` (transient). As a fallback the server cancels any run silent for
35 minutes, which also frees its PM slot. Output-silence watchdog signals are
informational and never create a decision the Owner must clear.

## Session authority

Resident Bridge session authority is server-owned and last-writer-wins. A claim
succeeds when the run is `running`, not cancel-requested and bound to the same
task; it writes generation+1, revokes the prior authority and records
`takeoverFrom`. The advisory lock waits (bounded statement timeout) rather than
failing busy. Legacy bindings without authority and deleted conversations get a new
binding instead of a refusal. A late finalizer or adapter JSON never grants
authority to a run that is not running.

## No system-imposed stops

The system never sets an agent pause, `needs_attention`, `uncertain`, "Owner
intervention required" or any state a human must clear. Owner pause, Stop and
cancellation still apply: a cancelled run is not resent automatically, and the GUI
cancels only the selected run.

## Input and comments

Issue-bound wakes use `wakeQueue.admitIssueWake` to lock the company-scoped issue
and persist admission plus saved-input receipts in one transaction. Heartbeat
keeps workspace/main request validation in that callback; `prepareRecovery`
provides busy/fresh admission after checking continuation ownership, including
saved Retry and queued-comment requests. The lightweight preflight preserves
conversation-requester ownership; a saved owner message does not authorize another
requester. Recovery deferral retains one-shot review, approval and changes handoffs
as durable receipts. Fresh admission preserves deferred durable Chat promotion
and reassignment input ownership. Notifications and dispatch follow commit; authorization
contention rolls back all writes and buffered effects. Native terminal failures
retain the fork failure scheduler and never restore automatic blocked recovery.

- New human or project-main input supersedes automatic retry of a failed
  predecessor. Fresh explicit comments keep their own input receipt and never merge
  into a retry/continuation envelope. Save comments and reopen under the issue lock.
- A board actor or the task project's main may supersede an issue-bound automatic
  retry with an explicit assignee/status change while it is `scheduled_retry` or
  `queued`. Cancel that retry with a status guard and release its execution lock
  before applying ordinary mutation checks. A retry already `running`, or an
  ordinary queued assignment, retains the existing ownership protection.
- Main Bridge agents execute with their own adapter and AI connection even when
  review handoff leaves worker selections on the task. Preserve those selections
  for subsequent worker reassignment; rejecting a confirmation keeps the current
  assignee and does not convert the worker configuration into main configuration.
- Worker output and interaction answers are not new execution intent.
- Ordinary agent comments keep their verified agent-author namespace; saved-user
  recovery remains human-only.
- Show the concrete cause of a failed run; only queued/running work, a scheduled
  retry or active recovery displays waiting.
- Notification hints project only company/run identifiers; never serialize caller
  DB handles or private payloads.

## Answer to an agent's own blocking question (HOM-424)

- An answered `wake_assignee` question continues the task its asking agent
  blocked to wait for it. Native agents prove the wait through the status
  decision's `awaitingInteractionIds`. Legacy adapters (ccpocket_bridge) prove it
  when the current blocked state, pinned by `statusVersion`, was set through the
  issue API by one of that agent's own runs after it asked the question.
- A person, or a main agent deciding on the person's behalf, may answer; the
  asking agent answering itself proves nothing.
- A later block by anyone else changes `statusVersion`; the answer then cancels
  as `issue_not_in_progress`, and checkout re-checks the same version.
  Implementation: `server/src/services/blocked-question-answer.ts`.

## LRH external waits (HOM-543)

`issue_external_waits` is the narrow exception to
`PAPERCLIP_AGENT_ISSUE_MONITORS=disabled`. It registers an external LRH run;
there is no timer, polling, monitor reschedule or check-now permission.
Agent monitor create/update/check-now still returns 403
`agent_issue_monitors_disabled`.

The current agent assignee (without a user assignee), or a board actor with issue
mutation access, may call these company-scoped endpoints:

- `POST /api/issues/:id/external-waits` with `{service, externalRef}` returns
  `{wait, created}`. Closed issues return 409 `external_wait_issue_closed`.
  Existing identities return their unchanged row with `created:false`.
- `POST /api/issues/:id/external-waits/complete` accepts the same identity plus
  optional `outcome` and `commentId`, returning `{wait, woke, reason?}`.
  A comment must belong to this issue. Completing without prior registration
  supports jobs armed before this release.
- `POST /api/issues/:id/external-waits/cancel` changes waiting to cancelled,
  returns `{wait}`, and never wakes. A missing identity returns 404.
- `GET /api/issues/:id/external-waits` lists rows with ordinary issue read access.

Only `service:"long-running-harness"` is accepted. `externalRef` is 1–128
characters matching `^[A-Za-z0-9._:-]+$`. Other agents receive 403
`external_wait_not_assignee`. Identity is unique by company/issue/service/ref.

Waiting counts as a durable disposition only on an open issue and for its
current assignee (or a board registration with null agent). Completion/cancellation
removes that path; old assignees cannot keep a reassigned task waiting.
Recovery, assigned-work and run-end handoff use the same SQL existence predicate.

Completion and its heartbeat receipt commit together under normal issue wake
admission. Only the first completion can wake: repeated completed/cancelled refs
return `woke:false, reason:"already_settled"`. Only `in_progress`/`in_review`
issues with an agent assignee and no user assignee wake; other statuses record
completion with `reason:"issue_<status>"`. The unique receipt key is
`external-wait-completed:<issueId>:<service>:<externalRef>`, reason
`external_wait_completed`. Payload and context retain `externalWait` and the
completion comment reference (`LRH_COMPLETION v1`). Busy execution retains a
separate deferred wake for promotion after the active turn. An admission failure
is surfaced and rolls back the completion, so it cannot consume a waiting target
without its wake receipt. No monitor columns change.

## Repository agent rules (HOM-777)

Moved verbatim from `AGENTS.md` on 2026-11-27. These rules remain binding;
read the matching topic before changing it. Repository policy precedence is unchanged.

### Due monitors

Due monitors and claimed wake_owner recovery can wake a waiting main Chat only through their persisted schedule
and claim guard. Named admission waits retain the monitor; unclassified null
admissions consume the existing attempt ledger and clear at three total attempts
or the smaller configured limit. Record static refusal reasons; preserve stale
wake rejection and the agent scheduling API switch. See doc/execution-semantics.md.

### Liveness-first classifier and retry ownership

Execution is liveness-first (Owner 2026-11-13). The binding source is
`/home/michael/services/docs/agents/liveness-first.md`; it supersedes every
fail-closed rule in this repository's docs (stop proof, settlement ladders,
never-replay of unknown input, session-authority CAS, workspace admission gates,
system-set pause/`needs_attention`/`uncertain`). Historical runs and receipts stay
unchanged. An unknown prior outcome abandons that run, releases every lock, claim,
holder and slot, and resends in the original native session if it still exists,
else a new one, prefixed 「上一次可能已部分執行，先檢查現況再做」. A terminal status
releases every gate; stop evidence is background best-effort. Failures are
transient (30s×2ⁿ backoff capped at 30 min, unlimited, one notice at the 5th
consecutive failure), deterministic (no auto retry, one notice per issue and code)
or unknown (3 transient retries, then deterministic). Bridge model_provider_mismatch
is deterministic. Board/project-main assignee or status changes supersede only
not-started automatic retries; running and ordinary queued ownership stay protected.
Main Bridge runs use their own adapter/AI settings despite retained task worker
selections. Shutdown/process-loss retries
retain the durable backoff counter instead of opening a fresh restart window; see
`server/src/services/recovery/failure-classification.ts`. Owner Stop/cancel and
manual pause still apply and revoke automatic retry. New human or project-main
input supersedes automatic retry of a failed predecessor and keeps its own input
receipt. See `docs/agents/execution-semantics.md`.
Sandbox disk exhaustion (native_sandbox_disk_full, sandbox_disk_full) and permanent
agent_interaction_delivery_denied are deterministic in the unified classifier.
Bootstrap non-delivery alone does not select interrupted-preparation retry accounting:
require system interruption, process loss or controller loss. Ordinary failures keep
their failure counter and provider retry deadline.

### LRH wake admission, preflight and Retry

LRH external waits settle with their one-shot heartbeat receipt under issue admission; see docs/agents/execution-semantics.md.
Issue wake admission belongs to wake-queue.admitIssueWake: retain the company-scoped
issue row lock and durable receipt writes in one transaction, run fork workspace/main
policy in its callback, and dispatch only after commit. Do not restore automatic
blocked recovery or transaction-scope compatibility shims. See
docs/agents/execution-semantics.md.
Lightweight preflight preserves conversation-requester ownership; prepareRecovery
checks saved Retry and queued-comment ownership before busy/fresh admission. Keep
one-shot execution review/approval/changes handoffs durable in recovery deferral.
Verified pre-dispatch cancellation receipts need no provider delivery evidence.
Keep a fresh attempt when that admission never owned the preserved workspace.
Fresh task Retry keeps its exact terminal source in interruptedRunId for the
inspect-existing-work prompt, without borrowing preparation continuation authority.
Only after queue admission may it lift its ancestry's system failure block;
preserve human, declared, dependency and newer blocks.

### Terminal-run saved input

Saved input behind a terminal native run must not wait for finalization to become
committed; retain the original evidence. See docs/agents/execution-semantics.md.

### Runner replay responsiveness

Runner replay must keep authenticated lease renewals and order-independent command
results responsive during slow event commits; bound the queue without pausing TCP ingress.
