# workspace-admission

Moved verbatim from `AGENTS.md` on 2026-11-13. These rules and records stay binding; read this file before acting on the topic. Shared/registered Git worktree admission, registration, lifecycle, finalizers and retirement details

Managed workspace participation rebuilds kind/sourceCwd from the current stored
registration after lifecycle admission; wake JSON cannot supply those fields.
Valid v1 registrations that omit kind retain linked-worktree semantics: normalize
only the authoritative adapter output; never rewrite stored markers to pass a guard.
Bridge adapters verify plain worker task projects and accept canonical roots or
nested approved paths. Ship the matching adapter with this boundary change.

Registered main-managed Git directories finalize through their registered host's
read-only inspector, including repository roots. Verify receipt/run identity,
branch and commit evidence; never fall back to controller paths or auto-repair
a collaborator's branch. See `doc/execution-semantics.md`.
An explicitly configured source may itself be the selected linked worktree.
Read-only inspect accepts that exact canonical path only after the existing Git
admin-file/common-directory/worktree-list/branch checks. It does not relabel a
primary checkout or authorize create/merge/retire against the source itself.
Missing host-operation receipts do not prove no effect. Recheck must keep
initialize/create/merge/retire pending until their original outcome is known;
only the original read-only inspect action can release its no-effect failure.
A delayed host request or changed receipt storage cannot authorize resubmission.
An existing started receipt also remains unknown; no-effect proof requires the
original terminal failed receipt with effectStarted=false.

Shared-worktree rollout safety baseline (Owner 2026-11-12): metadata key
`mainManagedWorktree` is server-owned, including unknown versions. Legacy
terminal/idle retention, compaction, rehome, branch repair and archive must never
modify or destroy a marked tree. Recheck its marker under the existing workspace
lifecycle lock; a candidate snapshot is not authority. Generic PATCH preserves
this marker and lifecycle generation and cannot alter its coordinates or phase.
This baseline rejects execution on marked trees as `shared_worktree_unsupported`;
only the subsequent feature release may admit cooperative participants. It does
not synthesize stop evidence or settle outstanding cleanup. See
`doc/execution-semantics.md` for the staged contract.

Shared workers select a main-registered Git repository root or linked worktree for code work.
New main/PM worker dispatch uses the same cooperative selection contract as task
creation: explicit registered `existing`, explicit `session_only` for external
resources, or the project's current default. Never require `configured_source`
or inject `sharedWorkspaceConcurrency=serialize` at the dispatch policy boundary.
Normalize the selection into the actual HTTP/Runner create input and revalidate
inside the creation transaction. Preserve worker-policy/document consistency,
same-project access, source/registered-host provenance and production-source gates.
Multiple tasks/runs may join an open tree; canonical paths, aliases and parent/child overlap
are not exclusive writer locks. Session cwd and external data/model/service paths
remain separate and are never initialized as Git for dispatch. New tasks require an
explicit worktree or the project's open default; external-resource tasks may select
sessionOnly. Main chooses reuse/create, converge, merge, reopen and retire through
the generation/operation-receipt API. Missing configuration fails before dispatch.
Explicit registration may adopt a legacy remote `project_primary` row incorrectly
labelled `local_fs` only through its unchanged registered remote source and a
successful owning-host Git inspection. Preserve the workspace ID, cwd, source/task
history and files; normalize provider metadata only after the receipt commits.
Revalidate coordinates, host and active runs; failed inspection cannot open the
tree or be bypassed through reopen. This is a registration operation, not fallback.
Read-only source tools share files; fixed-version reads never switch branch. Keep
production sources, Owner holds, permissions and genuine provider capacity intact.

Ordinary Retry for a configured fixed directory retains that placement through
normal admission; do not replace it with an implicit isolated directory. Explicit
fresh attempts remain explicit and may conflict with fixed policy. Placement
selection never proves stop or cleanup or bypasses task, input or native-session
authority. A shared tree has no exclusive physical writer claim. Bridge main-agent
configuration records the same session cwd in adapter settings and
runtimeConfig.workspaceBinding; a selected linked execution tree is separate.

Workspace selection uses existing registered open trees or explicit session_only.
Registration records repository_root or linked_worktree kind and full canonical
cwd, including existing nested task directories. Source/project/host scope,
generation CAS and operation receipts remain mandatory. Explicit initialize
creates only Git metadata (no add/commit/remote); unborn roots may execute. Keep
existing local `git_repo` source IDs/types: a canonical cwd with no remote
provider/ref and absent or exact-local host identity uses the local Git verifier.
Foreign or unknown host identities never fall through to local execution. Keep
dirty/ignored files and .lmas. Root retirement is metadata-only, never directory
removal or linked-tree merge. Never infer initialization authority from dispatch.
An admitted successor does not retire the predecessor's cleanup eligibility or
pending Stop-evidence notification. Cancelled exports remain rescue-only even
while a successor uses the tree. Ordinary Retry retains the selected managed
tree; skipping provisioning must retain read-only repository access validation.
Ignored target files are included in merge overlap checks before any shared effect.
Warm sandbox adoption requires the actual exported source digest to equal the
final host digest. A merged host may contain collaborator-only files; its hash
alone never certifies the remote baseline. Missing or partial export proof makes
a new turn seed the current host; same-run recovery retains its original baseline.

Explicit session-only worker work retains its persisted task selection and uses
only the worker session cwd, without Git/source provisioning or workspace claims.
Require the stored selection and matching settings; wake JSON cannot waive
requireProjectWorkspace. Keep strict requireTaskWorktree and native recovery
bindings intact. Remote session-only work needs the worker's configured host cwd.
See doc/execution-semantics.md.

Company-scoped adapter catalogs declare catalogScope=company. Model discovery and
config-schema requests require authorized companyId plus the unsaved host/provider
selection. Never serve these from global schema caches or declared fallback lists.
Keep qualified model IDs in persistence; names and source badges are display only.
Bridge host companyIds live in the external host registry. See doc/DEVELOPING.md.
Bind manual refresh feedback to the exact selection/request and reject forbidden
schema hosts before probing; never substitute another host on an invalid query.
