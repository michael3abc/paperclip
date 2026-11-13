# workspace-git-admission

Moved verbatim from `FORK.md` on 2026-11-13. These rules and records stay binding; read this file before acting on the topic. Git workspace registration, shared worktree admission, fixed directories, placement

2026-11-13 exact linked-source inspection: an existing configured source can
point at the linked worktree being registered. Permit only read-only inspect to
reach its full Git identity checks in that case; preserve primary-checkout,
alias, foreign-root and mutation guards. Both local and serialized remote helpers
use the same code, and remote adoption still waits for host proof.

2026-11-13 host-recheck safety: preserve missing mutation receipts as unknown
outcomes, retaining the original pending operation rather than granting no-effect
status. Only original read-only inspect failures are intrinsically harmless.
This forward correction preserves dedaa412e history and prevents a delayed host
request or changed receipt root from authorizing another Git operation.
An in-flight started receipt likewise grants no release; explicit no-effect
failure requires the original terminal failed receipt.

2026-11-12 registered-workspace adapter boundary: heartbeat supplies authoritative
kind/sourceCwd along with lifecycle participation. The paired adapter admits
repository roots and nested registered paths for plain shared workers while
checking task project, host and canonical identity before sending input.
Existing valid v1 markers with absent kind emit linked_worktree at this server
boundary; their original metadata and generation remain intact.

- Registered-host finalization (2026-11-12): main-managed repository roots and
  linked trees use the owning host's Git inspector with run/cwd/branch/HEAD
  receipt checks. No remote path is resolved on the controller and no shared
  branch is automatically restored. Host failure stays explicit; old input is
  never replayed. Targeted tests use real Git and isolated PostgreSQL with mocked
  remote transport to verify host-routed finalization; live remote acceptance
  remains a separate release check.

- Git workspace registration (2026-11-12 follow-up): explicit repository roots
  and linked worktrees share the lifecycle API. Preserve complete canonical
  nested cwd, existing IDs, dirty/ignored files and .lmas. Explicit initialization
  changes Git metadata only, accepts unborn repositories, and keeps operation
  receipts/CAS/current-main authorization. Root retirement is metadata-only;
  linked-tree merge/deletion guards remain. Retained failed Retry receipts no
  longer imply background waiting or turn generic recovery into unknown delivery.

- Cooperative worktree selection (2026-11-12, feature): task creation, task card,
  properties and Chat defaults select a registered open linked Git worktree or
  explicit session-only resources. Cleanup admission is separate from original
  input authorization; merged user receipts are checked independently of old
  workspace recovery. Conflict/cancelled exports remain rescue-only, and ignored
  target files cannot be overwritten during main-managed merge.

- Historical physical ownership settlement (2026-11-11): exhausted finalizers
  retain their failures while independently stopped and cleaned workspaces may
  pass ownership. Unsettled retries/files/leases stay fenced. Inspect historical
  metadata roots without validating or repairing damaged Git sources; keep
  overlapping ownership and ordinary source-validation failures intact.

- Fixed main-agent review workspaces (2026-11-11): formal reviewers select their
  registered fixed home for the run while retaining the worker's explicit source
  and task workspace. Actual-path claims remain enforced on the reviewer home;
  unrelated/stale actors keep existing source-conflict failures.
  Acceptance fixtures separate role capacity from physical-directory ownership
  and preserve the stop-receipt requirement across worker review/revision reuse.

- Workspace recovery allowance and lower Task list identity (2026-11-11): new recovery actions
  pin three total repair admissions per original task, retaining uncertain receipts and historical
  limits. Chat handoff cards show task-owned invocation/usage identity or labelled pending settings;
  missing historical metadata stays unknown. No historical task replay or new polling.
- Physical workspace admission (2026-11-11): formal UI/MCP source selection and
  revision-bound pending changes, canonical host directory/worktree ownership,
  independent storage identities and provider launch binding validation. Preserve
  project defaults, admitted runs, stop/lease fences and cross-project conflicts.
  Pair with the CC Pocket adapter's remote directory validation; deploy only from
  michael/main through the existing related-check and readiness workflow.

Current change: admit configured non-Git document directories with exclusive physical-path ownership, including beneath an ancestor ignore-only `.git/info/exclude` directory; retain Git validation for real repository metadata, repository/ref and worktree operations.
### 2026-11-11 — Ignore-only workspace roots

- Physical admission recognizes exact .git/info/exclude-only roots as ordinary
  directories, including resident home directories. Preserve the ignore file.
- Empty, damaged or additional local metadata still requires Git validation;
  explicit Git requirements, canonical claims and overlap exclusion are unchanged.
- Deployed failure evidence and isolated regression checks are retained in
  artifacts/workspace-binding-admission-20261111; publish through michael/main.

Follow-up: failed/interrupted Bridge directory holders without Stop receipts join
the same bounded settlement flow. Preserve their errors and store verified stop
evidence separately; no cancellation or task replay is manufactured.

Cancelled parked workspace waits retain their original pre-dispatch trace and
are settled only after provider/resource absence is verified. Historical false
incidents remain in the audit trail without blocking new authorized input.
Interrupt delivery uses settlement notifications, with no independent polling
that could outlive the durable four-check budget.

Follow-up: project stop notification hints without caller objects; preserve native
result/review commits. Prove historical unstarted retry children from the original
scheduling event and wake, and accept restored successor transcript inputs only
with a matching native UUID and a real Bridge result.

Candidate HTTP/UI acceptance caught a hidden workspace-wait banner when the
event-driven wait had no deadline. Header and composer now retain the waiting
status and exact-run cancellation control with scheduledRetryAt=null. Preserve
the failed c3b8a423d candidate receipt alongside the corrective validation.

### 2026-11-12 — Shared-worktree rollback safety baseline

- Recognize protected main-managed metadata even when its schema is unknown.
- Exclude it from automatic terminal cleanup and compaction; generation-fenced
  destruction rechecks the marker under the registration lifecycle lock.
- Generic updates cannot erase management or archive/change managed coordinates.
- Marked execution fails explicitly until the feature release supplies cooperative
  admission. Stop evidence and historical failures are retained unchanged.

### 2026-11-12 — Fixed-directory Chat Retry

- Ordinary Retry retains the agent's configured fixed directory through normal
  admission instead of implicitly allocating an incompatible isolated directory.
- Explicit fresh isolation, stop/cleanup evidence, source/trust/environment checks
  and physical ownership keep their existing gates. No historical run is rewritten.
- Bridge main-agent rollout config must bind the same cwd on both platform and
  adapter sides. Historical selection repairs use the revision-checked API.

### 2026-11-12 — Shared-worktree admission and recovery

- Open, main-managed linked worktrees admit independent authorized participants.
  Cancellation releases admission immediately; Stop and cleanup remain truthful
  obligations. Main owns converge, merge, reopen and safe retirement.
- Retry and queued-comment admission validate original input and every author's
  durable receipt before coalescing or dispatch, independently of cleanup.
  Accepted results, delivery uncertainty, permissions and Owner holds remain gates.
- Cancelled exports are rescue-only. Recovery receipts and late Stop evidence
  remain eligible after successor admission; ordinary Retry retains its selected
  tree and read-only repository access checks. Blockers return to the original main.
- Warm reuse requires matching actual export and final-host digests. A merged
  host hash cannot certify remote contents or authorize deleting collaborator files.
- The original 120 recovery failures are classified in the private
  `artifacts/shared-worktree-20261112/recovery-failure-classification.json`.
  Follow-up validation selects affected cases with `-t`; do not rerun the entire
  recovery suite. This feature branch is not a production acceptance receipt.

Recovery notification follow-up (2026-11-12): busy original mains receive workspace
repair notices after completion without another system interruption. Durable
pre-admission rejection receipts distinguish a verified unsent notice from an
unknown delivery; Owner rechecks preserve the original identity and human gates.
An obsolete, never-sent system blocker question may be withdrawn only with the
exact acknowledged recovery interruption and Owner recheck. Withdrawal does not
authorize replay. Repairs select a same-project registered open linked worktree
or explicit session-only resources through the ordinary selection transaction.
The prior deployed check's 11 fixture failures remain in their original receipt;
focused replacements retain authority, cancellation and separate-lease assertions.

### 2026-11-12 — Rule-based placement for CC Pocket session directories

- A CC Pocket agent with an adapter session cwd must register the same directory
  as its fixed runtimeConfig.workspaceBinding; agent create/PATCH reject a missing
  or different binding (422 `workspace_binding_required`). Startup only logs
  inconsistent agents; it never repairs them.
- Ordinary Retry decides the fixed placement before reusing a failed preparation's
  task directory. An unbound session cwd fails before allocation with
  `fixed_workspace_placement_required` instead of an implicit fresh isolated
  directory the adapter would reject. Other agents keep the existing fallback.
- The fixed-directory policy rejects only strategies that would apply. A project's
  unused worker worktree default no longer blocks a main agent's shared fixed run;
  explicit task, environment, storage-provider and merged strategies still do.

### 2026-11-13 — Explicit external-resource worker session admission

- Preserve explicit session_only from task creation through provider preparation;
  requireProjectWorkspace no longer contradicts external-resource dispatch.
- Use session cwd without adopting/provisioning project Git, remote storage or
  a workspace claim; require persisted intent and preserve strict worktree and
  native recovery restrictions. Remote hosts require a configured session cwd.
- Creator guidance includes repository roots and unborn repositories. Validation
  covers HTTP persistence, actual heartbeat/provider execution and negative gates.

- Company model picker: scoped adapter discovery/schema context, company-bound
  Bridge hosts, native model order and short names with source badges. Release
  with the paired CC Pocket adapter company-model-picker change; no DB migration.
