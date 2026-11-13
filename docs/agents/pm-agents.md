# pm-agents

Moved verbatim from `AGENTS.md` on 2026-11-13. These rules and records stay binding; read this file before acting on the topic. Zero-slot PM policy, bundle layout, dispatch, read scope, worker policy, watchdog, homes

Keep PM worker-policy and project execution-record OpenAPI operations aligned
with mounted routes, shared policy validators and existing access controls.
Zero-slot project PMs use the server-owned coordination capability policy in every
chat, task and review run. The qualified local Claude ACP and isolated Codex
Runner paths enforce it; reject unsupported runtimes or stale unrestricted sessions.
Claude uses Read/Grep/Glob for instruction bundles plus PreToolUse; project files
use the server-owned read_project_file/search_project_files tools. Codex uses a read-only profile, disabled
shell/host tools and an exact-catalog PreToolUse guard. Admit only that generated
hook's exact hash in its disposable runtime home and confirm trust before a thread
opens/resumes; never disable hook trust or trust host/project/plugin hooks. Codex
PMs use `codex-pm-v1`; ordinary workers retain their existing provider profile. The Paperclip
bridge and authenticated HTTP API must both enforce company/project/run scope;
connector names or read-only annotations are never grants. Keep the Owner-owned
`runtimeConfig.pmDelegation` model/worker table separate from editable Markdown.
Owner-selected `runtimeConfig.pmInstructionLayout=compact-v1` uses only
`AGENTS.md`, `PROJECT.md` and `MEMORY.md`. Require the first two each run;
memory is read as needed. Tool schemas, HTTP authorization, working-copy saves,
dispatch diagnostics and runtime prompts must use the selected layout. Keep
the protected worker table in `PROJECT.md` as a compact projection; full IDs,
connections and grants remain in the saved policy. Worker settings return
`documentPath` and compare that file's hash. Agents cannot change the layout or
managed table. Unselected PMs retain their existing layout and sessions.
PM dispatch selects a stable worker option ID or its unique default and persists plan,
source, workspace and review before waking that worker. Preserve source Owner gates.
Keep these dispatch fields in the live `protocol-actions/create-task.ts` schema
as well as the documentation catalog. Test the exported provider catalog; a field
present only in the documentation catalog is rejected before server authorization.
New code dispatch requires the project's registered open Git execution workspace.
Shared participants retain independent task/session authority and per-run copies.
Cancelled runs leave admission immediately; provider stop and cleanup receipts
remain truthful and govern only cleanup/reuse of their own resources and retirement.
Main controls worktree lifecycle; terminal/idle reapers never delete managed trees.
PM
`list_agents.dispatchReadiness` reports current policy/document/selection metadata;
it is not provider acceptance. PMs may read their own project's tasks, recent/single comments, document revisions,
sessions, diagnostics and issue-bound run metadata/events/logs. Preserve company,
project, issue privacy, responsible-user and existing response-redaction checks.
Every PM API/tool request must retain its current run and task execution lock.
Project file reads include dotfiles, .env, credential files and Git configuration;
never copy credential values into reports, comments or repository changes. Select
one projectWorkspaceId or executionWorkspaceId to read a configured source or task
checkout. An explicitly selected same-project source may share its exact canonical
root with another project in the same company; a broad workerRoot is not that grant.
Cross-company registrations and foreign nested roots remain denied. Settle denied
bridge reads with safe scope guidance, never private host paths or credentials.
Deny foreign registered projects nested beneath a broad project root,
including symlink aliases and commit reads; native provider reads cover only the
instruction bundle so they cannot bypass current ownership checks. Shared-worker
management configuration stays hidden. Captured responses and registered attachments
are readable for the same project, including another task/worker's output; unbound
assets and foreign project captures remain denied. PM
review homes are run-scoped and must never replace a worker task workspace binding.
Fixed project main agents also retain their registered home during a currently
assigned formal review. Resolve that home on the configured host without a
recursive path claim, and preserve the worker's selection, workspace row and
binding revision.
Non-review execution and stale/foreign review participants keep the fixed-source
conflict guard; never infer reviewer authority from wake context alone.
Workspace-only issue PATCHes preserve status, assignment and pending review state;
maintenance cannot normalize a blocked task into review or wake its reviewer.
Use `read_bundle_file` receipts and `write_bundle_file` CAS saves for PM support
files; protect AGENTS.md and synchronize the registered run baseline on every save.
PM Agent settings own `pmDelegation` version 2: one default and explicit harness,
model, thinking, permission and speed selections, plus optional `purpose` guidance.
Purpose is at most 500 characters and never changes adapter settings or authority.
The settings preview follows the current form as JSON; keep migration/history
diagnostics out of the form header and retain explicit save errors. Use GET/PUT
`/agents/:id/worker-policy` with `baseRevision` and the WORKERS.md `baseHash`;
only this authorized save may change the policy and its managed JSON block inside
WORKERS.md. Preserve the file name and handwritten rules; escape marker delimiters
in JSON strings so purposes cannot corrupt the managed block.
Preserve handwritten content and existing task snapshots. Failed or conflicting
saves never count as success; document/config drift blocks new dispatch. Legacy
worker lists remain historical and require explicit migration, never fallback.
Do not widen PM, provider or workspace authority via a selection. Project Sessions
join native runs through their recorded issue/project; Artifacts use registered
issue documents, attachments and artifact work products, never path scanning.
Retain separately labelled CC Pocket history and distinguish source errors from
empty results. New UI settings do not activate agents or deploy changes.
PM Retry may reuse its task-owned home only after a settled pre-provider setup failure and an unchanged zero-slot PM binding. Never reinterpret an explicit fresh-workspace request or relax worker isolation; preserve original failed runs and recheck trust and environment restrictions during preparation.
PM worker options may pin an existing explicit AI connection alongside their model.
Worker catalogs use that connection's routed models, not a global official-provider
catalog. Only connections already installed for the worker and available to the
editing Owner may be selected. Saves validate sharing without reading credentials;
new tasks persist the selected binding with their adapter overrides and normal
managed-AI preparation rechecks the actual responsible user's access. The PM review
must not inherit worker overrides. No connection, grant, secret, or shared worker
configuration is created or changed by a worker-policy save. Keep the managed JSON
projection and unique default consistent, retain old task settings and reject
unavailable connections/models explicitly. Model choices show their connection;
identical model IDs on different accounts remain distinct choices.

PM coordination homes must skip both task repository admission and configured
sibling-repository synchronization, including reuse of a cached PM workspace.
Keep the original worker task binding; do not weaken repository publication checks.
Preparing a PM home must not retire or update a borrowed worker workspace. Its
active status and metadata remain unchanged while the worker admits or executes.
Exercise coordination preparation between worker environment selection and the
saved-directory recheck; a sequential helper-only test cannot prove this boundary.

Managed PM follow-through uses one original-task watchdog with taskTracking enabled,
intervalSec=300 and maxRecoveryAttempts=2. Append issue_watchdog_events in producer transactions;
never update shared watchdog rows while holding producer issue/document/run locks.
The existing scheduler consumes bounded event batches and saves deadlines atomically,
with ordered watchdog locks and restart reconstruction of unconsumed events.
Use the shared deadline scheduler, never a generic PM heartbeat or idle SQL polling.
Only persisted watchdog provenance permits a zero-slot PM coordination child; execute
it in PM home and preserve the original worker workspace. Continue requires current
project/worker authority, an idempotency key and observed task/run versions. Unknown
outcomes must inspect the original continuation receipt; a wake alone is not completion.
Project mains may continue their own project's existing worker tasks from the
original accepted Owner Chat input, using a current run credential, an unchanged
Owner-attributed handoff comment, idempotency key and explicit task/run observations.
An empty continue request grants nothing. Recheck current main/worker policy,
conversation generation, latest Owner input and task instructions at admission.
Recheck the original-main operation again before its first worker dispatch after
capacity waiting or restart. Status/assignment changes never settle unknown input,
provider effects or session ownership through generic stale-recovery cleanup.
Normal main completion retains only an already committed operation; it cannot
authorize another continuation. Preserve unknown delivery, human holds and original
task/run history; registration alone is never authority to resume work.
Formal review retains current stage, participant and policy bindings. Keep human gates,
manual holds and completed/cancelled work intact. Saved Recovery directory realization
and ownership govern reuse, even for a configured non-Git source.
Base validation uses the saved strategy only for a same-company/project/task
local Recovery copy with its server-owned copy-only receipt; source-free task
Retry validation stays intact. Keep current configuration separately for drift
diagnostics and fresh admission.
Environment selection carries the issue's projectId in its typed input and checks
that a saved workspace exists before comparing project/source ownership.
Exercise the assembled heartbeat path for project-bound non-Git Recovery reuse,
including preserved files, provider execution and task ownership rejection.
Retained task-directory anchors carry their source identity and local-path contract
through the final Claude/Codex launch guard; process-adapter tests alone cannot prove it.
