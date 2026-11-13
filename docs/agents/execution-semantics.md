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
- Unknown codes: retry 3 times as transient, then treat as deterministic.

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

- New human or project-main input supersedes automatic retry of a failed
  predecessor. Fresh explicit comments keep their own input receipt and never merge
  into a retry/continuation envelope. Save comments and reopen under the issue lock.
- Worker output and interaction answers are not new execution intent.
- Ordinary agent comments keep their verified agent-author namespace; saved-user
  recovery remains human-only.
- Show the concrete cause of a failed run; only queued/running work, a scheduled
  retry or active recovery displays waiting.
- Notification hints project only company/run identifiers; never serialize caller
  DB handles or private payloads.
