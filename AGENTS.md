# AGENTS.md

Guidance for human and AI contributors working in this repository.

## 1. Purpose

Paperclip is a control plane for AI-agent companies.
The current implementation target is V1 and is defined in `doc/SPEC-implementation.md`.

## 2. Read This First

Before making changes, read in this order:

1. `doc/GOAL.md`
2. `doc/PRODUCT.md`
3. `doc/SPEC-implementation.md`
4. `doc/DEVELOPING.md`
5. `doc/DATABASE.md`

`doc/SPEC.md` is long-horizon product context.
`doc/SPEC-implementation.md` is the concrete V1 build contract.

When adding or changing an Apps catalog connection, also follow
`doc/connections/CONNECTOR-PLAYBOOK.md`. It is the canonical connection
authoring runbook for provider research, supported transport/auth patterns,
credential handling, branding, implementation, testing, live proof, and PR
submission.

### Scoped repository rules

Before editing or reviewing files, read the matching rules in `rules/*.mdc`.
Each rule has Markdown content and YAML frontmatter: `globs` contains
comma-separated, repository-relative file patterns, and `alwaysApply: true`
means the rule applies throughout the repository. Read all rules whose scope
matches the affected files. These rules supplement this file and any applicable
nested `AGENTS.md` instructions.

For `server/src/services/chat-channels.ts` and everything under
`server/src/services/chat-channels/`, read
[`rules/chat-channel-platform-boundaries.mdc`](rules/chat-channel-platform-boundaries.mdc).
For `server/src/services/heartbeat.ts`, `server/src/services/heartbeat/`,
heartbeat-prefixed sibling services, and heartbeat regression tests, read
[`rules/heartbeat-execution-boundaries.mdc`](rules/heartbeat-execution-boundaries.mdc).
For ACPX provider profiles, their release attestations and pins, the provider-pack
contract registry, and ACPX driver and provider code under
`packages/paperclip-runner/`, read
[`rules/acpx-profile-identity.mdc`](rules/acpx-profile-identity.mdc).
See [`rules/README.md`](rules/README.md) for rule authoring and Greptile setup.

## 3. Repo Map

- `server/`: Express REST API and orchestration services
- `ui/`: React + Vite board UI
- `packages/db/`: Drizzle schema, migrations, DB clients
- `packages/shared/`: shared types, constants, validators, API path constants
- `packages/adapters/`: agent adapter implementations (Claude, Codex, Cursor, etc.)
- `packages/adapter-utils/`: shared adapter utilities
- `packages/plugins/`: plugin system packages
- `packages/skills-catalog/`: app-shipped skills catalog (`@paperclipai/skills-catalog`)
- `packages/teams-catalog/`: app-shipped teams catalog (`@paperclipai/teams-catalog`)
- `cli/`: `paperclipai` CLI package (published bin, agent-facing commands)
- `skills/`: Paperclip runtime/operational skills (not part of the app catalog)
- `doc/`: operational and product docs

## 4. Dev Setup (Auto DB)

Use embedded PGlite in dev by leaving `DATABASE_URL` unset.

```sh
pnpm install
pnpm dev
```

This starts:

- API: `http://localhost:3100`
- UI: `http://localhost:3100` (served by API server in dev middleware mode)

Quick checks:

```sh
curl http://localhost:3100/api/health
curl http://localhost:3100/api/companies
```

Reset local dev DB:

```sh
rm -rf data/pglite
pnpm dev
```

## 5. Core Engineering Rules

Web Push uses account-owned preferences/subscriptions and company-scoped delivery
receipts. Keep `/api/push` restricted to authenticated human sessions; local-board
and agent keys are not subscription identities. Producers must enqueue inside
their persistence transaction and use the existing delivery coordinator. Preserve
source-event/device idempotency, current task/decision authorization, fixed
coalescing windows and idle zero-polling. Never log endpoints, encryption keys or
notification content. See `doc/DEVELOPING.md` (Web Push) and `doc/DATABASE.md`.
Keep the human-only OpenAPI registrations aligned with shared push request
validators. Unrelated audit writes retain their existing caller transaction.
Keep PM worker-policy and project execution-record OpenAPI operations aligned
with mounted routes, shared policy validators and existing access controls.
Use owned disposable databases and dedicated test notifications; do not wake real
agents. Non-Git workspace tests require a clean owned temporary root with no
ancestor Git metadata. Chromium injection tests do not qualify APNs or physical iPhone delivery.
Database-backed scheduler tests must separate fake deadline advancement from
wall-time batch completion and join execution cleanup before fixture teardown.
Assert persisted absolute deadlines after I/O; never assume a fixed startup duration.
Isolate each test's database-client work-signal owner; truncation cannot clear
uncertain transaction notifications retained in memory after deliberate rollback.
Timing-only recovery fixtures retain real Drizzle query/locking composition;
event persistence, rollback and contention require owned PostgreSQL coverage.

1. Keep changes company-scoped.
Every domain entity should be scoped to a company and company boundaries must be enforced in routes/services.

Explicit exception: announcement dismissals are instance-wide user preferences,
keyed by user and announcement so they persist across companies. Their audit
context must still validate company membership. The announcement publication-ID
registry is instance-level feed metadata; it contains no company or user data.
Personal workspace presentation preferences are also instance-wide by user, with
validated company membership supplying audit context. They never grant execution
authority, change company capabilities or agent configuration, or rewrite canonical
work records. Optional conversation guidance must retain the same action permissions.
The Coordinator sidebar's Agents section includes the person's company-scoped
primary agent alongside `ceo` and `pm` roles and agents the person starred;
preserve lifecycle, service-account
and membership visibility restrictions regardless of primary selection or stars.
Pin the primary agent first and sort the remaining agents alphabetically.
Do not add a worker expansion control or change dispatch to implement this filter.

Project PM sidebar rows show a presentation-only status. CoordinatorSidebar and
both SidebarAgents variants use useProjectPmSidebarStatus; change all three in lockstep. Blue frame, `working` label and pulsing dot:
a readable running live run belongs to a task of the PM's project, subtasks included,
or is the PM's own run. Orange frame and `needs input`, which overrides blue: an
Owner-addressed `issue_thread_interaction`, `approval` or `decision` item of that
project is pending. Zero-slot PMs work through shared workers, so attribute through
`GET /companies/:id/pm-workspaces` and the live run's `projectId` (omitted on runs the
viewer cannot read), never `run.agentId`. In the Coordinator only, a listed agent that is
not a project PM (a project main agent; momo and personal agent rows unless the person
excluded them) shows blue `working` while its own readable run is working, by
`run.agentId` only: no project attribution, no `needs input`, no full attention read, and
the person's exclusion list must be loaded first. Classic SidebarAgents keeps its live dot
for such agents. Read the
complete attention snapshot (`attentionApi.list(..., { all: true })`), not the ranked
first page; `approval` attention items must carry their linked issue's `project`
(`issueContext`), and approvals the viewer cannot read stay excluded. Queued,
scheduled-retry, recovery and answer/access-wait runs are not
working; a `running` row whose cached projection still says `queued` has just started
(`heartbeat.run.status` patches only `status`). Known binding, viewer-preference and complete attention snapshots are required even
for blue. First loading is quiet; first failure shows no status and reports an error
through the nonoptional toast actions (company/source dedupe key and failure timestamp).
A failed refetch retains the loaded snapshots. Use coordinatorAttentionQueryKey for
the full feed, shared with Needs You/task attention pages and their invalidations,
with the existing 60-second cadence. Bound PM status is the explicit full-feed
navigation exception to upstream #18323; no bindings means no full-feed read. Keep
the count-only summary separate and live-run/shared-polling ownership in callers.
Do not restore the old Coordinator open-task query, chat inference or working ring.
The status never changes dispatch,
permissions, row order or agent configuration. Sidebar rows keep the neutral
`ring-ring` keyboard focus ring; do not restore the browser default outline.
A person may exclude PM agents from this status:
`company_user_sidebar_preferences.excluded_pm_status_agent_ids` is a jsonb agent-ID
array, default `[]` (every PM shows status), read and written by
`GET/PUT /companies/:companyId/sidebar-preferences/me` (`{ excludedPmStatusAgentIds }`)
under the existing board/membership checks. A PUT changes only the fields it sends, so
the project-reorder `orderedIds` PUT preserves the list. Both sidebar chains read the
same query; never hardcode agent names or production IDs in the repository, the person
saves verified IDs after deploy. An unreadable list is not an empty list: with no
loaded list claim no PM status and report the failure through the existing error toast;
a failed refetch keeps the list already loaded. The column is additive (`NOT NULL`
default `[]`) so the previous release still runs on the new schema.

Project PMs can be restricted to coordination and review with
`runtimeConfig.workspaceBinding.workerSlots=0` (the default for new bindings).
Reject implementation children assigned to such a PM before adapter dispatch,
including stale worker-role contexts; preserve execution-policy reviews in the PM
home with the PM's own model. A shared Claude or Codex worker may serve multiple
projects: use issue-scoped model settings and task sessions,
and route review to the issuing project's PM. Never resume an Owner replanning
hold when changing this topology or reuse another task's session/worktree.
Shared native workers set `runtimeConfig.requireProjectWorkspace=true`; reject missing
project tasks or unconfigured sources. A configured development directory is the default:
one writer owns its canonical path through provider stop and workspace settlement;
additional writers queue. Explicit parallel work or independent versions may select
`managed_isolated`. `requireTaskWorktree=true` remains an explicit isolated-only worker
restriction; only the Owner may change either flag. Existing runs keep their contract.
Fixed document/data directories do not require Git or automatic `git init`.
Ignore-only ancestor directories such as `~/.git/info/exclude` are not repositories;
local or ancestor repository metadata still requires authoritative Git validation.
Git metadata, explicit repository/ref settings and isolated worktrees still require
valid Git sources; damaged metadata must fail visibly. Shared claims use real paths
and reject overlapping parent/child directories as well as aliases. Serialize the
bounded admission transaction per host; independent admitted writers remain parallel.
Read-only PM source tools share files; fixed-version reads take a full commit SHA and
never switch the checkout. A provider with write capabilities always counts as a writer.
A production source (`metadata.usage=production`) needs a separate fixed development
checkout. Never silently fall back to a PM home or reuse another task's worktree.

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
New PM dispatch requires a same-project configured development source; default to
`shared`, serialize writers, and reject conflicting settings or existing-task worktrees
before task creation. Claims cover aliases and subdirectories of one physical checkout.
Silent/terminal runs are not release proof; retain unresolved provider/finalizer/lease
ownership. New owners cannot inherit unsaved files. Merged worktrees use the existing
terminal reaper: preserve results and history, verify clean files, stopped processes,
released leases/services and branch ancestry, then remove the directory and merged
branch without force. Keep the existing cooldown and failed-cleanup receipts. PM
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
Workspace-only issue PATCHes preserve status, assignment and pending review state;
maintenance cannot normalize a blocked task into review or wake its reviewer.
Owner-issued `project-pm-decision-authority` is separate from company delegation.
Its revision and explicit project list authorize current project PMs to decide
ordinary plans, one-shot Allow and approvals, including their own proposals when
allowed. It does not depend on momo or Dot, expand worker/model/budget access,
grant shell, approve hiring/budget overrides or override human/security gates.
PMs decide within scope directly; do not create unnecessary self-addressed questions.
Only the human Owner may grant or revoke this authority; never migrate old requests.
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
Review decisions require evidence-linked reasons and the current assigned review;
they grant no general approval authority. For execution-policy review stages, Runner
pins the assigned stage, policy/state hashes and status version before advertising
`resolve_review`. Its receipt records a pending decision without releasing the
reviewer's execution lock. Only successful run/workspace finalization may commit
that decision, audit/comment and the original task's next wake atomically. Recheck
the saved scope under row locks; preserve later human stages and independent
approval cards. Generic status PATCH and board-only stalled-review APIs remain
unavailable to PMs. During an execution-policy review, generic HTTP mutations
are also denied; hiding create_task from the tool catalog alone is insufficient.
If shutdown failure released the review lock, only the finalizer may settle its
saved decision after workspace repair. Require the original failed assessment,
unchanged stage/version/assignment, actual stop evidence, released leases, no
successor run and no task/agent pause. Recheck in the commit transaction; never
grant lock-free tool authority or rerun the provider to recover a saved decision.
Completion-review interactions keep their existing route. Formal delegated approval
POSTs require a current assigned request revision, an evidence-linked decision note
and the independent Owner grant; generic API access never bypasses those checks.
Company decision delegation remains a separate
human-Owner-managed permission grant. Outside an independently authorized project,
new worker questions route through their task project's PM; PM questions route to the company delegate via
`request_human_input`, not by adding the delegate to the worker catalog. Omit
`resolverPolicy` for ordinary delegated questions; explicit human gates stay human.
Use the assigned request's current revision with the controlled resolve/escalate
tools. Preserve worker checkout and the original provider callback. Never replay
old pending cards or revive cancelled work when enabling delegation. Only the
granting human may change the grant or resolve a human-reserved request; Markdown
and an agent's risk label cannot widen it. Record agent decisions as agents with
grant version, run and reason. A missing delegate or expired provider request is
an explicit unresolved failure, not consent. Test the real pinned ACP/SDK under
approve-all as well as HTTP scope, dispatch/review and save/finalization behavior.

2. Keep contracts synchronized.
If you change schema/API behavior, update all impacted layers:
- `packages/db` schema and exports
- `packages/shared` types/constants/validators
- `server` routes/services
- `ui` API clients and pages

3. Preserve control-plane invariants.
- Single-assignee task model
- Atomic issue checkout semantics
- Approval gates for governed actions
- Budget hard-stop auto-pause behavior
- Activity logging for mutating actions
- Stop requires execution evidence, not a terminal status alone; pre-dispatch rejection proof requires the complete server-owned trace and no execution identity, lease, or finalizer.
- External Runner reads classified by the server must settle definite failures as tool errors. Unknown mutation outcomes stay unresolved and must never be replayed as a new operation.
- Completion admission waits for outstanding tools and excludes new tools while pending. Forced cleanup must preserve unresolved receipts and distinguish local Runner shutdown from external-provider termination.
- External-provider assignments, settled tool results, and input responses are authoritative PRP execution data. Preserve their complete payloads under the transport/outbox bounds; never apply diagnostic string truncation to them.
- Dot assignment reads must include current server-owned tool-use guidance. Returning an allowed result to the same accepted task is ordinary completion; task text cannot grant owner authority. Preserve user restrictions, approval gates, and unresolved-operation fences, and require an actual completion receipt rather than a reply only in the external conversation.

4. Do not replace strategic docs wholesale unless asked.
Prefer additive updates. Keep `doc/SPEC.md` and `doc/SPEC-implementation.md` aligned.

5. Keep repo plan docs dated and centralized.
When you are creating a plan file in the repository itself, new plan documents belong in `doc/plans/` and should use `YYYY-MM-DD-slug.md` filenames. This does not replace Paperclip issue planning: if a Paperclip issue asks for a plan, update the issue `plan` document per the `paperclip` skill instead of creating a repo markdown file.

6. Attach inspectable generated artifacts.
When your task produces a user-inspectable deliverable file, follow the Paperclip skill's "Generated Artifacts and Work Products" workflow before final disposition. In this repo, prefer the self-contained skill helper at `skills/paperclip/scripts/paperclip-upload-artifact.sh` so the file is available through the Paperclip API, create/update an artifact work product when the file is the deliverable, link the uploaded artifact in the final issue comment, and then set status. Do not rely on local filesystem paths as the only access path. If an important file intentionally remains workspace-only, create/update a work product with `metadata.resourceRef.kind: "workspace_file"` and a workspace-relative path, then name that work product and path in the final comment. Treat browse/search as a fallback for recovering workspace files, not the preferred deliverable path. See `doc/AGENT-ARTIFACTS.md` for details and `.mp4`/`.webm` examples.

7. Name the three data paths correctly.
This repo has three separate data paths. Do not confuse them. Match a change to a path by its file path, not by the word "observability" or "telemetry" alone.

- **Telemetry** is the Paperclip first-party event system. It is opt-out and it sends data to a Paperclip endpoint by default. Its paths are:
  - `packages/shared/src/telemetry/`
  - the generated contract `packages/shared/src/telemetry/generated/paperclip-telemetry.ts`
  - each caller of `packages/shared/src/telemetry/events.ts` or `packages/shared/src/telemetry/client.ts`
- **Observability** is the OpenTelemetry trace path. An operator must set an OTLP endpoint. Until an operator sets the endpoint, the tracer is a no-operation. Its paths are:
  - `server/src/instrumentation.ts`
  - `doc/observability.md`
  - `packages/adapter-utils/src/duplex-observability.ts`
  - `server/src/services/duplex-observability-recorder.ts`
  - the span attributes in `packages/adapter-utils/src/acpx-engine/startup-timing.ts`
- **The run log** holds rows in the local `heartbeat_run_events` table. The data stays in the instance database. Its paths are:
  - `doc/run-log-events.md`
  - `packages/db/src/schema/heartbeat_run_events.ts`
  - the append path `appendRunEvent` in `server/src/services/heartbeat.ts`

Apply a review level that matches the path:

- **Telemetry change (strict review).** The author updates the generated contract first. The author updates `packages/shared/src/telemetry/README.md` in the same pull request. The author requests a privacy review. Reason: a Telemetry event goes to a Paperclip endpoint by default, so a mistake sends data immediately.
- **Observability change (lighter review).** The operator endpoint gate stays in place. The no-operation behaviour stays when no endpoint is set. A privacy review is not necessary while the change stays inside the closed span-attribute allowlist.
- **Run-log change (no extra review).** A run-log change needs neither review level above, because the data stays in the instance database.

**Exclusion.** The word "observability" in a file such as `server/src/services/recovery-observability.ts` names a different concept. Apply this rule by path, not by word match.

## 6. Database Change Workflow

When changing data model:

1. Edit `packages/db/src/schema/*.ts`
2. Ensure new tables are exported from `packages/db/src/schema/index.ts`
3. Generate migration:

```sh
pnpm db:generate
```

4. Validate compile:

```sh
pnpm -r typecheck
```

Notes:
- `packages/db/drizzle.config.ts` reads compiled schema from `dist/schema/*.js`
- `pnpm db:generate` compiles `packages/db` first

## 7. Verification Before Hand-off

[maps/feature-map/README.md](maps/feature-map/README.md) is an optional reference for user
entry points, verification recipes, and coverage gaps. The map records coverage
scope, not proof that a live journey passed.

The sibling [agent access map](maps/agent-access-map/README.md) records APIs,
agent entry points and permission boundaries using the same capability IDs.
Follow [the feature-map scope rule](rules/feature-map-scope.mdc): additions require
substantial new features. Routine fixes, polish, refactors, and test changes do
not require map updates. Follow [the map contract](maps/README.md) for minimal
corrections when existing entries become materially inaccurate, and run
`node scripts/check-maps.mjs` after map edits.
Its structural checks do not prove live behavior or authorization.

Storybook has a downstream [feature catalog](maps/storybook-map/README.md).
Use `maintain-storybook` for story/fixture drift and `review-storybook` for browser
evidence. Keep the feature-map skills independent of this catalog. After story or recipe changes, update the affected source annotations or
recipe and run `node scripts/storybook-catalog.mjs`. Indexes are generated and
ignored; never commit aggregate catalogs, refresh review fingerprints, or append
a shared review journal. Use Git diffs and keep review evidence in the PR or issue.
Structural checks are not production acceptance.

Default local/agent test path:

```sh
pnpm test
```

This is the cheap default and only runs the Vitest suite. Browser suites stay opt-in:

```sh
pnpm test:e2e
pnpm test:release-smoke
```

Run the browser suites only when your change touches them or when you are explicitly verifying CI/release flows.

For normal issue work, run the smallest relevant verification first. Do not default to repo-wide typecheck/build/test on every heartbeat when a narrower check is enough to prove the change.

Owner policy for this fork (2026-11-07): never run the full test suite, including
at hand-off, deployment, recovery or as a selector fallback. Run only tests related
to the change. Use the managed `fork-checks.py --since-release <previous release>`
workflow; unsupported selection stops explicitly. If a selection expands to
essentially the whole suite, narrow it and record the file-level rationale before
execution. Keep build integrity, database backup/history and service readiness
checks. See `/home/michael/services/README.md` for the deployment contract.

If memory is limited, use `node scripts/typecheck-low-memory.mjs` instead of `pnpm -r typecheck`. See `doc/DEVELOPING.md`.

If anything cannot be run, explicitly report what was not run and why.

## 8. API and Auth Expectations

Host subscription quotas are an explicit operator feature, enabled only with
PAPERCLIP_HOST_SUBSCRIPTION_QUOTAS=1. The dashboard endpoint requires instance
admin and existing company access before any host login is read. Keep these
snapshots separate from company-managed AI connections and billing.
Select hosts/providers from that company's non-terminated agents
through adapter-owned getSubscriptionQuotas. Keep separate host/provider cards,
never fall back to this server's login for a remote host, and retain capture times
and explicit unreported quota. Poll only
while the Dashboard is visible, cache for 60 seconds, track provider work through
maintenance admission, and preserve unknown values and provider failures. Codex
window labels derive from durations, never primary/secondary position.
Codex Business individualLimit is an independent allocation, valid without
primary/secondary windows. Preserve its reported percentage/reset and quota units;
never label those units as dollars or infer an absent percentage. Subscription
bar fill, percentage labels and accessible values all show remaining quota; warning
colors still reflect depletion. Other spending bars retain consumption semantics.
Antigravity shows only its reported quota groups; never infer Gemini quota or enable credits.
See doc/DEVELOPING.md, Host subscription quota dashboard.

- Base path: `/api`
- Board access is treated as full-control operator context
- Agent access uses bearer API keys (`agent_api_keys`), hashed at rest
- Agent keys must not access other companies

When adding endpoints:

- apply company access checks
- enforce actor permissions (board vs agent)
- write activity log entries for mutations
- return consistent HTTP errors (`400/401/403/404/409/422/500`)

## 9. UI Expectations

PDF attachment opens use the shared PdfPreviewProvider under BrowserRouter.
Its local-state dialog keeps Back, Open original and Download visible without
changing task history, location state or scroll; a route change closes it.
System/browser Back keeps its normal navigation behavior. Intercept only plain,
unprevented primary clicks on same-origin attachment/asset content routes.
Validate the authenticated response (200, PDF MIME/header, bounded 32 MiB stream)
before embedding a PDF blob; abort/revoke on close. Download stays a separate
action. Preserve text tabs, media viewers and native modifier-click behavior.
Browser viewport tests do not qualify physical iPhone/Android PDF rendering.

- Keep routes and nav aligned with available API surface
- Use company selection context for company-scoped pages
- Surface failures clearly; do not silently ignore API errors
- Form and wizard footers: keep Save & exit (or Cancel/Back) left and the primary action right in the same vertically aligned row. Each step owns the entire footer; never append Save & exit as a separate row. See `DESIGN.md`.

## 10. Pull Request Requirements

When creating a pull request (via `gh pr create` or any other method), you **must** read and fill in every section of [`.github/PULL_REQUEST_TEMPLATE.md`](.github/PULL_REQUEST_TEMPLATE.md). Do not craft ad-hoc PR bodies — use the template as the structure for your PR description. Required sections:

- **Thinking Path** — trace reasoning from project context to this change (see `CONTRIBUTING.md` for examples)
- **What Changed** — bullet list of concrete changes
- **Verification** — how a reviewer can confirm it works
- **Risks** — what could go wrong
- **Model Used** — the AI model that produced or assisted with the change (provider, exact model ID, context window, capabilities). Write "None — human-authored" if no AI was used.
- **Checklist** — all items checked

## 11. Definition of Done

A change is done when all are true:

1. Behavior matches `doc/SPEC-implementation.md`
2. Typecheck, tests, and build pass
3. Contracts are synced across db/shared/server/ui
4. Docs updated when behavior or commands change
5. PR description follows the [PR template](.github/PULL_REQUEST_TEMPLATE.md) with all sections filled in (including Model Used)

## Design system

`DESIGN.md` at the repo root is the source of truth for UI design decisions. The token-only rule applies to all `ui/` changes: every color, spacing, radius, type, shadow, and motion value in `ui/src/components/**` and `ui/src/pages/**` comes from the token layer in `ui/src/index.css` — no hex, raw px, arbitrary Tailwind bracket values, or raw `font-size`/`fontSize` declarations in components, outside the documented allowlist in `ui/src/index.css`. Run `pnpm check:token-gates` (`scripts/check-token-gates.mjs`) before committing UI changes — it fails on any violation not covered by that allowlist.

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

Native execution-review recovery and explicit Owner wakes bind the current locked
issue stage even without an old executionStage envelope. Require the same active
run/assignee, pending review stage and policy; never infer authority from a prior
run or caller payload, and never reopen blocked tasks during binding.

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
Delivery guidance must match the actual runtime: native tools for Runner, authenticated Paperclip skill
and task APIs for legacy adapters. Never require a native-only tool in a legacy run.

## Native session bridge

Live work cards render runtime identity only from the run's model_identity activity or the child's
own delegation payload. Preserve harness, raw model/provider, billing route and unavailable metadata;
never use the current agent config or parent model to label a historical run or native child.
See doc/DEVELOPING.md (Main-agent live work cards).

Codex main-agent Chats using ccpocket_bridge supplement the exact active turn
through adapter chatSteering and Bridge paperclip_codex_steer_v1. Persist the
queued-comment reservation before provider I/O, preserve original run/result
correlation, and remove only acknowledged IDs from the latest queue. Uncertain
delivery blocks queue mutation and promotion until its original durable receipt
settles; never interrupt, replay, start an idle turn or resend it automatically.
Other harnesses retain Chat interrupt behavior; ordinary task queues are unchanged.
Attachments and interaction responses retain their normal turn boundaries.

Chat presentation uses the shared IssueComment origin type so native inbox and
mirrored messages retain their provenance through the UI adapter.

The Shopee-D pilot uses the explicit runtimeConfig.sessionBridge binding; Bridge
owns the pinned native session. New chat comments use a durable receipt inbox and
must never fall back to a heartbeat on disconnect or replay historical comments.
Keep native MCP scope, worker selection/workspace validation and the configured
connector gateway separate. session_bridge keys may invoke assigned connectors
only with allowAssignedTools; they cannot manage connections or fabricate runs.
The connector HTTP boundary preserves ToolGatewayHttpError status, reasonCode and
public details (including approval and dispatch receipts); unknown errors stay
redacted. Never replace an upstream failure with success or automatically replay it.
Retain uncertain provider sends without automatic replay. Update the canonical
contract in doc/plans/2026-11-10-session-bridge-key-scope.md with protocol changes.

Session-bridge-only MCP definitions live in packages/mcp-server/src/session-bridge-tools.ts;
keep them separate from the Runner legacy MCP catalog in tools.ts. Regenerate the
Runner capability source anchors when legacy definitions move, and verify both
catalog surfaces without granting session-only tools to heartbeat clients.
