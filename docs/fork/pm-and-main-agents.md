# pm-and-main-agents

Moved verbatim from `FORK.md` on 2026-11-13. These rules and records stay binding; read this file before acting on the topic. PM and main-agent features: follow-through, instructions, workers, dispatch, permissions

2026-11-13 new-worker dispatch correction: the main/PM dispatch guard shares the
registered Git directory/session-only contract with task creation. Resolve explicit
selections or the project default without requiring legacy configured_source or
single-writer serialization. HTTP and Runner creation preserve the normalized
selection, current worker grants and project/source/host boundaries. Historical
restoration acceptance did not cover this new-task entry point; retain that gap
and the original Comfyui dispatch failures rather than treating them as successes.

Earlier permission repair: audited PM project reads, formal decision routing and execution-review API boundaries.
Earlier dispatch repair: live schema, readiness/session diagnostics and pre-creation workspace admission.
Acceptance follow-up: scoped saved-response asset reads and preservation of task worktree bindings during PM review.
PM autonomy follow-up: native assigned-review decisions, independent Owner-scoped project PM authority, exclusive development checkouts with queued writers, commit-pinned reads and safe worktree reclamation; workspace maintenance preserves review state.

- Native review recovery binds the current server-owned pending stage for recovery/Owner wakes that lack the original stage envelope; preserves status, run and reviewer checks.

- Cached PM review homes skip configured sibling repository synchronization; worker repository publication keeps its existing binding checks.

- PM permission audit follow-up: own-project comments, sessions/run diagnostics and
  captured worker output; Owner-authorized .env/source/task-workspace reads with
  nested-project isolation; formal delegated approval HTTP routing; execution-review
  generic mutation denial. Preserve shared-worker management and human gates.

### PM follow-through repair (2026-11-07)

The michael/pm-task-followthrough change adds durable five-minute PM tracking,
versioned continuation receipts, verified coordination-child authority, retained
non-Git Recovery reuse and runtime-specific worker delivery guidance. Release from
michael/main only, with additive migrations 0437/0438 and scoped related-test receipts.
Enable tracking after readiness for the five current PMs and register only explicitly
selected historical tasks. Keep completed/cancelled work and the prior release.

HOM-240 acceptance exposed a second preparation path: project-bound Recovery
copies resolved as task_session were validated against the current git_worktree
default before their saved project_primary restoration. Base validation now follows
the same persisted strategy as restoration, retaining drift diagnostics and current
admission/ownership checks. Assembled heartbeat regression preserves the original
delivery and workspace through provider execution; negative cases cover foreign
ownership, missing directories and Git-required workers. Scope is limited to
project-bound copies with matching ownership and the copy-only receipt; source-free
Retry retains its existing explicit Git, path and recovery validation. No migration is added.

HOM-236 acceptance exposed saved-review finalization after shutdown failure released
its execution lock. Finalizer-only recovery rechecks original failure/accepted-result
receipts, review scope, process stop, leases, pauses and successor absence under
transaction locks. Live tools retain strict execution-lock authority; formal review
effects and dependency wakes remain atomic and idempotent. No migration is added.

Postdeployment continuation exposed two further faults: active non-Git Recovery
anchors lost their local-path contract at Claude/Codex launch, and company-wide
watchdog updates under producer locks deadlocked native finalization. Retain the
verified anchor contract and append independent events in migration 0439; the
existing scheduler consumes them atomically with bounded, ordered watchdog updates.
Preserve original failed runs, pending finalizations and the original business tasks.

The ten-file related check found a stale recovery timing fixture: it rejected the
new event INSERT and lacked the locked-select chain, leaving synthetic retry debt.
Use real Drizzle query composition with explicit event/legacy-row execution doubles;
preserve idle/deadline invariants and the PostgreSQL event-consumption coverage.
Assert the watchdog's one-second event coalescing separately from other recovery
scopes' thirty-second reconstruction, without moving the existing lease deadline.
Keep the failed qualification receipt alongside the corrected scoped rerun.

The next scoped run exposed a separate timing assumption in the PostgreSQL
deadline test: pumping I/O advanced its fake clock before a fixed 298-second
jump. A controlled startup delay reproduces the early-call assertion failure.
Use the persisted absolute deadline across restart, retain drain/resume checks,
and verify both query and transaction silence after terminal settlement.

The stronger startup assertion then exposed cross-case work-signal state: a
deliberately rolled-back producer left uncertainty on the suite's shared client,
although its rows had been truncated. A two-case reproduction confirms the leak.
Give each test a fresh client owner and close it after joined cleanup; preserve
the production transaction-reconciliation path and the exact startup deadline.

HOM-240's next live continuation exposed a PM/worker preparation race: creating
the watchdog's PM home marked its borrowed active worker directory idle between
environment selection and binding validation. PM coordination no longer retires
that row. Preserve the original task, workspace and stop evidence; regressions
cover unchanged worker metadata and an assembled Claude continuation with PM
preparation interleaved before the canonical Recovery-directory recheck.

### Explicit PM source ownership (2026-11-08)

HOM-249 exposed an explicitly authorized source registered at the same physical
root by two projects. Permit that exact-root sharing within the company only
when the PM selects its own projectWorkspaceId; retain foreign nested roots,
cross-company registrations, issue privacy and inode/symlink checks. Definite
bridge read denials return a bounded scope error rather than a generic failure.
Keep worker write ownership and task recovery separate from read authorization.

### Per-PM compact instructions (2026-11-08)

`f3eb006cf6` adds Owner-selected `pmInstructionLayout=compact-v1`: AGENTS.md and
PROJECT.md are required per run, while MEMORY.md is optional. Tool schemas,
file permissions, read receipts, worker policy projection and session compatibility
follow that per-agent setting; unselected PMs keep the existing split layout.
The worker-policy API reports its actual documentPath and protects its generated
table. No model, connection, approval grant, service or database schema changes.
Switch michael only after external backups and idle/collection checks, using
native file/configuration CAS. Preserve history and never replay old work.
The layout-transition regression normalizes stored policy through the same schema
as the worker-policy API before rendering its target document.

### Main agent workers (2026-11-08)

Feature branch michael/main-agent-workers lets a ccpocket_bridge main agent
(`role: main` with a project UUID) dispatch the Owner-configured shared workers.
The Owner saves the same v2 worker policy through `PUT /agents/:id/worker-policy`;
for main agents it renders as the `main-v1` "Worker 選用" table with option IDs in
PROJECT.md, between the managed worker-policy markers, which agent-side bundle
writes cannot change. A main agent's `POST /companies/:id/issues` that names a
worker option or a policy worker is checked like a PM dispatch: same project,
workspace selection, option expansion into worker/model overrides, and a review
stage back to the main agent. The original configured-source/single-writer gate
is superseded by the 2026-11-13 cooperative dispatch correction above. Other
issue creation by the main agent is unchanged. Without a saved policy nothing
changes. The main agent is not a zero-slot PM and gains no PM decision authority.
Commit `f92bdcc5b`. Released as a backend release (no schema change) after
related tests and a candidate smoke; b6ae191596-r1 is kept for rollback.

- Remote Bridge shared workers (Shopee, 2026-11-10): a plain shared `ccpocket_bridge`
  worker whose `hostId` is another CC Pocket host runs in the project's `remote_managed`
  source registered on that host (`metadata.hostId`). Its shared-checkout claim keys on
  `ccpocket:<host>` plus the canonical registered path; the controller skips local
  filesystem, service, process and Git-dirty checks it cannot see, while writers on the
  same remote source still queue. Worker policies and the worker catalog accept such a
  worker only for projects with a source on the same host. No schema change.
- Antigravity shared worker (2026-11-09): worker policies admit a third harness, `ccpocket_bridge`,
  only for a plain CC Pocket Antigravity shared worker (provider `antigravity`, no main role,
  project_pm binding or Bridge worker preset). Its catalog lists the host's Antigravity models,
  rejects AI connections and offers Default or explicit Full access; dispatch, diagnostics and save
  re-checks fail an agent that stops being eligible. Policies hold up to three workers
  (`64a101064`). No schema change.
- Remote-host main agents (2026-11-10, Shopee): a fixed workspace binding may name a `hostId`
  for a CC Pocket main agent on a non-shared host (`60ceedfb9`). The run keeps the Local
  execution environment and never stats the remote cwd on the controller (its local cwd is the
  agent home); the binding requires a `remote_managed` project workspace with the same canonical
  path, the local driver, and a `ccpocket_bridge` adapter whose `adapterConfig.hostId` matches.
  Agents without `hostId` are unchanged. No schema change.

### 2026-11-11 — Main-agent worker secret delegation

- A current project main agent can grant/revoke an already accessible secret to
  its configured worker on its own assigned task without another human approval.
- Existing bindings store task/worker-scoped API-only references and pinned
  versions; source, policy and ownership checks remove access when authority changes.
- No migration, secret copying, task wake/replay or global worker configuration.
  Canonical contract: doc/DEVELOPING.md and skills/paperclip/references/api-reference.md.

