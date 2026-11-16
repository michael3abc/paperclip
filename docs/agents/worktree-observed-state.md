# worktree-observed-state

Decision record, Owner 2026-11-16 (「好，做 2」). Applies to the main-managed
worktree API (`server/src/services/main-managed-worktrees.ts`) and its host script
(`packages/adapter-utils/src/managed-worktree-host.ts`, run locally or over the
ccpocket adapter's SSH transport). Binding policy:
`/home/michael/services/docs/agents/liveness-first.md`.

## Problem

The server trusted only a host receipt. A host failure before the receipt existed
(a missing parent directory on Shopee-D, op `cbdd1528`) left a permanent
`pendingOperationId`, every later operation failed
`worktree_operation_reconciliation_required`, and host errors surfaced as HTTP 500.
Retire never worked on a real host (`/proc` entries of non-dumpable same-uid
processes are unreadable), merge failed on Git output over 8 MiB, and SSH/tar
stopped at 30 s.

## Decision

- **Git is the truth.** Every action reads `git worktree list --porcelain`, the
  branch, HEAD, refs and dirty status, then decides "already done", "do it" or
  "conflict", and verifies the result from Git. The same input twice is safe.
  Results carry `outcome: applied | already_done | observed`.
- **Receipts are audit only.** Host receipts (`<receiptRoot>/<operationId>/receipt.json`,
  with an attempt counter) and `workspace_operations` rows are written for history
  and never read to decide or block anything. A missing receipt proves nothing.
- **create:** a linked worktree of this repository on this branch at the path is
  already done. Otherwise the missing parent is made with `mkdir -p` one component
  at a time below an existing real directory (a symlinked component is refused),
  then `git worktree add`. A branch left by an interrupted add is reused when it
  contains the requested start commit and is not checked out elsewhere. A
  non-empty foreign directory, another branch at the path, or Git's own
  half-initialized tree (`locked initializing`) is a conflict, never repaired.
- **merge:** already done when the tree's HEAD is in the target branch. Otherwise
  the expected candidate/target heads must match (stale views get 409), the merge
  commit is built in a private detached tree that is removed (non-force) afterwards,
  and the target moves by `merge --ff-only` or a compare-and-swap `update-ref`.
  Git output is never capped (`maxBuffer: Infinity`, quiet flags, untracked
  directories collapsed with `ls-files --directory`).
- **retire:** already done when no tree is registered at the path and the path is
  gone (a plain directory there is refused, never deleted). Otherwise it requires
  the branch merged by refs, a clean tree and no lock; only a readable process whose
  cwd or open fd is inside the tree blocks (unreadable processes are skipped); all
  files except Git metadata, including ignored ones, are archived owner-only
  (0600 in a 0700 directory outside every repository; earlier archives are never
  overwritten) and compared; then non-force `git worktree remove`. Repository-root
  retirement still only unregisters metadata.
- **initialize:** already done when the directory is this repository root on this
  branch; other existing Git metadata is never overwritten.
- **Server:** `expectedGeneration` is recorded, never refused (the lifecycle lock
  serializes operations). A non-participant operation supersedes an earlier
  pending one (its row is marked `superseded_by_operation:<id>` and kept). The same
  `operationId` after a failure runs again against Git and reuses its row
  (`attempts`, `earlierFailures`). Create/register/initialize of the same
  coordinates re-verifies and keeps phase and participants. Merge and retire no
  longer require a stored phase; converge and reopen are idempotent; reopen and
  `GET .../worktrees/:id` (`observed`) re-read Git.
- **Unknown vs definite:** a host refusal clears the pending marker (409 with the
  host code and a bounded `detail`). A reply that cannot tell what Git shows
  (`host_unavailable` 503, `worktree_host_timeout`, an invalid or mismatched reply)
  keeps the operation pending so `recheck` can settle it from Git; recheck of any
  other operation returns its recorded state without host I/O. A contended
  workspace lock answers 409 `worktree_operation_in_progress` (retry).
- **Timeouts:** host git and tar passes 10 minutes each; the adapter's worktree SSH
  call 30 minutes (other SSH calls keep 30 s).
- **No schema change, no migration.** Existing columns stay and stop gating. The
  stuck Shopee row clears itself: the next operation supersedes it, or a recheck
  finds the tree the main created with Git and completes it.

## Safety that stays

Never delete a directory with dirty or ignored files (ignored files are archived
before non-force removal; dirty trees are refused), never force-remove a worktree,
never switch/reset a shared checkout, never overwrite target files a merge would
touch, authorization and Owner holds unchanged, branches are never deleted.

## Compatibility

The result schema stays `paperclip.managed-worktree-host.v1` (`outcome` is an
optional addition). The ccpocket adapter imports the host script from its paired
server's `@paperclipai/adapter-utils`, so deploy the server and adapter together;
the adapter's transport changes (timeouts, error codes) also work with the
previous peer.
